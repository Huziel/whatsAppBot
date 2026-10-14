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
  await db.assertConversationEngineSchema()
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
  const sentMessages: Array<{ contactId:number;text:string;imageBytes:number;mimeType:string|null }> = []
  const appliedSettings:string[]=[]
  const callbacks = {
    start: async () => undefined,
    applySettings: async (settings:typeof fallback) => { appliedSettings.push(settings.botName) },
    logout: async () => undefined,
    sendManualMessage: async (contactId: number, message: {text:string;image:Buffer|null;mimeType:string|null}) => { sentMessages.push({contactId,text:message.text,imageBytes:message.image?.length??0,mimeType:message.mimeType}) },
    deleteContact: db.deleteContactData,
    clearConversations: async () => db.clearAllConversationHistory(),
    status: () => ({ serviceStatus: 'mocked', disconnectCode: null, pendingWrites: 0 }),
  }

  for (const table of ['conversation_effects','conversation_turns','pending_intents','order_items','orders','shopping_cart_items','shopping_carts','appointments','chat_settings','messages','chats','contact_profiles','contact_identifiers','contacts','inventory_items']) {
    await db.pool.query(`DELETE FROM ${table}`)
  }

  const server = await launchDashboardServer(fallback, callbacks, 3100)
  let sessionCookie=''
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:3100${path}`, {
      method, headers: { 'content-type': 'application/json',...(sessionCookie?{cookie:sessionCookie}:{}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload: any = await response.json()
    return { response, payload }
  }

  try {
    const publicStatus=await request('/api/auth/status')
    assert.equal(publicStatus.payload.configured,false)
    const unauthenticated=await request('/api/settings')
    assert.equal(unauthenticated.response.status,401)
    const loginPage=await fetch('http://127.0.0.1:3100/')
    assert.match(await loginPage.text(),/id="loginForm"/)
    const loginScript=await fetch('http://127.0.0.1:3100/js/login.js')
    assert.match(await loginScript.text(),/no conservó la sesión/)
    const createdAccess=await request('/api/auth/setup','POST',{username:'admin-qa',password:'password-de-prueba-segura'})
    assert.equal(createdAccess.response.status,200)
    const setupCookie=createdAccess.response.headers.get('set-cookie')!
    assert.match(setupCookie,/HttpOnly/);assert.match(setupCookie,/SameSite=Strict/)
    sessionCookie=setupCookie.split(';')[0]
    assert.ok(sessionCookie.startsWith('wa_dashboard_session='))
    assert.equal((await request('/api/auth/status')).payload.authenticated,true)
    const restartedDashboard=await launchDashboardServer(fallback,callbacks,3102)
    try{
      const restoredSession=await fetch('http://127.0.0.1:3102/api/auth/status',{headers:{cookie:sessionCookie}})
      assert.equal((await restoredSession.json() as any).authenticated,true)
    }finally{await new Promise<void>((resolve,reject)=>restartedDashboard.close(error=>error?reject(error):resolve()))}
    const dashboardPage=await fetch('http://127.0.0.1:3100/',{headers:{cookie:sessionCookie}})
    assert.match(await dashboardPage.text(),/Resumen/)
    const badLogin=await request('/api/auth/login','POST',{username:'admin-qa',password:'incorrecta-123'})
    assert.equal(badLogin.response.status,400)
    const logout=await request('/api/auth/logout','POST',{})
    assert.equal(logout.response.status,200)
    const loggedOutSettings=await request('/api/settings')
    assert.equal(loggedOutSettings.response.status,401)
    const loggedIn=await request('/api/auth/login','POST',{username:'admin-qa',password:'password-de-prueba-segura'})
    assert.equal(loggedIn.response.status,200)
    sessionCookie=loggedIn.response.headers.get('set-cookie')!.split(';')[0]

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
    result=await request(`/api/contacts/${contactId}/messages`,'POST',{text:'Mensaje manual QA'})
    assert.equal(result.response.status,200)
    const qaImage=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00])
    result=await request(`/api/contacts/${contactId}/messages`,'POST',{text:'Pie de imagen QA',imageData:qaImage.toString('base64'),imageMimeType:'image/png'})
    assert.equal(result.response.status,200)
    assert.deepEqual(sentMessages,[
      {contactId,text:'Mensaje manual QA',imageBytes:0,mimeType:null},
      {contactId,text:'Pie de imagen QA',imageBytes:qaImage.length,mimeType:'image/png'},
    ])
    result=await request(`/api/contacts/${contactId}/messages`,'POST',{text:'',imageData:'%%%',imageMimeType:'image/png'})
    assert.equal(result.response.status,400)
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
    const firstRecoveryPage=await db.claimRecoverableConversationTurnsPage(0,await db.getRecoveryHighWaterMark(),100,'qa-first-page',120,0)
    assert.equal(firstRecoveryPage.items.find(item=>item.id===firstClaim.turn.id)?.outboundText,'Respuesta privada')
    for(const item of firstRecoveryPage.items)await db.releaseRecoveryClaim(item.id,'qa-first-page')
    const exported=await db.exportContactData(contactId)
    assert.equal((exported?.conversationTurns as any[]).find(item=>Number(item.id)===firstClaim.turn.id)?.outboundText,'Respuesta privada')

    await db.applyShoppingCartAction(jid,'clear',[])
    await db.applyShoppingCartAction(jid,'add',[{sku:'QA-PROD-1',quantity:4}])
    await db.applyShoppingCartAction(jid,'remove',[{sku:'QA-PROD-1',quantity:2}])
    assert.equal((await db.getShoppingCart(jid)).find(item=>item.sku==='QA-PROD-1')?.quantity,2)
    await db.applyShoppingCartAction(jid,'remove',[{sku:'QA-PROD-1',quantity:1,removeAll:true}])
    assert.equal((await db.getShoppingCart(jid)).some(item=>item.sku==='QA-PROD-1'),false)

    const ownedTurn=await db.claimConversationTurn(jid,'lease-ownership',1)
    const freshPage=await db.claimRecoverableConversationTurnsPage(ownedTurn.turn.id-1,ownedTurn.turn.id,1,'qa-too-fresh')
    assert.equal(freshPage.items.length,0)
    const ownershipPage=await db.claimRecoverableConversationTurnsPage(ownedTurn.turn.id-1,ownedTurn.turn.id,1,'qa-owner',120,0)
    assert.equal(ownershipPage.items.length,1)
    assert.equal(await db.prepareConversationReply(ownedTurn.turn.id,'test','No autorizado','owner-outbound',false,'wrong-owner'),false)
    assert.equal(await db.prepareConversationReply(ownedTurn.turn.id,'test','Autorizado','owner-outbound',false,'qa-owner'),true)
    assert.equal(await db.beginConversationTurnSend(ownedTurn.turn.id,'wrong-owner'),false)
    assert.equal(await db.beginConversationTurnSend(ownedTurn.turn.id,'qa-owner'),true)
    await db.markConversationTurnSent(ownedTurn.turn.id,'wrong-owner')
    const [[stillSending]]:any=await db.pool.execute('SELECT status FROM conversation_turns WHERE id=?',[ownedTurn.turn.id])
    assert.equal(stillSending.status,'sending')
    await db.markConversationTurnSent(ownedTurn.turn.id,'qa-owner')

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
    await db.clearPendingIntentBySource(jid,'different-source')
    assert.equal((await db.getPendingIntent(jid))?.sourceMessageId,'pending-source')
    await db.clearPendingIntentBySource(jid,'pending-source')
    assert.equal(await db.getPendingIntent(jid),null)
    await db.savePendingIntent(jid,{intent:{kind:'appointment_details',operation:'book',settingsVersion:1,timeZone:'America/Mexico_City',expiresAt:new Date(Date.now()+60_000).toISOString()},sourceMessageId:'pending-source'})
    await db.clearPendingIntent(jid)
    assert.equal(await db.getPendingIntent(jid),null)
    await db.savePendingIntent(jid,{intent:{kind:'appointment_details',operation:'book',settingsVersion:1,timeZone:'America/Mexico_City',expiresAt:new Date(Date.now()-1000).toISOString()},sourceMessageId:'expired-pending'})
    assert.equal(await db.getPendingIntent(jid),null)

    const oldDate='2020-01-01 00:00:00.000'
    const pendingTurn=await db.claimConversationTurn(jid,'retention-pending',1)
    await db.applyShoppingCartAction(jid,'add',[{sku:'QA-PROD-1',quantity:1}],`turn:${pendingTurn.turn.id}:cart`)
    await db.prepareConversationReply(pendingTurn.turn.id,'cart_applied','Pendiente','retention-pending-out',true)
    const uncertainTurn=await db.claimConversationTurn(jid,'retention-uncertain',1)
    await db.applyShoppingCartAction(jid,'add',[{sku:'QA-PROD-1',quantity:1}],`turn:${uncertainTurn.turn.id}:cart`)
    await db.prepareConversationReply(uncertainTurn.turn.id,'cart_applied','Incierto','retention-uncertain-out',true)
    assert.equal(await db.beginConversationTurnSend(uncertainTurn.turn.id),true)
    await db.markConversationTurnUncertain(uncertainTurn.turn.id)
    const terminalTurn=await db.claimConversationTurn(jid,'retention-terminal',1)
    await db.applyShoppingCartAction(jid,'add',[{sku:'QA-PROD-1',quantity:1}],`turn:${terminalTurn.turn.id}:cart`)
    await db.prepareConversationReply(terminalTurn.turn.id,'cart_applied','Enviado','retention-terminal-out',true)
    assert.equal(await db.beginConversationTurnSend(terminalTurn.turn.id),true)
    await db.markConversationTurnSent(terminalTurn.turn.id)
    await db.pool.query('UPDATE conversation_turns SET created_at=?,updated_at=? WHERE id IN (?,?,?)',[oldDate,oldDate,pendingTurn.turn.id,uncertainTurn.turn.id,terminalTurn.turn.id])
    await db.pool.query('UPDATE conversation_effects SET created_at=? WHERE effect_key IN (?,?,?)',[oldDate,`turn:${pendingTurn.turn.id}:cart`,`turn:${uncertainTurn.turn.id}:cart`,`turn:${terminalTurn.turn.id}:cart`])
    const quantityBeforeCleanup=(await db.getShoppingCart(jid)).find((item:any)=>item.sku==='QA-PROD-1')!.quantity
    const cleanup=await db.cleanupOperationalRecords(30,10,10)
    assert.ok(cleanup.turns>=1)
    assert.ok(await db.getConversationEffect(pendingTurn.turn.id))
    assert.ok(await db.getConversationEffect(uncertainTurn.turn.id))
    assert.equal(await db.getConversationEffect(terminalTurn.turn.id),null)
    const highWater=await db.getRecoveryHighWaterMark()
    const recoverable=await db.claimRecoverableConversationTurnsPage(0,highWater,100,'qa-retention-page',120,0)
    assert.ok(recoverable.items.some(item=>item.id===pendingTurn.turn.id))
    assert.ok(!recoverable.items.some(item=>item.id===uncertainTurn.turn.id))
    for(const item of recoverable.items)await db.releaseRecoveryClaim(item.id,'qa-retention-page')
    await db.applyShoppingCartAction(jid,'add',[{sku:'QA-PROD-1',quantity:1}],`turn:${pendingTurn.turn.id}:cart`)
    assert.equal((await db.getShoppingCart(jid)).find((item:any)=>item.sku==='QA-PROD-1')!.quantity,quantityBeforeCleanup)

    const rollbackTurn=await db.claimConversationTurn(jid,'cleanup-rollback',1)
    await db.applyShoppingCartAction(jid,'add',[{sku:'QA-PROD-1',quantity:1}],`turn:${rollbackTurn.turn.id}:cart`)
    await db.prepareConversationReply(rollbackTurn.turn.id,'cart_applied','Rollback','retention-rollback-out',true)
    assert.equal(await db.beginConversationTurnSend(rollbackTurn.turn.id),true)
    await db.markConversationTurnSent(rollbackTurn.turn.id)
    await db.pool.query('UPDATE conversation_turns SET created_at=?,updated_at=? WHERE id=?',[oldDate,oldDate,rollbackTurn.turn.id])
    await db.pool.query('UPDATE conversation_effects SET created_at=? WHERE effect_key=?',[oldDate,`turn:${rollbackTurn.turn.id}:cart`])
    await db.pool.query(`CREATE TRIGGER qa_block_turn_cleanup BEFORE DELETE ON conversation_turns FOR EACH ROW
      BEGIN IF OLD.wa_message_id='cleanup-rollback' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='forced cleanup interruption'; END IF; END`)
    try{await assert.rejects(db.cleanupOperationalRecords(30,10,1),/forced cleanup interruption/)}finally{await db.pool.query('DROP TRIGGER IF EXISTS qa_block_turn_cleanup')}
    assert.ok(await db.getConversationEffect(rollbackTurn.turn.id))

    const beforeBulk=await db.getRecoveryHighWaterMark()
    const bulkRows=Array.from({length:125},(_,index)=>[index%5===0?'5215500001002@s.whatsapp.net':jid,`bulk-recovery-${index}`,1])
    await db.pool.query("INSERT INTO conversation_turns (jid,wa_message_id,status,settings_version) VALUES ?",[bulkRows.map(row=>[row[0],row[1],'processing',row[2]])])
    const throughBulk=await db.getRecoveryHighWaterMark(),bulkIds:number[]=[]
    const [claimA,claimB]=await Promise.all([
      db.claimRecoverableConversationTurnsPage(beforeBulk,throughBulk,17,'qa-concurrent-a',120,0),
      db.claimRecoverableConversationTurnsPage(beforeBulk,throughBulk,17,'qa-concurrent-b',120,0),
    ])
    assert.equal(claimA.items.some(item=>claimB.items.some(other=>other.id===item.id)),false)
    for(const item of claimA.items)await db.releaseRecoveryClaim(item.id,'qa-concurrent-a')
    for(const item of claimB.items)await db.releaseRecoveryClaim(item.id,'qa-concurrent-b')
    let cursor=beforeBulk
    while(cursor<throughBulk){
      const page=await db.claimRecoverableConversationTurnsPage(cursor,throughBulk,17,'qa-bulk-page',120,0)
      assert.ok(page.items.length<=17)
      bulkIds.push(...page.items.map(item=>item.id));cursor=page.nextCursor
      for(const item of page.items)await db.releaseRecoveryClaim(item.id,'qa-bulk-page')
      if(page.done)break
    }
    assert.equal(new Set(bulkIds).size,125)

    const reconcileTurn=await db.claimConversationTurn(jid,'reconcile-uncertain',1)
    await db.prepareConversationReply(reconcileTurn.turn.id,'test','Reconciliar','reconcile-outbound-id')
    assert.equal(await db.beginConversationTurnSend(reconcileTurn.turn.id),true)
    await db.markConversationTurnUncertain(reconcileTurn.turn.id)
    assert.equal(await db.markConversationTurnSentByOutboundId('reconcile-outbound-id'),true)
    const [[reconciled]]:any=await db.pool.execute('SELECT status FROM conversation_turns WHERE id=?',[reconcileTurn.turn.id])
    assert.equal(reconciled.status,'sent')

    const secondJid='5215500001002@s.whatsapp.net'
    const deletionTurn=await db.claimConversationTurn(secondJid,'delete-with-contact',1)
    await db.prepareConversationReply(deletionTurn.turn.id,'test','Dato por borrar','delete-outbound-id')
    result=await request(`/api/contacts/${secondContactId}`,'DELETE')
    assert.equal(result.response.status,200)
    const [[remainingTurn]]:any=await db.pool.execute('SELECT COUNT(*) AS total FROM conversation_turns WHERE jid=?',[secondJid])
    assert.equal(Number(remainingTurn.total),0)

    const [beforeClearRows]:any=await db.pool.query(`SELECT
      (SELECT COUNT(*) FROM contacts) AS contacts,(SELECT COUNT(*) FROM appointments) AS appointments,
      (SELECT COUNT(*) FROM orders) AS orders,(SELECT COUNT(*) FROM inventory_items) AS inventory`)
    assert.ok(Number(beforeClearRows[0].contacts)>0)
    await db.persistMessage({jid,waMessageId:'clear-history-qa',fromMe:false,displayName:'Contacto QA',messageType:'conversation',text:'Mensaje para probar el vaciado',timestamp:new Date(),deleted:false,rawPayload:{conversation:'Mensaje para probar el vaciado'}})
    const rejectedClear=await request('/api/conversations/clear','POST',{confirm:'NO'})
    assert.equal(rejectedClear.response.status,400)
    const cleared=await request('/api/conversations/clear','POST',{confirm:'VACIAR'})
    assert.equal(cleared.response.status,200)
    assert.ok(cleared.payload.messages>0)
    const [afterClearRows]:any=await db.pool.query(`SELECT
      (SELECT COUNT(*) FROM contacts) AS contacts,(SELECT COUNT(*) FROM appointments) AS appointments,
      (SELECT COUNT(*) FROM orders) AS orders,(SELECT COUNT(*) FROM inventory_items) AS inventory,
      (SELECT COUNT(*) FROM chats) AS chats,(SELECT COUNT(*) FROM messages) AS messages,
      (SELECT COUNT(*) FROM conversation_turns) AS turns,(SELECT COUNT(*) FROM conversation_effects) AS effects,
      (SELECT COUNT(*) FROM pending_intents) AS pendingIntents`)
    assert.equal(Number(afterClearRows[0].contacts),Number(beforeClearRows[0].contacts))
    assert.equal(Number(afterClearRows[0].appointments),Number(beforeClearRows[0].appointments))
    assert.equal(Number(afterClearRows[0].orders),Number(beforeClearRows[0].orders))
    assert.equal(Number(afterClearRows[0].inventory),Number(beforeClearRows[0].inventory))
    for(const field of ['chats','messages','turns','effects','pendingIntents'])assert.equal(Number(afterClearRows[0][field]),0,field)

    assert.equal(sentMessages.length,2)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await db.closePool()
  }
})
