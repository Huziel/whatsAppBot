import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DateTime } from 'luxon'
import { isIndividualJid, messageDedupKey, resolveIdentity } from '../src/identity'
import { isMessageAtOrAfterStart, isNonContentProtocolType, normalizeMessage, shouldAutoReply, timestampDate } from '../src/message'
import { PersistentQueue } from '../src/queue'
import { validateContactProfile, validateInventoryItem, validateSettings } from '../src/config-ui'
import { detectCatalogRequest, detectPaymentRequest, generateDeepSeekResponse } from '../src/deepseek'
import { resolveAppointmentStart } from '../src/appointment-time'
import { decryptAppSettings, encryptAppSettings } from '../src/settings-crypto'
import { PerContactRateLimiter } from '../src/rate-limit'
import { ConversationEntry, mergeConversationTurns, RecentConversationMemory } from '../src/conversation'
import { getSettings, setSettings, subscribeSettings, updateSettingsDraft } from '../web/js/state.mjs'

test('la clave de deduplicación distingue direction y chat, y es estable', () => {
  assert.equal(messageDedupKey(9, 'ABCD', false), messageDedupKey(9, 'ABCD', false))
  assert.notEqual(messageDedupKey(9, 'ABCD', false), messageDedupKey(9, 'ABCD', true))
  assert.notEqual(messageDedupKey(9, 'ABCD', false), messageDedupKey(10, 'ABCD', false))
})

test('un LID conserva su identificador y nunca se interpreta como teléfono', () => {
  const unresolved = resolveIdentity({ jid: '987654321098765@lid' })
  assert.equal(unresolved.phoneNumber, null)
  assert.equal(unresolved.status, 'unresolved')
  assert.deepEqual(unresolved.identifiers, [{ jid: '987654321098765@lid', type: 'lid' }])
})

test('resuelve posteriormente LID-PN solo al recibir el JID telefónico asociado', () => {
  const identity = resolveIdentity({ lid: 'some-lid@lid', phoneJid: '5215512345678@s.whatsapp.net' })
  assert.equal(identity.phoneNumber, '5215512345678')
  assert.equal(identity.status, 'resolved')
  assert.deepEqual(identity.identifiers.map(item => item.type), ['pn', 'lid'])
})

test('extrae texto, captions y contenido envuelto', () => {
  assert.equal(normalizeMessage({ message: { conversation: 'hola' } }).text, 'hola')
  assert.equal(normalizeMessage({ message: { imageMessage: { caption: 'caption' } } }).text, 'caption')
  assert.equal(normalizeMessage({ message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'envuelto' } } } } }).text, 'envuelto')
})

test('acepta conversaciones individuales y excluye grupos, estados y broadcasts', () => {
  assert.equal(isIndividualJid('5215550000000@s.whatsapp.net'), true)
  assert.equal(isIndividualJid('some-lid@lid'), true)
  assert.equal(isIndividualJid('123-456@g.us'), false)
  assert.equal(isIndividualJid('status@broadcast'), false)
  assert.equal(isIndividualJid('123@broadcast'), false)
})

test('convierte timestamps Unix en milisegundos', () => {
  assert.equal(timestampDate(1_700_000_000).toISOString(), '2023-11-14T22:13:20.000Z')
  assert.equal(timestampDate({ toNumber: () => 1_700_000_001 }).toISOString(), '2023-11-14T22:13:21.000Z')
})

test('solo considera archivable un mensaje cuya marca temporal alcanza el inicio del servicio',()=>{
  assert.equal(isMessageAtOrAfterStart(1_700_000_000,1_700_000_001),false)
  assert.equal(isMessageAtOrAfterStart(1_700_000_001,1_700_000_001),true)
})

