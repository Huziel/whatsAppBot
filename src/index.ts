import makeWASocket, { Browsers, BufferJSON, DisconnectReason, extractMessageContent, fetchLatestBaileysVersion, useMultiFileAuthState, WAMessage } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import { DateTime } from 'luxon'
import { config } from './config'
import { applyShoppingCartAction, CartAction, CartLine, cancelNextAppointment, closePool, createAppointment, deleteContactData, deleteMessagesOlderThan, exportContactData, getContactJid, getRecentConversation, getShoppingCart, getUpcomingAppointments, isChatBotPaused, listActiveInventory, pool, StoredMessage } from './db'
import { AppointmentPromptSettings, CatalogRequest, DeepSeekModel, detectCatalogRequest, detectPaymentRequest, generateDeepSeekResponse } from './deepseek'
import { ConversationEntry, mergeConversationTurns, RecentConversationMemory } from './conversation'
import { formatAppointmentLocal, resolveAppointmentStart } from './appointment-time'
import { isIndividualJid } from './identity'
import { logger } from './logger'
import { isNonContentProtocolType, normalizeMessage, shouldAutoReply, timestampDate } from './message'
import { PersistentQueue } from './queue'
import { PerContactRateLimiter } from './rate-limit'
import { AppSettings, launchConfigUi, loadAppSettings } from './config-ui'

function suppressSignalSessionKeyDumps(): void {
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    const output = console[method].bind(console)
    console[method] = ((...args: any[]) => {
      const containsSessionKeys = args.some(value => value && typeof value === 'object' && 'currentRatchet' in value && 'indexInfo' in value)
      if (!containsSessionKeys) output(...args)
    }) as typeof console[typeof method]
  }
}

suppressSignalSessionKeyDumps()

const queue = new PersistentQueue()
const conversationMemory = new RecentConversationMemory(30, 1_000)
let socket: ReturnType<typeof makeWASocket> | undefined
let reconnectTimer: NodeJS.Timeout | undefined
let reconnectAttempt = 0
let stopping = false
let loggedOut = false
let serviceEnabled = false
let queueInitialized = false
let databaseEnabled = true
let serviceStatus = 'stopped'
let lastDisconnectCode: number | null = null
const knownNames = new Map<string, string>()
const defaultAppSettings: AppSettings = { botName: 'Asistente de WhatsApp', businessName: 'Mi negocio', autoReply: config.autoReply, responseMode: 'fixed', responseText: 'HOLA SOY EL BOT', replyDelayMs: config.replyDelayMs, saveToDatabase: true, deepseekApiKey: '', deepseekModel: 'deepseek-flash', aiTone: 'professional', aiResponseLength: 'brief', aiSystemInstructions: '', maxRepliesPerHour: 20, messageRetentionDays: 0, productCatalogImageUrl: null, serviceCatalogImageUrl: null, transferEnabled: false, transferBankName: '', transferAccountHolder: '', transferAccountNumber: '', transferClabe: '', transferInstructions: '', appointmentsEnabled: false, appointmentTimeZone: 'America/Mexico_City', appointmentDays: [1, 2, 3, 4, 5], appointmentStartTime: '09:00', appointmentEndTime: '17:00', appointmentDurationMinutes: 60 }
let waVersion: [number, number, number] | undefined
let processStartedAtSeconds = 0
let replySettings: { enabled: boolean; mode: 'fixed' | 'deepseek'; text: string; delayMs: number; deepseekApiKey: string; deepseekModel: DeepSeekModel; aiTone: 'friendly' | 'professional' | 'formal'; aiResponseLength: 'brief' | 'balanced' | 'detailed'; customInstructions: string; maxRepliesPerHour: number } = {
  enabled: config.autoReply, mode: 'fixed', text: 'HOLA SOY EL BOT', delayMs: config.replyDelayMs, deepseekApiKey: '', deepseekModel: 'deepseek-flash', aiTone: 'professional', aiResponseLength: 'brief', customInstructions: '', maxRepliesPerHour: 20,
}
let generalCatalogImages = { products: null as string | null, services: null as string | null }
let transferSettings = { enabled: false, bankName: '', accountHolder: '', accountNumber: '', clabe: '', instructions: '' }
let appointmentSettings: AppointmentPromptSettings = { enabled: false, timeZone: 'America/Mexico_City', days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00', durationMinutes: 60, nowLocal: '' }
let botIdentity = { botName: defaultAppSettings.botName, businessName: defaultAppSettings.businessName }
const repliedMessageKeys = new Set<string>()
let configServer: Awaited<ReturnType<typeof launchConfigUi>> | undefined
let retentionTimer: NodeJS.Timeout | undefined
const replyRateLimiter = new PerContactRateLimiter()

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function personalizeFixedResponse(text: string): string {
  return text.replaceAll('{botName}', botIdentity.botName).replaceAll('{businessName}', botIdentity.businessName)
}

function formatCartSummary(action: CartAction, lines: CartLine[]): string {
  if (action === 'clear') return 'Carrito vaciado. No se realizó ningún cobro ni reserva.'
  const prefix = action === 'show' ? 'Tu carrito actual:' : 'Carrito actualizado:'
  if (!lines.length) return action === 'show' ? 'Tu carrito está vacío.' : `${prefix} está vacío. No se realizó ningún cobro ni reserva.`
  const items = lines.map(line => {
    const price = line.unitPrice === null ? 'precio por cotizar' : `${line.unitPrice} ${line.currency} c/u`
    return `• ${line.quantity} × ${line.itemName} — ${price}`
  })
  return `${prefix}\n${items.join('\n')}\n\nEl carrito es informativo; no se realizó ningún cobro ni reserva de existencias.`
}

function rememberLiveMessage(message: WAMessage): void {
  const jid = targetJid(message)
  const id = message.key.id
  if (!jid || !id) return
  const timestampMs = timestampDate(message.messageTimestamp).getTime()
  if (!Number.isFinite(timestampMs) || timestampMs < processStartedAtSeconds * 1000) return
  const text = normalizeMessage(message).text
  if (!text?.trim()) return
  const entry: ConversationEntry = { id, role: message.key.fromMe ? 'assistant' : 'user', content: text, timestampMs }
  conversationMemory.remember(jid, entry)
}

async function persist(kind: Parameters<PersistentQueue['enqueue']>[0], data: unknown): Promise<void> {
  if (databaseEnabled) await queue.enqueue(kind, data)
}

function serialize(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer)
}

