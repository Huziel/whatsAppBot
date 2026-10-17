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
  await db.assertPublicOrderSchema()
  const { launchDashboardServer } = await import('../src/http/server')
  const { resolveAppointmentStart } = await import('../src/appointment-time')

  const fallback = {
    botName: 'Bot de prueba', businessName: 'Negocio de prueba', autoReply: false,
    responseMode: 'fixed' as const, responseText: 'Respuesta simulada', replyDelayMs: 1500,
    saveToDatabase: true, deepseekApiKey: '', deepseekModel: 'deepseek-flash' as const,
    aiTone: 'professional' as const, aiResponseLength: 'brief' as const, aiSystemInstructions: '',
    maxRepliesPerHour: 20, messageRetentionDays: 0, orderReservationMinutes:15,productCatalogImageUrl: null,
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

  for (const table of ['conversation_effects','conversation_turns','pending_intents','inventory_movements','inventory_reservations','order_items','orders','shopping_cart_items','shopping_carts','appointments','chat_settings','messages','chats','contact_profiles','contact_identifiers','contacts','inventory_items']) {
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
    assert.equal(loginPage.headers.get('cache-control'),'no-cache')
    const publicMenuPage=await fetch('http://127.0.0.1:3100/menu')
    assert.equal(publicMenuPage.status,200);assert.match(await publicMenuPage.text(),/id="checkoutForm"/)
    const loginScript=await fetch('http://127.0.0.1:3100/js/login.js')
    assert.match(await loginScript.text(),/no conservó la sesión/)
    assert.equal(loginScript.headers.get('cache-control'),'no-cache')
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
    assert.equal(badLogin.response.status,401)
    assert.equal(badLogin.payload.error.code,'INVALID_CREDENTIALS')
    assert.equal(typeof badLogin.payload.error.requestId,'string')
    const logout=await request('/api/auth/logout','POST',{})
    assert.equal(logout.response.status,200)
    const loggedOutSettings=await request('/api/settings')
    assert.equal(loggedOutSettings.response.status,401)
    const loggedIn=await request('/api/auth/login','POST',{username:'admin-qa',password:'password-de-prueba-segura'})
    assert.equal(loggedIn.response.status,200)
    sessionCookie=loggedIn.response.headers.get('set-cookie')!.split(';')[0]
    const staleCookie=await fetch('http://127.0.0.1:3100/api/settings',{headers:{cookie:'wa_dashboard_session=invalid'}})
    assert.equal(staleCookie.status,401)
    const staleStatus=await fetch('http://127.0.0.1:3100/api/auth/status',{headers:{cookie:'wa_dashboard_session=invalid'}})
    assert.equal((await staleStatus.json() as any).authenticated,false)
    const authenticatedLoginPage=await fetch('http://127.0.0.1:3100/login.html',{headers:{cookie:sessionCookie},redirect:'manual'})
    assert.equal(authenticatedLoginPage.status,302);assert.equal(authenticatedLoginPage.headers.get('location'),'/')
    const dashboardAfterReload=await fetch('http://127.0.0.1:3100/',{headers:{cookie:sessionCookie}})
    assert.equal(dashboardAfterReload.status,200);assert.match(await dashboardAfterReload.text(),/id="view-dashboard"/)

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
    const bulkImport=await request('/api/contacts/import','POST',{contacts:[
      {phoneNumber:'+52 1 550 001 020',customName:'CRM Ana',tags:'cliente',notes:'Importación QA'},
      {phoneNumber:'521550001020',customName:'Duplicado interno',tags:'',notes:''},
      {phoneNumber:'521550001021',customName:'CRM Luis',tags:'prospecto',notes:''},
    ]})
    assert.equal(bulkImport.response.status,200)
    assert.deepEqual({created:bulkImport.payload.created,updated:bulkImport.payload.updated,duplicates:bulkImport.payload.duplicates},{created:2,updated:0,duplicates:1})
    const importedContacts=await db.listContacts(1,100,'CRM Ana')
    assert.equal(importedContacts.rows.length,1);assert.equal(importedContacts.rows[0].phoneNumber,'521550001020')
    const updateImported=await request(`/api/contacts/${importedContacts.rows[0].contactId}/profile`,'PATCH',{phoneNumber:'+521550001030',customName:'Ana editada',tags:'vip',notes:'Editada'})
    assert.equal(updateImported.response.status,200)
    const editedContacts=await db.listContacts(1,100,'Ana editada')
    assert.equal(editedContacts.rows[0].phoneNumber,'521550001030')
    const duplicatePhoneUpdate=await request(`/api/contacts/${editedContacts.rows[0].contactId}/profile`,'PATCH',{phoneNumber:'521550001021',customName:'Ana editada',tags:'vip',notes:'Editada'})
    assert.equal(duplicatePhoneUpdate.response.status,409);assert.equal(duplicatePhoneUpdate.payload.error.code,'CONTACT_PHONE_IN_USE')
    const sharedLid='987654321098765@lid',sharedPhoneJid='5215500098765@s.whatsapp.net'
    await db.upsertContactIdentity({jid:sharedLid,lid:sharedLid,name:'Contacto LID verificado'})
    const unresolvedContacts=await db.listContacts(1,100,'Contacto LID verificado')
    assert.equal(unresolvedContacts.rows[0].phoneNumber,null)
    await db.upsertContactIdentity({jid:sharedPhoneJid,lid:sharedLid,phoneJid:sharedPhoneJid,name:'Contacto LID verificado'})
    const resolvedContacts=await db.listContacts(1,100,'Contacto LID verificado')
    assert.equal(resolvedContacts.rows.length,1)
    assert.equal(resolvedContacts.rows[0].phoneNumber,'5215500098765')
    assert.equal(resolvedContacts.rows[0].identityStatus,'resolved')
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
    result = await request('/api/contacts?search=Contacto QA editado')
    assert.equal(result.payload.total, 1)
    assert.equal(result.payload.rows[0].customName, 'Contacto QA editado')

    const product = (await request('/api/inventory', 'POST', { itemType: 'product', sku: 'QA-PROD-1', name: 'Producto QA', description: 'Inicial', imageUrl: 'https://example.com/qa-product.png', price: '125.50', currency: 'MXN', stockQuantity: 10, isActive: true })).payload
    assert.equal(await db.getActiveInventoryImageUrl('QA-PROD-1'),'https://example.com/qa-product.png')
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
    result = await request(`/api/orders/${orderId}`, 'PATCH', { status: 'confirmed' })
    assert.equal(result.response.status,200);assert.equal(result.payload.duplicate,true)
    await db.applyShoppingCartAction(jid, 'add', [{ sku: 'QA-PROD-1', quantity: 1 }])
    orderId = Number((await request(`/api/carts/${contactId}/orders`, 'POST')).payload.orderId)
    result = await request(`/api/orders/${orderId}`, 'PATCH', { status: 'cancelled' })
    assert.equal(result.response.status, 200)
    result = await request(`/api/orders/${orderId}`, 'PATCH', { status: 'cancelled' })
    assert.equal(result.response.status,200);assert.equal(result.payload.duplicate,true)
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
    await db.savePendingIntent(jid,{intent:{kind:'inventory_selected',sku:'QA-PROD-1',name:'Producto QA editado',expiresAt:new Date(Date.now()+60_000).toISOString()},sourceMessageId:'duplicate-message'})
    await db.applyShoppingCartAction(jid,'add',[{sku:'QA-PROD-1',quantity:1}],`turn:${firstClaim.turn.id}:cart`,'duplicate-message')
    assert.equal(await db.getPendingIntent(jid),null)
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

    const whatsappProduct=(await request('/api/inventory','POST',{itemType:'product',sku:'QA-WHATSAPP-ORDER',name:'Pedido por WhatsApp',description:'Checkout conversacional',imageUrl:null,price:'75.00',currency:'MXN',stockQuantity:5,isActive:true})).payload
    await db.applyShoppingCartAction(jid,'add',[{sku:'QA-WHATSAPP-ORDER',quantity:2}])
    const whatsappSnapshot=await db.getShoppingCart(jid)
    const whatsappTurn=await db.claimConversationTurn(jid,'whatsapp-checkout-confirmation',1)
    const whatsappEffectKey=`turn:${whatsappTurn.turn.id}:pending-order-create`
    await db.savePendingIntent(jid,{intent:{kind:'checkout_confirmation',cart:whatsappSnapshot,reservationMinutes:15,expiresAt:new Date(Date.now()+60_000).toISOString()},sourceMessageId:'whatsapp-checkout-confirmation'})
    const whatsappOrder=await db.createWhatsAppOrderFromCartVerified(jid,15,whatsappSnapshot,whatsappEffectKey,'whatsapp-checkout-confirmation')
    assert.equal(whatsappOrder.status,'success')
    if(whatsappOrder.status==='success'){
      assert.match(whatsappOrder.value.publicId,/^WA-/)
      assert.equal(whatsappOrder.value.duplicate,false)
      const duplicate=await db.createWhatsAppOrderFromCartVerified(jid,15,whatsappSnapshot,whatsappEffectKey)
      assert.equal(duplicate.status,'success')
      if(duplicate.status==='success'){assert.equal(duplicate.value.orderId,whatsappOrder.value.orderId);assert.equal(duplicate.value.duplicate,true)}
      const [[created]]:any=await db.pool.execute('SELECT source,reservation_status AS reservationStatus FROM orders WHERE id=?',[whatsappOrder.value.orderId])
      assert.equal(created.source,'whatsapp');assert.equal(created.reservationStatus,'active')
    }
    assert.equal((await db.getShoppingCart(jid)).length,0)
    assert.equal(await db.getPendingIntent(jid),null)
    assert.equal((await db.getConversationEffect(whatsappTurn.turn.id))?.effectType,'order:create')
    const [[whatsappReserved]]:any=await db.pool.execute('SELECT reserved_quantity AS reserved FROM inventory_items WHERE id=?',[whatsappProduct.id])
    assert.equal(Number(whatsappReserved.reserved),2)

    await db.applyShoppingCartAction(jid,'add',[{sku:'QA-WHATSAPP-ORDER',quantity:1}])
    const staleSnapshot=await db.getShoppingCart(jid)
    await db.applyShoppingCartAction(jid,'add',[{sku:'QA-WHATSAPP-ORDER',quantity:1}])
    const changedTurn=await db.claimConversationTurn(jid,'whatsapp-checkout-cart-changed',1)
    const changedOrder=await db.createWhatsAppOrderFromCartVerified(jid,15,staleSnapshot,`turn:${changedTurn.turn.id}:pending-order-create`)
    assert.equal(changedOrder.status,'rejected')
    assert.match(changedOrder.status==='rejected'?changedOrder.message:'',/carrito cambió/i)
    const [[whatsappOrderCount]]:any=await db.pool.execute("SELECT COUNT(*) AS total FROM orders WHERE source='whatsapp'")
    assert.equal(Number(whatsappOrderCount.total),1)
    await db.applyShoppingCartAction(jid,'clear',[])
    await db.savePendingIntent(jid,{intent:{kind:'inventory_selected',sku:'QA-PROD-1',name:'Producto QA editado',expiresAt:new Date(Date.now()+60_000).toISOString()},sourceMessageId:'newer-context'})
    await db.clearPendingIntentBySource(jid,'older-recovered-turn')
    assert.equal((await db.getPendingIntent(jid))?.sourceMessageId,'newer-context')
    await db.clearPendingIntent(jid)

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
    const deletionStock=(await request('/api/inventory','POST',{itemType:'product',sku:'QA-DELETE-RESERVED',name:'Reserva por borrar',description:'',imageUrl:null,price:'15.00',currency:'MXN',stockQuantity:2,isActive:true})).payload
    await db.applyShoppingCartAction(secondJid,'add',[{sku:'QA-DELETE-RESERVED',quantity:1}],'delete-reservation-cart')
    await db.createOrderFromCart(secondContactId)
    const [[reservedBeforeDeletion]]:any=await db.pool.execute('SELECT reserved_quantity AS reserved FROM inventory_items WHERE id=?',[deletionStock.id])
    assert.equal(Number(reservedBeforeDeletion.reserved),1)
    result=await request(`/api/contacts/${secondContactId}`,'DELETE')
    assert.equal(result.response.status,200)
    const [[remainingTurn]]:any=await db.pool.execute('SELECT COUNT(*) AS total FROM conversation_turns WHERE jid=?',[secondJid])
    assert.equal(Number(remainingTurn.total),0)
    const [[releasedAfterDeletion]]:any=await db.pool.execute('SELECT reserved_quantity AS reserved FROM inventory_items WHERE id=?',[deletionStock.id])
    assert.equal(Number(releasedAfterDeletion.reserved),0)
    const [[deletionRelease]]:any=await db.pool.execute("SELECT COUNT(*) AS total FROM inventory_movements WHERE inventory_item_id=? AND movement_type='release'",[deletionStock.id])
    assert.equal(Number(deletionRelease.total),1)

    const publicMenu=await fetch('http://127.0.0.1:3100/api/public/menu')
    assert.equal(publicMenu.status,200)
    const menuPayload:any=await publicMenu.json()
    assert.equal(menuPayload.items.some((item:any)=>item.sku==='QA-PROD-1'),true)
    assert.equal('nextCursor' in menuPayload,true)
    assert.equal((await fetch('http://127.0.0.1:3100/api/public/menu?after=invalid')).status,400)
    const orderKey='00000000-0000-4000-8000-000000000123',accessToken='A'.repeat(43)
    const publicOrderBody={orderKey,accessToken,customerName:'Cliente del menú',phoneNumber:'+52 15550009999',items:[{sku:'QA-PROD-1',quantity:2}]}
    const publicOrder=await fetch('http://127.0.0.1:3100/api/public/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(publicOrderBody)})
    assert.equal(publicOrder.status,201)
    const publicOrderResult:any=await publicOrder.json()
    assert.equal(publicOrderResult.status,'pending');assert.equal(publicOrderResult.paymentStatus,'unpaid');assert.equal(publicOrderResult.total,'260.00');assert.equal(publicOrderResult.currency,'MXN');assert.match(publicOrderResult.publicId,/^WA-[0-9A-HJKMNP-TV-Z]{12}$/)
    const [[publicIdentity]]:any=await db.pool.execute(`SELECT c.identity_status AS identityStatus,o.customer_name AS customerName,
      (SELECT COUNT(*) FROM contact_identifiers i WHERE i.contact_id=c.id) AS identifiers FROM orders o JOIN contacts c ON c.id=o.contact_id WHERE o.public_id=?`,[publicOrderResult.publicId])
    assert.equal(publicIdentity.identityStatus,'unresolved');assert.equal(publicIdentity.customerName,'Cliente del menú');assert.equal(Number(publicIdentity.identifiers),0)
    const duplicatePublicOrder=await fetch('http://127.0.0.1:3100/api/public/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(publicOrderBody)})
    assert.equal(duplicatePublicOrder.status,200)
    assert.equal((await duplicatePublicOrder.json() as any).publicId,publicOrderResult.publicId)
    const changedIdempotentBody=await fetch('http://127.0.0.1:3100/api/public/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...publicOrderBody,items:[{sku:'QA-PROD-1',quantity:1}]})})
    assert.equal(changedIdempotentBody.status,409)
    const changedIdempotentError:any=await changedIdempotentBody.json();assert.equal(changedIdempotentError.error.code,'IDEMPOTENCY_KEY_REUSED');assert.equal(typeof changedIdempotentError.error.requestId,'string')
    const publicLookup=await fetch(`http://127.0.0.1:3100/api/public/orders/${publicOrderResult.publicId}`,{headers:{authorization:`Bearer ${accessToken}`}})
    assert.equal(publicLookup.status,200)
    const publicLookupBody:any=await publicLookup.json()
    assert.deepEqual(new Set(Object.keys(publicLookupBody)),new Set(['publicId','status','paymentStatus','total','currency','createdAt','expiresAt','confirmedAt','cancelledAt','expiredAt','items']))
    assert.equal(JSON.stringify(publicLookupBody).includes('521550009999'),false)
    assert.equal('id' in publicLookupBody,false);assert.equal('contactId' in publicLookupBody,false);assert.equal('jid' in publicLookupBody,false)
    const wrongLookup=await fetch(`http://127.0.0.1:3100/api/public/orders/${publicOrderResult.publicId}`,{headers:{authorization:`Bearer ${'B'.repeat(43)}`}})
    const unknownLookup=await fetch('http://127.0.0.1:3100/api/public/orders/WA-000000000000',{headers:{authorization:`Bearer ${'B'.repeat(43)}`}})
    assert.equal(wrongLookup.status,404);assert.equal(unknownLookup.status,404)
    assert.equal((await wrongLookup.json() as any).error.code,(await unknownLookup.json() as any).error.code)
    const crossOriginOrder=await fetch('http://127.0.0.1:3100/api/public/orders',{method:'POST',headers:{'content-type':'application/json','origin':'https://attacker.example','sec-fetch-site':'cross-site'},body:JSON.stringify({...publicOrderBody,orderKey:'00000000-0000-4000-8000-000000000124'})})
    assert.equal(crossOriginOrder.status,403)

    await db.pool.execute("UPDATE contacts SET display_name='Nombre verificado' WHERE id=?",[contactId])
    const untrustedNameOrder=await fetch('http://127.0.0.1:3100/api/public/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({orderKey:'00000000-0000-4000-8000-000000000125',accessToken:'N'.repeat(43),customerName:'Nombre no verificado',phoneNumber:'+5215500001001',items:[{sku:'QA-SERV-1',quantity:1}]})})
    assert.equal(untrustedNameOrder.status,201)
    const [[trustedContact]]:any=await db.pool.execute('SELECT display_name AS displayName FROM contacts WHERE id=?',[contactId]);assert.equal(trustedContact.displayName,'Nombre verificado')

    const malformedJson=await fetch('http://127.0.0.1:3100/api/public/orders',{method:'POST',headers:{'content-type':'application/json'},body:'{"items":'})
    assert.equal(malformedJson.status,400);const malformedBody:any=await malformedJson.json();assert.equal(malformedBody.error.code,'INVALID_JSON');assert.equal(malformedJson.headers.get('x-request-id'),malformedBody.error.requestId)

    const createStockItem=async(sku:string,stockQuantity:number)=>Number((await request('/api/inventory','POST',{itemType:'product',sku,name:sku,description:'Prueba transaccional',imageUrl:null,price:'10.00',currency:'MXN',stockQuantity,isActive:true})).payload.id)
    const checkout=async(key:string,token:string,phoneNumber:string,items:any[])=>{
      const response=await fetch('http://127.0.0.1:3100/api/public/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({orderKey:key,accessToken:token,customerName:'Prueba transaccional',phoneNumber,items})})
      const payload:any=await response.json();return {response,payload}
    }

    const singleStockId=await createStockItem('QA-STOCK-ONE',1)
    const [[initialAdjustment]]:any=await db.pool.execute("SELECT COUNT(*) AS total FROM inventory_movements WHERE inventory_item_id=? AND movement_type='adjustment'",[singleStockId]);assert.equal(Number(initialAdjustment.total),1)
    const concurrentOrders=await Promise.all([
      checkout('10000000-0000-4000-8000-000000000001','C'.repeat(43),'+5215551000001',[{sku:'QA-STOCK-ONE',quantity:1}]),
      checkout('10000000-0000-4000-8000-000000000002','D'.repeat(43),'+5215551000002',[{sku:'QA-STOCK-ONE',quantity:1}]),
    ])
    assert.deepEqual(concurrentOrders.map(item=>item.response.status).sort((a,b)=>a-b),[201,409])
    assert.equal(concurrentOrders.find(item=>item.response.status===409)!.payload.error.code,'INSUFFICIENT_STOCK')
    const [[singleStock]]:any=await db.pool.execute('SELECT stock_quantity AS stock,reserved_quantity AS reserved FROM inventory_items WHERE id=?',[singleStockId])
    assert.equal(Number(singleStock.stock),1);assert.equal(Number(singleStock.reserved),1)
    const lowerReservedStock=await request(`/api/inventory/${singleStockId}`,'PUT',{itemType:'product',sku:'QA-STOCK-ONE',name:'QA-STOCK-ONE',description:'Prueba transaccional',imageUrl:null,price:'10.00',currency:'MXN',stockQuantity:0,isActive:true})
    assert.equal(lowerReservedStock.response.status,409);assert.equal(lowerReservedStock.payload.error.code,'STOCK_BELOW_RESERVED')
    const deleteReservedStock=await request(`/api/inventory/${singleStockId}`,'DELETE')
    assert.equal(deleteReservedStock.response.status,409);assert.equal(deleteReservedStock.payload.error.code,'ITEM_HAS_RESERVATIONS')

    const retryStockId=await createStockItem('QA-IDEMPOTENT-CONCURRENT',2)
    const retryBody=['60000000-0000-4000-8000-000000000001','J'.repeat(43),'+5215556000001',[{sku:'QA-IDEMPOTENT-CONCURRENT',quantity:1}]] as const
    const concurrentRetries=await Promise.all([checkout(...retryBody),checkout(...retryBody)])
    assert.deepEqual(concurrentRetries.map(item=>item.response.status).sort((a,b)=>a-b),[200,201])
    assert.equal(new Set(concurrentRetries.map(item=>item.payload.publicId)).size,1)
    const [[retryStock]]:any=await db.pool.execute('SELECT reserved_quantity AS reserved FROM inventory_items WHERE id=?',[retryStockId]);assert.equal(Number(retryStock.reserved),1)
    const [[retryOrders]]:any=await db.pool.execute("SELECT COUNT(*) AS total FROM orders WHERE public_order_key='60000000-0000-4000-8000-000000000001'");assert.equal(Number(retryOrders.total),1)

    const sharedId=await createStockItem('QA-MULTI-SHARED',1),branchAId=await createStockItem('QA-MULTI-BRANCH-A',1),branchBId=await createStockItem('QA-MULTI-BRANCH-B',1)
    const concurrentMulti=await Promise.all([
      checkout('70000000-0000-4000-8000-000000000001','K'.repeat(43),'+5215557000001',[{sku:'QA-MULTI-SHARED',quantity:1},{sku:'QA-MULTI-BRANCH-A',quantity:1}]),
      checkout('70000000-0000-4000-8000-000000000002','L'.repeat(43),'+5215557000002',[{sku:'QA-MULTI-SHARED',quantity:1},{sku:'QA-MULTI-BRANCH-B',quantity:1}]),
    ])
    assert.deepEqual(concurrentMulti.map(item=>item.response.status).sort((a,b)=>a-b),[201,409])
    const [multiStock]:any=await db.pool.execute('SELECT id,reserved_quantity AS reserved FROM inventory_items WHERE id IN (?,?,?) ORDER BY id',[sharedId,branchAId,branchBId])
    assert.equal(Number(multiStock.find((item:any)=>Number(item.id)===sharedId).reserved),1)
    assert.equal(multiStock.reduce((sum:number,item:any)=>sum+Number(item.reserved),0),2)

    const rollbackAId=await createStockItem('QA-ROLLBACK-A',2),rollbackBId=await createStockItem('QA-ROLLBACK-B',0)
    const rollbackOrder=await checkout('20000000-0000-4000-8000-000000000001','E'.repeat(43),'+5215552000001',[{sku:'QA-ROLLBACK-A',quantity:1},{sku:'QA-ROLLBACK-B',quantity:1}])
    assert.equal(rollbackOrder.response.status,409);assert.equal(rollbackOrder.payload.error.code,'INSUFFICIENT_STOCK')
    const [rollbackStock]:any=await db.pool.execute('SELECT id,reserved_quantity AS reserved FROM inventory_items WHERE id IN (?,?) ORDER BY id',[rollbackAId,rollbackBId])
    assert.deepEqual(rollbackStock.map((item:any)=>Number(item.reserved)),[0,0])
    const [[rolledBackOrder]]:any=await db.pool.execute("SELECT COUNT(*) AS total FROM orders WHERE public_order_key='20000000-0000-4000-8000-000000000001'")
    assert.equal(Number(rolledBackOrder.total),0)

    const cancelStockId=await createStockItem('QA-CANCEL',2)
    const cancellable=await checkout('30000000-0000-4000-8000-000000000001','F'.repeat(43),'+5215553000001',[{sku:'QA-CANCEL',quantity:1}])
    assert.equal(cancellable.response.status,201)
    const [[cancelOrderRow]]:any=await db.pool.execute('SELECT id FROM orders WHERE public_id=?',[cancellable.payload.publicId])
    assert.equal((await request(`/api/orders/${cancelOrderRow.id}`,'PATCH',{status:'cancelled'})).response.status,200)
    const duplicateCancellation=await request(`/api/orders/${cancelOrderRow.id}`,'PATCH',{status:'cancelled'})
    assert.equal(duplicateCancellation.response.status,200);assert.equal(duplicateCancellation.payload.duplicate,true)
    const [[cancelStock]]:any=await db.pool.execute('SELECT stock_quantity AS stock,reserved_quantity AS reserved FROM inventory_items WHERE id=?',[cancelStockId])
    assert.equal(Number(cancelStock.stock),2);assert.equal(Number(cancelStock.reserved),0)
    const [[releaseCount]]:any=await db.pool.execute("SELECT COUNT(*) AS total FROM inventory_movements WHERE order_id=? AND movement_type='release'",[cancelOrderRow.id]);assert.equal(Number(releaseCount.total),1)

    const confirmStockId=await createStockItem('QA-CONFIRM',2)
    const confirmable=await checkout('40000000-0000-4000-8000-000000000001','G'.repeat(43),'+5215554000001',[{sku:'QA-CONFIRM',quantity:1}])
    const [[confirmOrderRow]]:any=await db.pool.execute('SELECT id FROM orders WHERE public_id=?',[confirmable.payload.publicId])
    assert.equal((await request(`/api/orders/${confirmOrderRow.id}`,'PATCH',{status:'confirmed'})).response.status,200)
    const duplicateConfirmation=await request(`/api/orders/${confirmOrderRow.id}`,'PATCH',{status:'confirmed'})
    assert.equal(duplicateConfirmation.response.status,200);assert.equal(duplicateConfirmation.payload.duplicate,true)
    const [[confirmStock]]:any=await db.pool.execute('SELECT stock_quantity AS stock,reserved_quantity AS reserved FROM inventory_items WHERE id=?',[confirmStockId])
    assert.equal(Number(confirmStock.stock),1);assert.equal(Number(confirmStock.reserved),0)
    const [[saleCount]]:any=await db.pool.execute("SELECT COUNT(*) AS total FROM inventory_movements WHERE order_id=? AND movement_type='sale'",[confirmOrderRow.id]);assert.equal(Number(saleCount.total),1)
    for(const status of ['preparing','ready','out_for_delivery','completed'])assert.equal((await request(`/api/orders/${confirmOrderRow.id}`,'PATCH',{status})).response.status,200)
    const completedLookup=await fetch(`http://127.0.0.1:3100/api/public/orders/${confirmable.payload.publicId}`,{headers:{authorization:`Bearer ${'G'.repeat(43)}`}})
    assert.equal((await completedLookup.json() as any).status,'completed')

    const expireStockId=await createStockItem('QA-EXPIRE',2)
    const expirable=await checkout('50000000-0000-4000-8000-000000000001','H'.repeat(43),'+5215555000001',[{sku:'QA-EXPIRE',quantity:1}])
    const [[expireOrderRow]]:any=await db.pool.execute('SELECT id FROM orders WHERE public_id=?',[expirable.payload.publicId])
    await db.pool.execute("UPDATE orders SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?",[expireOrderRow.id])
    const confirmExpired=await request(`/api/orders/${expireOrderRow.id}`,'PATCH',{status:'confirmed'})
    assert.equal(confirmExpired.response.status,409);assert.equal(confirmExpired.payload.error.code,'ORDER_EXPIRED')
    const [[expiredOnTransition]]:any=await db.pool.execute('SELECT status,reservation_status AS reservationStatus FROM orders WHERE id=?',[expireOrderRow.id])
    assert.equal(expiredOnTransition.status,'expired');assert.equal(expiredOnTransition.reservationStatus,'expired')
    const [[expireStock]]:any=await db.pool.execute('SELECT stock_quantity AS stock,reserved_quantity AS reserved FROM inventory_items WHERE id=?',[expireStockId])
    assert.equal(Number(expireStock.stock),2);assert.equal(Number(expireStock.reserved),0)

    const workerExpireStockId=await createStockItem('QA-EXPIRE-WORKER',2)
    const workerExpirable=await checkout('50000000-0000-4000-8000-000000000002','M'.repeat(43),'+5215555000002',[{sku:'QA-EXPIRE-WORKER',quantity:1}])
    const [[workerExpireOrder]]:any=await db.pool.execute('SELECT id FROM orders WHERE public_id=?',[workerExpirable.payload.publicId])
    await db.pool.execute("UPDATE orders SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?",[workerExpireOrder.id])
    assert.equal(await db.expireOrderReservations(),1);assert.equal(await db.expireOrderReservations(),0)
    const [[workerStock]]:any=await db.pool.execute('SELECT stock_quantity AS stock,reserved_quantity AS reserved FROM inventory_items WHERE id=?',[workerExpireStockId])
    assert.equal(Number(workerStock.stock),2);assert.equal(Number(workerStock.reserved),0)

    const [legacyInsert]:any=await db.pool.execute("INSERT INTO orders (contact_id,status,total,currency) VALUES (?,'pending','10.00','MXN')",[contactId])
    assert.equal((await request(`/api/orders/${legacyInsert.insertId}`,'PATCH',{status:'confirmed'})).response.status,200)
    const [[legacyOrder]]:any=await db.pool.execute('SELECT status,reservation_status AS reservationStatus FROM orders WHERE id=?',[legacyInsert.insertId])
    assert.equal(legacyOrder.status,'confirmed');assert.equal(legacyOrder.reservationStatus,'none')

    let throttled:any
    for(let attempt=1;attempt<=21;attempt++){
      const response=await fetch('http://127.0.0.1:3100/api/public/orders',{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':'203.0.113.10'},body:JSON.stringify({orderKey:`80000000-0000-4000-8000-${String(attempt).padStart(12,'0')}`,accessToken:'P'.repeat(43),customerName:'Rate limit',phoneNumber:'+5215558000001',items:[{sku:'NO-EXISTE',quantity:1}]})})
      const payload:any=await response.json();if(attempt<=20)assert.equal(response.status,409);else throttled={response,payload}
    }
    assert.equal(throttled.response.status,429);assert.equal(throttled.payload.error.code,'CHECKOUT_RATE_LIMITED');assert.equal(throttled.response.headers.get('retry-after'),'3600')

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