test('auto respuesta acepta eventos entrantes nuevos notify y append', () => {
  const incoming = { key: { id: 'm1', remoteJid: '5215550000000@s.whatsapp.net', fromMe: false }, messageTimestamp: 1_700_000_001, message: { conversation: 'hola' } }
  assert.equal(shouldAutoReply(incoming, 'notify', 1_700_000_000), true)
  assert.equal(shouldAutoReply(incoming, 'append', 1_700_000_000), true)
  assert.equal(shouldAutoReply(incoming, 'history', 1_700_000_000), false)
  assert.equal(shouldAutoReply(incoming, 'append', 1_700_000_002), false)
  assert.equal(shouldAutoReply(incoming, 'notify', 1_700_000_002), false)
  assert.equal(shouldAutoReply({ ...incoming, key: { ...incoming.key, fromMe: true } }, 'notify', 1_700_000_000), false)
  assert.equal(shouldAutoReply({ ...incoming, key: { ...incoming.key, remoteJid: '123@g.us' } }, 'notify', 1_700_000_000), false)
})

test('configuración rechaza pausas menores a 1500 ms', () => {
  const settings = { autoReply: true, responseText: 'HOLA SOY EL BOT', replyDelayMs: 1500, saveToDatabase: true }
  assert.equal(validateSettings(settings).replyDelayMs, 1500)
  assert.throws(() => validateSettings({ ...settings, replyDelayMs: 1499 }), /1500 y 60000/)
  assert.equal(validateSettings({ ...settings, productCatalogImageUrl: 'https://example.com/products.png' }).productCatalogImageUrl, 'https://example.com/products.png')
  assert.throws(() => validateSettings({ ...settings, serviceCatalogImageUrl: 'http://example.com/services.png' }), /HTTPS/)
})

test('DeepSeek requiere key al activarse y conserva una key guardada si el campo llega vacío', () => {
  const settings = { autoReply: true, responseMode: 'deepseek', responseText: 'HOLA SOY EL BOT', replyDelayMs: 1500, saveToDatabase: true, deepseekModel: 'deepseek-flash', deepseekApiKey: '' }
  assert.throws(() => validateSettings(settings), /API key de DeepSeek/)
  assert.equal(validateSettings(settings, 'local-test-key').deepseekApiKey, 'local-test-key')
  assert.equal(validateSettings({ ...settings, deepseekApiKey: 'new-key' }).deepseekApiKey, 'new-key')
})

test('DeepSeek reporta el finish_reason cuando la API devuelve contenido vacío', async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'insufficient_system_resource', message: { content: null } }] }), { status: 200 })) as typeof fetch
  await assert.rejects(generateDeepSeekResponse('test-key', 'deepseek-flash', 'mensaje', [], [], false, undefined, [], '', fakeFetch), /plain_retry_insufficient_system_resource/)
})

test('DeepSeek reintenta una respuesta vacía con contexto reducido', async () => {
  let calls = 0
  const fakeFetch = (async () => {
    calls++
    const content = calls === 1 ? null : JSON.stringify({ reply: 'Respuesta recuperada', product_skus: [], catalog_request: null, cart_action: 'none', cart_items: [], payment_request: false, appointment_action: 'none', appointment_start: null, appointment_service: null })
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200 })
  }) as typeof fetch
  const result = await generateDeepSeekResponse('test-key', 'deepseek-flash', 'mensaje', [], [], false, undefined, [{ role: 'user', content: 'turno sintético' }], '', fakeFetch)
  assert.equal(calls, 2)
  assert.equal(result.text, 'Respuesta recuperada')
})

test('DeepSeek responde en modo texto si también falla la salida JSON estructurada', async () => {
  let calls = 0
  const fakeFetch = (async () => {
    calls++
    const content = calls < 3 ? null : 'Respuesta breve recuperada'
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200 })
  }) as typeof fetch
  const result = await generateDeepSeekResponse('test-key', 'deepseek-flash', 'hola', [], [], false, undefined, [], '', fakeFetch)
  assert.equal(calls, 3)
  assert.equal(result.text, 'Respuesta breve recuperada')
  assert.equal(result.cartAction, 'none')
})