function targetJid(message: WAMessage): string | null {
  const remote = message.key.remoteJid
  return isIndividualJid(remote) ? remote! : null
}

async function enqueueMessage(message: WAMessage): Promise<void> {
  const jid = targetJid(message)
  const id = message.key.id
  if (!jid || !id || !message.message) return
  const unpacked = normalizeMessage(message)
  const content = extractMessageContent(message.message)
  const protocol = content?.protocolMessage
  const protocolKey = protocol?.key
  if (protocol?.type === 0 && protocolKey?.id && protocolKey.remoteJid) {
    const deleteJid = isIndividualJid(protocolKey.remoteJid) ? protocolKey.remoteJid : jid
    conversationMemory.forget(deleteJid, protocolKey.id)
    await persist('delete', { jid: deleteJid, id: protocolKey.id, fromMe: !!protocolKey.fromMe })
    return
  }
  // Keep edits attached to the original message key, replacing the stored content.
  const isEdit = protocol?.type === 14 && !!protocolKey?.id
  // Baileys also emits protocol-only sync/control events; they are not chat messages.
  if (protocol && (isNonContentProtocolType(protocol.type) || !isEdit)) return
  const body = isEdit ? protocol.editedMessage : message.message
  const normalized = isEdit ? normalizeMessage({ message: body }) : unpacked
  const targetId = isEdit ? protocolKey!.id! : id
  const item = {
    jid, lid: jid.endsWith('@lid') ? jid : null,
    waMessageId: targetId, fromMe: isEdit ? !!protocolKey!.fromMe : !!message.key.fromMe,
    displayName: knownNames.get(jid) ?? message.pushName ?? null,
    senderJid: message.key.participant ?? message.participant ?? jid,
    messageType: normalized.type, text: normalized.text,
    timestamp: timestampDate(message.messageTimestamp), status: message.status,
    deleted: normalized.deleted,
    rawPayload: JSON.parse(serialize(body)),
  } satisfies StoredMessage
  await persist('message', item)
}

