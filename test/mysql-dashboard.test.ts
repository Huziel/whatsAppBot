import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { request as httpRequest } from 'node:http'

const enabled = process.env.RUN_MYSQL_INTEGRATION === '1'

test('dashboard completa operaciones sobre MySQL aislado', { skip: !enabled }, async () => {
  assert.match(process.env.DB_NAME ?? '', /test/i, 'DB_NAME debe identificar explícitamente una base de prueba')
  assert.ok(process.env.APP_DATA_DIR, 'APP_DATA_DIR debe aislar la configuración de prueba')
  await fs.rm(process.env.APP_DATA_DIR!, { recursive: true, force: true })

  const db = await import('../src/db')
  const { launchDashboardServer } = await import('../src/http/server')
  const { resolveAppointmentStart } = await import('../src/appointment-time')

  const fallback = {
    botName: 'Bot de prueba', businessName: 'Negocio de prueba', autoReply: false,
    responseMode: 'fixed' as const, responseText: 'Respuesta simulada', replyDelayMs: 1500,
    saveToDatabase: true, deepseekApiKey: '', deepseekModel: 'deepseek-flash' as const,
    aiTone: 'professional' as const, aiResponseLength: 'brief' as const, aiSystemInstructions: '',
    maxRepliesPerHour: 20, messageRetentionDays: 0, productCatalogImageUrl: null,
    serviceCatalogImageUrl: null, transferEnabled: false, transferBankName: '',
    transferAccountHolder: '', transferAccountNumber: '', transferClabe: '', transferInstructions: '',
    appointmentsEnabled: false, appointmentTimeZone: 'America/Mexico_City', appointmentDays: [1,2,3,4,5],
    appointmentStartTime: '09:00', appointmentEndTime: '17:00', appointmentDurationMinutes: 60,
  }
  const sentMessages: Array<{ contactId: number; text: string }> = []
  const appliedSettings:string[]=[]
  const callbacks = {
    start: async () => undefined,
    applySettings: async (settings:typeof fallback) => { appliedSettings.push(settings.botName) },
    logout: async () => undefined,
    sendManualMessage: async (contactId: number, text: string) => { sentMessages.push({ contactId, text }) },
    deleteContact: db.deleteContactData,
    status: () => ({ serviceStatus: 'mocked', disconnectCode: null, pendingWrites: 0 }),
  }

  for (const table of ['conversation_effects','conversation_turns','pending_intents','order_items','orders','shopping_cart_items','shopping_carts','appointments','chat_settings','messages','chats','contact_profiles','contact_identifiers','contacts','inventory_items']) {
    await db.pool.query(`DELETE FROM ${table}`)
  }

  const server = await launchDashboardServer(fallback, callbacks, 3100)
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:3100${path}`, {
      method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload: any = await response.json()
    return { response, payload }
  }

  try {
    const crossSite=await fetch('http://127.0.0.1:3100/api/settings',{method:'POST',headers:{'content-type':'application/json','origin':'https://evil.example','sec-fetch-site':'cross-site'},body:'{}'})
    assert.equal(crossSite.status,403)
    const reboundStatus=await new Promise<number>((resolve,reject)=>{
      const rebound=httpRequest({hostname:'127.0.0.1',port:3100,path:'/api/settings',headers:{host:'evil.example:3100',origin:'http://evil.example:3100'}},response=>{response.resume();resolve(response.statusCode??0)})
      rebound.once('error',reject);rebound.end()
    })
    assert.equal(reboundStatus,403)
    const settings = { ...fallback, botName: 'Bot escritorio', businessName: 'QA Dashboard', deepseekApiKey: 'test-key-never-sent' }
    let result = await request('/api/settings', 'POST', settings)
    assert.equal(result.response.status, 200)
    assert.equal(result.payload.deepseekApiKeyConfigured, true)
    assert.equal(appliedSettings.at(-1),'Bot escritorio')

    result = await request('/api/settings')
    assert.equal(result.payload.botName, 'Bot escritorio')
    assert.equal(result.payload.deepseekApiKeyConfigured, true)
    assert.equal('deepseekApiKey' in result.payload, false)

    result = await request('/api/settings', 'POST', { ...settings, botName: 'Bot móvil', deepseekApiKey: '' })
    assert.equal(result.payload.deepseekApiKeyConfigured, true)
    result = await request('/api/settings')
    assert.equal(result.payload.botName, 'Bot móvil')
    assert.equal(result.payload.deepseekApiKeyConfigured, true)

    const createContact = async (phoneNumber: string, customName: string) => {
      const created = await request('/api/contacts', 'POST', { phoneNumber, customName, tags: 'qa', notes: 'callback simulado' })
      assert.equal(created.response.status, 201)
      return Number(created.payload.contactId)
    }
    const contactId = await createContact('5215500001001', 'Contacto QA')
    const secondContactId = await createContact('5215500001002', 'Contacto Traslape')
    result = await request(`/api/contacts/${contactId}/profile`, 'PATCH', { customName: 'Contacto QA editado', tags: 'qa, vip', notes: 'Persistente' })
    assert.equal(result.response.status, 200)
    result = await request('/api/contacts?search=vip')
    assert.equal(result.payload.total, 1)
    assert.equal(result.payload.rows[0].customName, 'Contacto QA editado')

    const product = (await request('/api/inventory', 'POST', { itemType: 'product', sku: 'QA-PROD-1', name: 'Producto QA', description: 'Inicial', imageUrl: null, price: '125.50', currency: 'MXN', stockQuantity: 10, isActive: true })).payload
    const service = (await request('/api/inventory', 'POST', { itemType: 'service', sku: 'QA-SERV-1', name: 'Servicio QA', description: '', imageUrl: null, price: '300', currency: 'MXN', stockQuantity: null, isActive: true })).payload
    result = await request(`/api/inventory/${product.id}`, 'PUT', { ...product, name: 'Producto QA editado', description: 'Actualizado', price: '130.00' })
    assert.equal(result.payload.name, 'Producto QA editado')
    result = await request(`/api/inventory/${service.id}`, 'PUT', { ...service, name: 'Servicio QA editado', description: '', price: '350.00' })
    assert.equal(result.payload.name, 'Servicio QA editado')

    const jid = '5215500001001@s.whatsapp.net'
    await db.applyShoppingCartAction(jid, 'add', [{ sku: 'QA-PROD-1', quantity: 2 }, { sku: 'QA-SERV-1', quantity: 1 }], 'qa-cart-idempotent')
    await db.applyShoppingCartAction(jid, 'add', [{ sku: 'QA-PROD-1', quantity: 2 }, { sku: 'QA-SERV-1', quantity: 1 }], 'qa-cart-idempotent')
    result = await request('/api/carts')
    assert.equal(result.payload[0].items.length, 2)
    assert.equal(result.payload[0].items.find((item:any)=>item.sku==='QA-PROD-1').quantity,2)
    let orderId = Number((await request(`/api/carts/${contactId}/orders`, 'POST')).payload.orderId)
    result = await request(`/api/orders/${orderId}`, 'PATCH', { status: 'confirmed' })
    assert.equal(result.response.status, 200)
    await db.applyShoppingCartAction(jid, 'add', [{ sku: 'QA-PROD-1', quantity: 1 }])
    orderId = Number((await request(`/api/carts/${contactId}/orders`, 'POST')).payload.orderId)
    result = await request(`/api/orders/${orderId}`, 'PATCH', { status: 'cancelled' })
    assert.equal(result.response.status, 200)
    result = await request('/api/orders')
    assert.deepEqual(new Set(result.payload.map((order: any) => order.status)), new Set(['confirmed', 'cancelled']))

    const schedule = { timeZone: 'America/Mexico_City', days: [1,2,3,4,5], startTime: '09:00', endTime: '17:00', durationMinutes: 60 }
    const firstLocal = resolveAppointmentStart('2027-02-01T09:00', schedule)
    const first = await db.createAppointment(jid, firstLocal.toUTC().toJSDate(), firstLocal.plus({ minutes: 60 }).toUTC().toJSDate(), 'Servicio QA')
    assert.equal(first.booked, true)
    const overlap = await db.createAppointment('5215500001002@s.whatsapp.net', firstLocal.plus({ minutes: 30 }).toUTC().toJSDate(), firstLocal.plus({ minutes: 90 }).toUTC().toJSDate(), 'Traslape')
    assert.equal(overlap.booked, false)
    const secondLocal = resolveAppointmentStart('2027-02-01T11:00', schedule)
    const second = await db.createAppointment('5215500001002@s.whatsapp.net', secondLocal.toUTC().toJSDate(), secondLocal.plus({ minutes: 60 }).toUTC().toJSDate(), 'Segunda cita')
    assert.equal(second.booked, true)

    result = await request('/api/appointments')
    assert.equal(result.payload.length, 2)
    assert.equal(new Date(result.payload.find((item: any) => item.id === first.appointment!.id).startsAt).toISOString(), '2027-02-01T15:00:00.000Z')
    result = await request(`/api/appointments/${first.appointment!.id}`, 'PATCH', { action: 'reschedule', localStart: '2027-02-01T11:00' })
    assert.equal(result.response.status, 409)
    result = await request(`/api/appointments/${first.appointment!.id}`, 'PATCH', { action: 'reschedule', localStart: '2027-02-01T13:00' })
    assert.equal(result.response.status, 200)
    result = await request(`/api/appointments/${second.appointment!.id}`, 'PATCH', { action: 'cancel' })
    assert.equal(result.response.status, 200)

    const firstClaim=await db.claimConversationTurn(jid,'duplicate-message',1)
    const duplicateClaim=await db.claimConversationTurn(jid,'duplicate-message',2)
    assert.equal(firstClaim.claimed,true)
    assert.equal(duplicateClaim.claimed,false)
    await db.applyShoppingCartAction(jid,'add',[{sku:'QA-PROD-1',quantity:1}],`turn:${firstClaim.turn.id}:cart`)
    assert.equal((await db.getConversationEffect(firstClaim.turn.id))?.effectType,'cart:add')
    await db.prepareConversationReply(firstClaim.turn.id,'cart','Respuesta privada','stable-outbound-id',true)
    const [[storedTurn]]:any=await db.pool.execute('SELECT outbound_text AS outboundText FROM conversation_turns WHERE id=?',[firstClaim.turn.id])
    assert.match(storedTurn.outboundText,/^enc:v1:/)
    assert.equal((await db.listRecoverableConversationTurns()).find(item=>item.id===firstClaim.turn.id)?.outboundText,'Respuesta privada')
    const exported=await db.exportContactData(contactId)
    assert.equal((exported?.conversationTurns as any[]).find(item=>Number(item.id)===firstClaim.turn.id)?.outboundText,'Respuesta privada')

    const cancelOnce=await db.cancelAppointmentById(jid,first.appointment!.id,'qa-cancel-idempotent')
    const cancelDuplicate=await db.cancelAppointmentById(jid,first.appointment!.id,'qa-cancel-idempotent')
    assert.equal(cancelOnce.status,'success')
    assert.deepEqual(cancelDuplicate,cancelOnce)

    const concurrentLocal=resolveAppointmentStart('2027-02-02T09:00',schedule)
    const concurrent=await Promise.all([
      db.createAppointment(jid,concurrentLocal.toUTC().toJSDate(),concurrentLocal.plus({minutes:60}).toUTC().toJSDate(),'Concurrente A','qa-book-a'),
      db.createAppointment('5215500001002@s.whatsapp.net',concurrentLocal.toUTC().toJSDate(),concurrentLocal.plus({minutes:60}).toUTC().toJSDate(),'Concurrente B','qa-book-b'),
    ])
    assert.equal(concurrent.filter(item=>item.booked).length,1)

    await db.savePendingIntent(jid,{intent:{kind:'appointment_details',operation:'book',settingsVersion:1,timeZone:'America/Mexico_City',expiresAt:new Date(Date.now()+60_000).toISOString()},sourceMessageId:'pending-source'})
    assert.equal((await db.getPendingIntent(jid))?.intent.kind,'appointment_details')
    await db.clearPendingIntent(jid)
    assert.equal(await db.getPendingIntent(jid),null)

    const secondJid='5215500001002@s.whatsapp.net'
    const deletionTurn=await db.claimConversationTurn(secondJid,'delete-with-contact',1)
    await db.prepareConversationReply(deletionTurn.turn.id,'test','Dato por borrar','delete-outbound-id')
    result=await request(`/api/contacts/${secondContactId}`,'DELETE')
    assert.equal(result.response.status,200)
    const [[remainingTurn]]:any=await db.pool.execute('SELECT COUNT(*) AS total FROM conversation_turns WHERE jid=?',[secondJid])
    assert.equal(Number(remainingTurn.total),0)

    assert.deepEqual(sentMessages, [])
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await db.closePool()
  }
})