test('DeepSeek usa chat completions y devuelve únicamente el texto generado', async () => {
  let captured: any
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init, body: JSON.parse(String(init?.body)) }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: '  Respuesta breve  ', product_skus: ['CAF-1', 'SKU-FALSO'], catalog_request: null, cart_action: 'add', cart_items: [{ sku: 'CAF-1', quantity: 2 }, { sku: 'SKU-FALSO', quantity: 1 }], payment_request: true, appointment_action: 'book', appointment_start: '2026-10-06T11:00', appointment_service: 'Asesoría' }) } }] }), { status: 200 })
  }) as typeof fetch
  const inventory = [{ id: 1, itemType: 'product', sku: 'CAF-1', name: 'Café', description: 'Molido', price: '100.00', currency: 'MXN', stockQuantity: 4, isActive: true }]
  const cart = [{ sku: 'CAF-1', itemType: 'product' as const, itemName: 'Café', quantity: 1, unitPrice: '100.00', currency: 'MXN' }]
  const schedule = { enabled: true, timeZone: 'America/Mexico_City', days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00', durationMinutes: 60, nowLocal: '2026-10-05T10:00' }
  const conversation = [{ role: 'user' as const, content: '¿Tienes café?' }, { role: 'assistant' as const, content: 'Sí, tenemos café.' }]
  const result = await generateDeepSeekResponse('secret-test-key', 'deepseek-flash', 'Agrega otro café', inventory as any, cart, true, schedule, conversation, 'Ofrece café molido', fakeFetch)
  assert.equal(result.text, 'Respuesta breve')
  assert.deepEqual(result.productSkus, ['CAF-1'])
  assert.equal(result.catalogRequest, null)
  assert.equal(result.cartAction, 'add')
  assert.deepEqual(result.cartItems, [{ sku: 'CAF-1', quantity: 2 }])
  assert.equal(result.paymentRequest, true)
  assert.equal(result.appointmentAction, 'book')
  assert.equal(result.appointmentStart, '2026-10-06T11:00')
  assert.equal(result.appointmentService, 'Asesoría')
  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions')
  assert.equal(captured.init.headers.authorization, 'Bearer secret-test-key')
  assert.deepEqual(captured.body.messages.slice(-3), [
    { role: 'user', content: '¿Tienes café?' },
    { role: 'assistant', content: 'Sí, tenemos café.' },
    { role: 'user', content: 'Agrega otro café' },
  ])
  assert.match(captured.body.messages[0].content, /CAF-1/)
  assert.match(captured.body.messages[0].content, /Carrito actual/)
  assert.deepEqual(captured.body.response_format, { type: 'json_object' })
  assert.match(captured.body.messages[0].content, /transferencia está habilitada \(true\)/)
  assert.match(captured.body.messages[0].content, /appointments_enabled=true/)
  assert.ok(captured.body.messages.some((message: any) => message.content.includes('Ofrece café molido')))
  assert.equal(captured.body.stream, false)
})

test('detecta solicitudes explícitas de catálogo completo en español', () => {
  assert.equal(detectCatalogRequest('¿Me muestras todos los productos?'), 'products')
  assert.equal(detectCatalogRequest('¿Qué productos tienes?'), 'products')
  assert.equal(detectCatalogRequest('Muéstrame tus productos'), 'products')
  assert.equal(detectCatalogRequest('Quiero el catálogo completo de servicios'), 'services')
  assert.equal(detectCatalogRequest('¿Tienes servicios?'), 'services')
  assert.equal(detectCatalogRequest('¿Qué servicios ofrecen?'), 'services')
  assert.equal(detectCatalogRequest('¿Venden productos?'), 'products')
  assert.equal(detectCatalogRequest('Muéstrame productos y servicios'), 'both')
  assert.equal(detectCatalogRequest('¿Cuánto cuesta el termo?'), null)
})