async function startSocket(): Promise<void> {
  if (stopping || !serviceEnabled || loggedOut || socket) return
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir)
  const current = makeWASocket({
    auth: state,
    version: waVersion,
    // With syncFullHistory=true, Windows/MacOS are advertised as WIN32/DARWIN.
    // Ubuntu intentionally maps to WEB_BROWSER, avoiding the recent 428 rejection.
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: true,
    emitOwnEvents: true,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    logger: pino({ level: 'silent' }),
  })
  socket = current
  current.ev.on('creds.update', saveCreds)
  current.ev.on('connection.update', update => {
    if (update.qr) {
      serviceStatus = 'waiting-qr'
      logger.info('Escanea el QR desde WhatsApp > Dispositivos vinculados')
      qrcode.generate(update.qr, { small: true })
    }
    if (update.connection === 'open') { reconnectAttempt = 0; serviceStatus = 'connected'; lastDisconnectCode = null; logger.info('WhatsApp conectado') }
    if (update.connection === 'close') {
      const disconnectError = update.lastDisconnect?.error as (Boom & Error) | undefined
      const reason = disconnectError?.output?.statusCode
      lastDisconnectCode = reason ?? null
      socket = undefined
      if (reason === DisconnectReason.loggedOut) {
        loggedOut = true
        serviceEnabled = false
        serviceStatus = 'logged-out'
        logger.error('La sesión fue cerrada desde WhatsApp; elimina AUTH_DIR y vuelve a vincular mediante QR')
        return
      }
      if (!stopping && serviceEnabled) {
        serviceStatus = 'reconnecting'
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt++, 5))
        logger.warn({ delayMs: delay, disconnectCode: reason ?? null, disconnectMessage: disconnectError?.message ?? 'desconexión sin detalle' }, 'Conexión cerrada; reconexión programada')
        reconnectTimer = setTimeout(() => { void startSocket().catch(error => logger.error({ err: error }, 'No se pudo reconectar')) }, delay)
      }
    }
  })
  current.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
    try {
      for (const chat of chats) if (isIndividualJid(chat.id)) await persist('chat', { jid: chat.id, name: chat.name ?? null })
      for (const contact of contacts) if (isIndividualJid(contact.id)) {
        const name = contact.name ?? contact.notify ?? contact.verifiedName
        if (name) { knownNames.set(contact.id, name); await persist('contact', { jid: contact.id, name }) }
      }
      for (const message of messages) await enqueueMessage(message)
      logger.info({ importedMessages: messages.length, individualChats: chats.filter(c => isIndividualJid(c.id)).length }, 'Bloque de historial recibido')
    } catch (error) { logger.error({ err: error }, 'Error procesando historial; se conservaron operaciones ya encoladas') }
  })
  current.ev.on('chats.upsert', async chats => {
    try { for (const chat of chats) if (isIndividualJid(chat.id)) await persist('chat', { jid: chat.id, name: chat.name ?? null }) }
    catch (error) { logger.error({ err: error }, 'Error procesando chats.upsert') }
  })
  current.ev.on('contacts.upsert', async contacts => {
    try { for (const contact of contacts) if (isIndividualJid(contact.id)) {
      const name = contact.name ?? contact.notify ?? contact.verifiedName
      if (name) { knownNames.set(contact.id, name); await persist('contact', { jid: contact.id, name }) }
    } }
    catch (error) { logger.error({ err: error }, 'Error procesando contacts.upsert') }
  })
  current.ev.on('contacts.update', async updates => {
    try { for (const contact of updates) if (contact.id && isIndividualJid(contact.id) && contact.name) {
      knownNames.set(contact.id, contact.name)
      await persist('contact', { jid: contact.id, name: contact.name })
    } }
    catch (error) { logger.error({ err: error }, 'Error procesando contacts.update') }
  })
  current.ev.on('chats.phoneNumberShare', async event => {
    try { await persist('chat', { jid: event.lid, phoneJid: event.jid }) }
    catch (error) { logger.error({ err: error }, 'Error procesando correspondencia LID-PN') }
  })
  current.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      for (const message of messages) {
        if (type === 'notify' || message.key.fromMe) rememberLiveMessage(message)
        await enqueueMessage(message)
        if (!replySettings.enabled || !shouldAutoReply(message, type, processStartedAtSeconds)) continue
        const jid = message.key.remoteJid!
        try { if (await isChatBotPaused(jid)) continue }
        catch (error: any) { logger.error({ error: error.message }, 'No se pudo verificar la pausa por chat; no se responderá'); continue }
        const dedupKey = `${jid}:${message.key.id}`
        if (repliedMessageKeys.has(dedupKey)) continue
        repliedMessageKeys.add(dedupKey)
        if (!replyRateLimiter.consume(jid, replySettings.maxRepliesPerHour)) { logger.info('Respuesta omitida por límite por contacto/hora'); continue }
        await wait(replySettings.delayMs)
        if (stopping || !serviceEnabled || socket !== current) continue
        let answer = personalizeFixedResponse(replySettings.text)
        let recommendedSkus: string[] = []
        let catalogRequest: CatalogRequest = null
        let paymentRequest = false
        let replyInventory: Awaited<ReturnType<typeof listActiveInventory>> = []
        if (replySettings.mode === 'deepseek') {
          const inputText = normalizeMessage(message).text
          if (inputText) {
            const explicitCatalogRequest = detectCatalogRequest(inputText)
            try {
              replyInventory = await listActiveInventory()
              const inventoryReference = replyInventory.map(({ itemType, sku, name, description, price, currency, stockQuantity }) => ({ itemType, sku, name, description: description?.slice(0, 500) ?? null, price, currency, stockQuantity }))
              const currentCart = await getShoppingCart(jid)
              let databaseHistory: Awaited<ReturnType<typeof getRecentConversation>> = []
              if (databaseEnabled) {
                try { databaseHistory = await getRecentConversation(jid, message.key.id!, 12) }
                catch (error: any) { logger.warn({ error: error.message }, 'No se pudo cargar el historial para DeepSeek; se usará el contexto de sesión') }
              }
              const conversation = mergeConversationTurns(databaseHistory, conversationMemory.get(jid), message.key.id!, 12)
              const appointmentContext = {
                ...appointmentSettings,
                nowLocal: DateTime.now().setZone(appointmentSettings.timeZone).toFormat("yyyy-MM-dd'T'HH:mm"),
              }
              const toneInstructions = { friendly: 'amable y cercano', professional: 'profesional y claro', formal: 'formal y respetuoso' }[replySettings.aiTone]
              const lengthInstructions = { brief: 'contesta en 1-2 frases, salvo que se solicite una lista completa', balanced: 'contesta en pocas frases con el detalle necesario', detailed: 'ofrece explicaciones detalladas cuando ayuden al cliente' }[replySettings.aiResponseLength]
              const identityInstructions = `El bot se llama ${botIdentity.botName} y representa al negocio ${botIdentity.businessName}. Tono ${toneInstructions}; ${lengthInstructions}. ${replySettings.customInstructions}`
              const generated = await generateDeepSeekResponse(replySettings.deepseekApiKey, replySettings.deepseekModel, inputText, inventoryReference, currentCart, transferSettings.enabled, appointmentContext, conversation, identityInstructions)
              answer = generated.text
              recommendedSkus = generated.productSkus
              catalogRequest = explicitCatalogRequest ?? generated.catalogRequest
              paymentRequest = generated.paymentRequest || detectPaymentRequest(inputText)
              if (generated.cartAction !== 'none') {
                const updatedCart = await applyShoppingCartAction(jid, generated.cartAction, generated.cartItems)
                answer = `${answer}\n\n${formatCartSummary(generated.cartAction, updatedCart)}`
              }
              if (generated.appointmentAction !== 'none') {
                if (generated.appointmentAction === 'list') {
                  const upcoming = await getUpcomingAppointments(jid)
                  answer = upcoming.length
                    ? `Tus próximas citas:\n${upcoming.map(item => `• ${formatAppointmentLocal(item.startsAt, appointmentSettings.timeZone)}${item.serviceRequested ? ` — ${item.serviceRequested}` : ''}`).join('\n')}`
                    : 'No tienes citas futuras registradas.'
                } else if (generated.appointmentAction === 'cancel') {
                  const cancelled = await cancelNextAppointment(jid)
                  answer = cancelled
                    ? `Cancelé tu próxima cita: ${formatAppointmentLocal(cancelled.startsAt, appointmentSettings.timeZone)}${cancelled.serviceRequested ? ` — ${cancelled.serviceRequested}` : ''}.`
                    : 'No encontré citas futuras para cancelar.'
                } else if (!generated.appointmentStart) {
                  answer = `Para agendar, dime la fecha y hora que prefieres. Nuestro horario es ${appointmentSettings.startTime}–${appointmentSettings.endTime} (${appointmentSettings.timeZone}).`
                } else {
                  try {
                    const localStart = resolveAppointmentStart(generated.appointmentStart, appointmentSettings)
                    const startUtc = localStart.toUTC().toJSDate()
                    const endUtc = localStart.plus({ minutes: appointmentSettings.durationMinutes }).toUTC().toJSDate()
                    const result = await createAppointment(jid, startUtc, endUtc, generated.appointmentService)
                    answer = result.booked
                      ? `Cita agendada para ${localStart.setLocale('es').toFormat('cccc dd LLL yyyy, HH:mm')} (${appointmentSettings.timeZone}), duración ${appointmentSettings.durationMinutes} minutos${generated.appointmentService ? `, servicio: ${generated.appointmentService}` : ''}. No se realizó ningún cobro.`
                      : 'Ese horario ya está ocupado. Dime otra fecha y hora para revisar disponibilidad.'
                  } catch (error: any) {
                    answer = `${error.message}. Dime otra fecha y hora para revisar disponibilidad.`
                  }
                }
              }
              if (catalogRequest) replyInventory = await listActiveInventory(null)
            }
            catch (error: any) { logger.warn({ error: error.message }, 'DeepSeek falló; se usará el texto alternativo configurado') }
          } else logger.info('Mensaje sin texto; se usará el texto alternativo configurado')
        }
        if (transferSettings.enabled && paymentRequest) {
          const details = [
            `Banco: ${transferSettings.bankName}`,
            `Titular: ${transferSettings.accountHolder}`,
            transferSettings.clabe ? `CLABE: ${transferSettings.clabe}` : '',
            transferSettings.accountNumber ? `Número de cuenta: ${transferSettings.accountNumber}` : '',
            transferSettings.instructions ? `Referencia/instrucciones: ${transferSettings.instructions}` : '',
          ].filter(Boolean).join('\n')
          answer = `${answer}\n\nDatos para transferencia:\n${details}`
        }
        let catalogMessages: string[] = []
        let catalogItemTypes: Array<'product' | 'service'> = []
        if (catalogRequest) {
          try {
            const latestSettings = await loadAppSettings(defaultAppSettings)
            generalCatalogImages = { products: latestSettings.productCatalogImageUrl, services: latestSettings.serviceCatalogImageUrl }
          } catch (error: any) { logger.warn({ error: error.message }, 'No se pudieron actualizar las imágenes generales desde configuración') }
          catalogItemTypes = catalogRequest === 'both' ? ['product', 'service'] : [catalogRequest === 'products' ? 'product' : 'service']
          for (const itemType of catalogItemTypes) {
            const items = replyInventory.filter(item => item.itemType === itemType)
            const label = itemType === 'product' ? 'Productos' : 'Servicios'
            const lines = items.map(item => {
              const price = item.price === null ? 'precio a cotizar' : `${item.price} ${item.currency}`
              const stock = item.itemType === 'product'
                ? item.stockQuantity === 0 ? 'agotado' : item.stockQuantity === null ? 'existencias no controladas' : `existencias: ${item.stockQuantity}`
                : ''
              return `• ${item.name} — ${price}${stock ? ` — ${stock}` : ''}`
            })
            const text = items.length ? `${label} disponibles:\n${lines.join('\n')}` : `No hay ${label.toLowerCase()} activos en este momento.`
            let chunk = ''
            for (const line of text.split('\n')) {
              if (chunk && `${chunk}\n${line}`.length > 3_500) { catalogMessages.push(chunk); chunk = line }
              else chunk = chunk ? `${chunk}\n${line}` : line
            }
            if (chunk) catalogMessages.push(chunk)
          }
          if (catalogMessages.length) answer = catalogMessages.shift()!
        }
        if (stopping || !serviceEnabled || socket !== current) continue
        const replyMessage = await current.sendMessage(jid, { text: answer }, { quoted: message })
        if (replyMessage?.key.id) conversationMemory.remember(jid, { id: replyMessage.key.id, role: 'assistant', content: answer, timestampMs: Date.now() })
        if (catalogRequest) {
          for (const text of catalogMessages) {
              const catalogMessage = await current.sendMessage(jid, { text }, { quoted: message })
              if (catalogMessage?.key.id) conversationMemory.remember(jid, { id: catalogMessage.key.id, role: 'assistant', content: text, timestampMs: Date.now() })
          }
          for (const itemType of catalogItemTypes) {
            const label = itemType === 'product' ? 'productos' : 'servicios'
            const imageUrl = itemType === 'product' ? generalCatalogImages.products : generalCatalogImages.services
            if (imageUrl) {
              try { await current.sendMessage(jid, { image: { url: imageUrl }, caption: `Catálogo de ${botIdentity.businessName} — ${label.toLowerCase()}` }, { quoted: message }) }
              catch (error: any) { logger.warn({ error: error.message }, 'No se pudo enviar la imagen general del catálogo') }
            }
          }
        }
        if (replySettings.mode === 'deepseek' && !catalogRequest && recommendedSkus.length) {
          for (const sku of recommendedSkus.slice(0, 2)) {
            const item = replyInventory.find(candidate => candidate.sku === sku && candidate.imageUrl)
            if (!item?.imageUrl || stopping || !serviceEnabled || socket !== current) continue
            try { await current.sendMessage(jid, { image: { url: item.imageUrl }, caption: item.name }, { quoted: message }) }
            catch (error: any) { logger.warn({ error: error.message }, 'No se pudo enviar una imagen de producto') }
          }
        }
        logger.info({ delayMs: replySettings.delayMs }, 'Respuesta de prueba enviada')
      }
    }
    catch (error) { logger.error({ err: error }, 'Error procesando messages.upsert') }
  })
  current.ev.on('messages.update', async updates => {
    try {
      for (const { key, update } of updates) {
        const jid = key.remoteJid
        if (!jid || !key.id || !isIndividualJid(jid)) continue
        if (update.status !== undefined) await persist('status', { jid, id: key.id, fromMe: !!key.fromMe, status: update.status })
        if (update.message) {
          const edited = { key, message: update.message, messageTimestamp: Math.floor(Date.now() / 1000) } as WAMessage
          rememberLiveMessage(edited)
          await enqueueMessage(edited)
        }
      }
    } catch (error) { logger.error({ err: error }, 'Error procesando messages.update') }
  })
  current.ev.on('messages.delete', async event => {
    try {
      if ('keys' in event) for (const key of event.keys) if (key.remoteJid && isIndividualJid(key.remoteJid) && key.id) {
        conversationMemory.forget(key.remoteJid, key.id)
        await persist('delete', { jid: key.remoteJid, id: key.id, fromMe: !!key.fromMe })
      }
    } catch (error) { logger.error({ err: error }, 'Error procesando messages.delete') }
  })
}

async function startConfiguredService(settings: AppSettings): Promise<void> {
  if (serviceEnabled || socket) throw new Error('El servicio de WhatsApp ya está iniciado')
  stopping = false
  loggedOut = false
  serviceEnabled = true
  serviceStatus = 'connecting'
  databaseEnabled = settings.saveToDatabase
  botIdentity = { botName: settings.botName, businessName: settings.businessName }
  replySettings = {
    enabled: settings.autoReply,
    mode: settings.responseMode,
    text: settings.responseText,
    delayMs: settings.replyDelayMs,
    deepseekApiKey: settings.deepseekApiKey,
    deepseekModel: settings.deepseekModel,
    aiTone: settings.aiTone,
    aiResponseLength: settings.aiResponseLength,
    customInstructions: settings.aiSystemInstructions,
    maxRepliesPerHour: settings.maxRepliesPerHour,
  }
  generalCatalogImages = { products: settings.productCatalogImageUrl, services: settings.serviceCatalogImageUrl }
  transferSettings = {
    enabled: settings.transferEnabled,
    bankName: settings.transferBankName,
    accountHolder: settings.transferAccountHolder,
    accountNumber: settings.transferAccountNumber,
    clabe: settings.transferClabe,
    instructions: settings.transferInstructions,
  }
  appointmentSettings = {
    enabled: settings.appointmentsEnabled,
    timeZone: settings.appointmentTimeZone,
    days: settings.appointmentDays,
    startTime: settings.appointmentStartTime,
    endTime: settings.appointmentEndTime,
    durationMinutes: settings.appointmentDurationMinutes,
    nowLocal: '',
  }
  processStartedAtSeconds = Math.ceil(Date.now() / 1000)
  repliedMessageKeys.clear()
  replyRateLimiter.clear()
  try {
    const needsDatabase = databaseEnabled || settings.autoReply
    if (needsDatabase) {
      await pool.query('SELECT 1')
      logger.info('Conexión MySQL verificada')
      if (databaseEnabled) {
        if (!queueInitialized) { await queue.initialize(); queueInitialized = true }
        void queue.drain()
        if (retentionTimer) clearInterval(retentionTimer)
        if (settings.messageRetentionDays > 0) {
          const cleanup = async () => {
            try {
              const removed = await deleteMessagesOlderThan(settings.messageRetentionDays)
              conversationMemory.pruneOlderThan(Date.now() - settings.messageRetentionDays * 24 * 60 * 60 * 1000)
              logger.info({ removed }, 'Limpieza de retención completada')
            }
            catch (error: any) { logger.error({ error: error.message }, 'Falló la limpieza de retención') }
          }
          await cleanup()
          retentionTimer = setInterval(() => { void cleanup() }, 24 * 60 * 60 * 1000)
          retentionTimer.unref()
        }
      }
    }
    try {
      const latest = await fetchLatestBaileysVersion()
      waVersion = latest.version
      logger.info({ waVersion: waVersion.join('.'), isLatest: latest.isLatest }, 'Versión de WhatsApp Web seleccionada')
    } catch (error: any) {
      logger.warn({ error: error?.message }, 'No se pudo consultar la versión remota; se usará la versión incluida en Baileys')
    }
    await startSocket()
  } catch (error) {
    serviceEnabled = false
    serviceStatus = 'error'
    throw error
  }
}