test('el contexto de conversación ordena, deduplica y excluye el mensaje actual', () => {
  const memory = new RecentConversationMemory(5, 10)
  memory.remember('chat-A', { id: 'm1', role: 'user', content: 'Pregunta', timestampMs: 1 })
  memory.remember('chat-A', { id: 'm2', role: 'assistant', content: 'Respuesta inicial', timestampMs: 2 })
  memory.remember('chat-A', { id: 'm2', role: 'assistant', content: 'Respuesta editada', timestampMs: 3 })
  memory.remember('chat-B', { id: 'other', role: 'user', content: 'Otro chat', timestampMs: 4 })
  const db: ConversationEntry[] = [{ id: 'm1', role: 'user', content: 'Pregunta', timestampMs: 1 }]
  assert.deepEqual(mergeConversationTurns(db, memory.get('chat-A'), 'current'), [
    { role: 'user', content: 'Pregunta' },
    { role: 'assistant', content: 'Respuesta editada' },
  ])
  assert.deepEqual(mergeConversationTurns(db, memory.get('chat-A'), 'm1'), [{ role: 'assistant', content: 'Respuesta editada' }])
})

test('detecta preguntas de pago/transferencia', () => {
  assert.equal(detectPaymentRequest('¿Cómo puedo pagar?'), true)
  assert.equal(detectPaymentRequest('¿Aceptan transferencia?'), true)
  assert.equal(detectPaymentRequest('Quiero el termo'), false)
})

test('transferencia bancaria requiere titular, banco y CLABE o cuenta', () => {
  const base = { autoReply: true, responseMode: 'fixed', responseText: 'Hola', replyDelayMs: 1500, saveToDatabase: true, transferEnabled: true, transferBankName: 'Banco demo', transferAccountHolder: 'Comercio demo', transferAccountNumber: '', transferClabe: '012345678901234567', transferInstructions: '' }
  assert.equal(validateSettings(base).transferEnabled, true)
  assert.throws(() => validateSettings({ ...base, transferClabe: '123' }), /18 dígitos/)
  assert.throws(() => validateSettings({ ...base, transferClabe: '', transferAccountNumber: '' }), /banco, titular y CLABE/)
})

test('citas valida zona horaria, días, anticipación y horario laboral', () => {
  const schedule = { timeZone: 'America/Mexico_City', days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00', durationMinutes: 60 }
  const now = DateTime.fromISO('2026-10-05T10:00', { zone: schedule.timeZone })
  const valid = resolveAppointmentStart('2026-10-06T11:00', schedule, now)
  assert.equal(valid.toFormat("yyyy-MM-dd'T'HH:mm"), '2026-10-06T11:00')
  assert.throws(() => resolveAppointmentStart('2026-10-06T18:00', schedule, now), /fuera del horario/)
  assert.throws(() => resolveAppointmentStart('2026-10-10T10:00', schedule, now), /no ofrece citas/)
  assert.throws(() => resolveAppointmentStart('2026-10-06T10:30', schedule, now), /intervalos/)
})

test('configuración de citas requiere DeepSeek al activar el autoresponder', () => {
  const settings = { autoReply: true, responseMode: 'deepseek', responseText: 'Hola', replyDelayMs: 1500, saveToDatabase: true, deepseekApiKey: 'test', appointmentsEnabled: true, appointmentTimeZone: 'America/Mexico_City', appointmentDays: [1, 2, 3, 4, 5], appointmentStartTime: '09:00', appointmentEndTime: '17:00', appointmentDurationMinutes: 60 }
  assert.equal(validateSettings(settings).appointmentsEnabled, true)
  assert.throws(() => validateSettings({ ...settings, responseMode: 'fixed' }), /selecciona DeepSeek/)
  assert.throws(() => validateSettings({ ...settings, appointmentTimeZone: 'Invalid/Zone' }), /zona horaria/)
})

test('valida instrucciones, límite por contacto y retención de mensajes', () => {
  const settings = { autoReply: true, responseMode: 'deepseek', responseText: 'Hola', replyDelayMs: 1500, saveToDatabase: true, deepseekApiKey: 'test-key', aiSystemInstructions: 'Responde formalmente', maxRepliesPerHour: 12, messageRetentionDays: 30 }
  const valid = validateSettings(settings)
  assert.equal(valid.aiSystemInstructions, 'Responde formalmente')
  assert.equal(valid.maxRepliesPerHour, 12)
  assert.equal(valid.messageRetentionDays, 30)
  assert.throws(() => validateSettings({ ...settings, maxRepliesPerHour: 0 }), /1 y 200/)
  assert.throws(() => validateSettings({ ...settings, messageRetentionDays: 4000 }), /retención/)
  const identity = validateSettings({ ...settings, botName: 'Nora', businessName: 'Café Demo' })
  assert.equal(identity.botName, 'Nora')
  assert.equal(identity.businessName, 'Café Demo')
  const style = validateSettings({ ...settings, aiTone: 'friendly', aiResponseLength: 'detailed' })
  assert.equal(style.aiTone, 'friendly')
  assert.equal(style.aiResponseLength, 'detailed')
  assert.throws(() => validateSettings({ ...settings, aiTone: 'aggressive' }), /Tono de IA/)
})

test('secretos de configuración se cifran y descifran localmente', () => {
  const settings = { deepseekApiKey: 'deepseek-secret', transferClabe: '012345678901234567', transferAccountHolder: 'Titular de prueba', transferAccountNumber: '12345678', transferInstructions: 'Referencia' }
  const encrypted = encryptAppSettings(settings)
  assert.notEqual(encrypted.deepseekApiKey, settings.deepseekApiKey)
  assert.notEqual(encrypted.transferClabe, settings.transferClabe)
  assert.deepEqual(decryptAppSettings(encrypted), settings)
})

test('el límite de respuestas es independiente por contacto y se renueva por hora', () => {
  const limiter = new PerContactRateLimiter()
  assert.equal(limiter.consume('contact-A', 2, 1_000), true)
  assert.equal(limiter.consume('contact-A', 2, 2_000), true)
  assert.equal(limiter.consume('contact-A', 2, 3_000), false)
  assert.equal(limiter.consume('contact-B', 2, 3_000), true)
  assert.equal(limiter.consume('contact-A', 2, 3_601_001), true)
})

test('estado compartido del dashboard conserva ajustes de otras secciones', () => {
  setSettings({ botName: 'Bot A', businessName: 'Negocio A', transferClabe: '012345678901234567', appointmentTimeZone: 'America/Mexico_City', aiTone: 'professional' })
  updateSettingsDraft({ aiTone: 'friendly' })
  let notified: any
  const unsubscribe = subscribeSettings((settings, dirty) => { notified = { settings, dirty } })
  updateSettingsDraft({ appointmentTimeZone: 'UTC' })
  unsubscribe()
  assert.equal(getSettings()?.botName, 'Bot A')
  assert.equal(getSettings()?.transferClabe, '012345678901234567')
  assert.equal(notified.settings.aiTone, 'friendly')
  assert.equal(notified.settings.appointmentTimeZone, 'UTC')
  assert.equal(notified.dirty, true)
})

test('dashboard conserva destinos de navegación y campos opcionales accesibles', async () => {
  const html = await fs.readFile(path.resolve('web/index.html'), 'utf8')
  const conversations = await fs.readFile(path.resolve('web/js/views/conversations.js'), 'utf8')
  const routes = [...html.matchAll(/data-route="([^"]+)"/g)].map(match => match[1])
  assert.ok(routes.includes('dashboard') && routes.includes('conversations') && routes.includes('privacy'))
  for (const route of new Set(routes)) assert.match(html, new RegExp(`id="view-${route}"`))
  assert.match(html, /id="view-ai" data-view="ai" class="page-view hidden/)
  assert.match(html, /id="view-privacy" data-view="privacy" class="page-view hidden/)
  assert.match(html, /id="clearDeepseekApiKey" type="checkbox"/)
  assert.match(html, /id="serviceForm"/)
  assert.match(html, /id="serviceImageUrl"[^>]*type="url"/)
  assert.match(html, /id="serviceImagePreview"/)
  assert.match(html,/id="clearConversations"/)
  assert.match(conversations,/toggleChatPause\(chat\)/)
  assert.match(conversations,/Reanudar IA/)
  assert.match(conversations,/Pausar IA/)
  assert.match(html, /aria-label="Abrir navegación"/)
})

test('valida inventario y fuerza existencias nulas en servicios', () => {
  const input = { itemType: 'service', sku: 'INST-01', name: 'Instalación', description: '', price: '250', currency: 'mxn', stockQuantity: 15, isActive: true }
  const item = validateInventoryItem(input)
  assert.equal(item.stockQuantity, null)
  assert.equal(item.currency, 'MXN')
  assert.equal(item.price, '250.00')
  assert.equal(item.imageUrl, null)
  assert.throws(() => validateInventoryItem({ ...input, sku: 'bad sku' }), /código/i)
  assert.equal(validateInventoryItem({ ...input, imageUrl: 'https://example.com/image.png' }).imageUrl, 'https://example.com/image.png')
  assert.throws(() => validateInventoryItem({ ...input, imageUrl: 'http://example.com/image.png' }), /HTTPS/)
})

test('valida nombre, etiquetas y notas de perfil de contacto', () => {
  assert.deepEqual(validateContactProfile({ customName: '  Ana  ', tags: ' VIP, Nuevo ', notes: ' Cliente de prueba ' }), { customName: 'Ana', tags: 'VIP, Nuevo', notes: 'Cliente de prueba' })
  assert.throws(() => validateContactProfile({ notes: 'x'.repeat(4001) }), /exceden el límite/)
})

test('una notificación revoke se identifica para retirar el contenido', () => {
  const result = normalizeMessage({ message: { protocolMessage: { type: 0 } } })
  assert.equal(result.deleted, true)
  assert.equal(result.text, null)
})

test('omite protocolos internos pero permite revocaciones y ediciones para tratarlas', () => {
  assert.equal(isNonContentProtocolType(1), true)
  assert.equal(isNonContentProtocolType(6), true)
  assert.equal(isNonContentProtocolType(0), false)
  assert.equal(isNonContentProtocolType(14), false)
})

test('la cola recupera operaciones pendientes persistidas tras reiniciar', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-queue-'))
  const file = path.join(dir, 'pending.jsonl')
  await fs.writeFile(file, `${JSON.stringify({ id: 'one', kind: 'message', data: { text: 'payload' } })}\n`)
  const queue = new PersistentQueue(file)
  await queue.initialize()
  assert.equal(queue.count(), 1)
  await queue.close()
  await fs.rm(dir, { recursive: true, force: true })
})

test('vaciar conversaciones descarta escrituras pendientes de mensajes y chats pero conserva contactos',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-queue-clear-')),file=path.join(dir,'pending.jsonl')
  const operations=[
    {id:'message',kind:'message',data:{jid:'chat@s.whatsapp.net'}},
    {id:'chat',kind:'chat',data:{jid:'chat@s.whatsapp.net'}},
    {id:'status',kind:'status',data:{jid:'chat@s.whatsapp.net'}},
    {id:'contact',kind:'contact',data:{jid:'chat@s.whatsapp.net'}},
  ]
  await fs.writeFile(file,operations.map(item=>JSON.stringify(item)).join('\n')+'\n')
  const queue=new PersistentQueue(file);await queue.initialize();await queue.discardConversationHistory()
  assert.equal(queue.count(),1)
  assert.equal(JSON.parse(await fs.readFile(file,'utf8')).kind,'contact')
  queue.resumeConversationWrites();await queue.close();await fs.rm(dir,{recursive:true,force:true})
})