async function logoutWhatsApp(): Promise<void> {
  serviceEnabled = false
  serviceStatus = 'stopped'
  loggedOut = false
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined }
  if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = undefined }
  const current = socket
  socket = undefined
  if (current) {
    try { await current.logout() } catch { /* puede estar desconectado; de todos modos se borran las credenciales locales */ }
  }
  await fs.rm(config.authDir, { recursive: true, force: true })
  serviceStatus = 'logged-out'
}

async function sendManualMessage(contactId: number, text: string): Promise<void> {
  if (!socket || serviceStatus !== 'connected') throw new Error('WhatsApp no está conectado')
  const jid = await getContactJid(contactId)
  if (!jid) throw new Error('El contacto no tiene un identificador de WhatsApp disponible')
  const message = await socket.sendMessage(jid, { text })
  if (message?.key.id) conversationMemory.remember(jid, { id: message.key.id, role: 'assistant', content: text, timestampMs: Date.now() })
}

async function deleteContact(contactId: number): Promise<boolean> {
  const data = await exportContactData(contactId)
  if (!data) return false
  const identifiers = data.identifiers as Array<{ jid: string }>
  for (const identifier of identifiers) {
    conversationMemory.clear(identifier.jid)
    knownNames.delete(identifier.jid)
    replyRateLimiter.forget(identifier.jid)
    for (const key of repliedMessageKeys) if (key.startsWith(`${identifier.jid}:`)) repliedMessageKeys.delete(key)
  }
  return deleteContactData(contactId)
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  serviceEnabled = false
  logger.info({ signal }, 'Cerrando proceso')
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (retentionTimer) clearInterval(retentionTimer)
  try { socket?.end(undefined) } catch {}
  configServer?.close()
  await queue.close()
  await closePool()
  process.exit(0)
}

async function main(): Promise<void> {
  const initialSettings = await loadAppSettings(defaultAppSettings)
  configServer = await launchConfigUi(initialSettings, {
    start: startConfiguredService,
    logout: logoutWhatsApp,
    sendManualMessage,
    deleteContact,
    status: () => ({ serviceStatus, disconnectCode: lastDisconnectCode, pendingWrites: queue.count(), saveToDatabase: databaseEnabled }),
  })
  logger.info('Panel de configuración listo en http://127.0.0.1:3000. Configura opciones y pulsa "Iniciar servicio WhatsApp".')
  const browserCommand = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const browserArgs = process.platform === 'win32' ? ['/c', 'start', '', 'http://127.0.0.1:3000'] : ['http://127.0.0.1:3000']
  const browser = spawn(browserCommand, browserArgs, { detached: true, stdio: 'ignore', windowsHide: true })
  browser.on('error', error => logger.warn({ err: error }, 'No se pudo abrir el navegador automáticamente; abre http://127.0.0.1:3000'))
  browser.unref()
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}

main().catch(async error => {
  logger.fatal({ err: error }, 'No se pudo iniciar. Verifica .env, migraciones y conexión MySQL')
  await closePool().catch(() => undefined)
  process.exitCode = 1
})
