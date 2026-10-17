import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { config } from '../src/config'
import { loadAppSettings } from '../src/ui/settings'
import { generateDeepSeekResponse } from '../src/deepseek'
import { authorizeCartMutation, classifyPendingInput, detectCartAction, detectCheckoutRequest, formatCheckoutConfirmation, formatVerifiedCart, inventorySelectionIndex, isInventoryRecommendationQuestion, PendingIntent, wantsToBuySelectedItem } from '../src/conversation-flow'
import { finalizeProviderConversation, formatVerifiedRecommendations, resolveDeterministicReply } from '../src/conversation-reply'
import type { ConversationTurn } from '../src/conversation'

const sourceDatabase=config.db.database
const testDatabase=process.env.LIVE_CHAT_TEST_DB??''
if(sourceDatabase!=='whatsapp_local')throw new Error('La simulación requiere cargar la configuración de DeepSeek desde whatsapp_local antes de conectar el pool aislado.')
if(!/^whatsapp_test_[a-z0-9_]+$/.test(testDatabase)||testDatabase===sourceDatabase)throw new Error('Define LIVE_CHAT_TEST_DB con una base aislada que empiece por whatsapp_test_.')

const fallback={
  botName:'Asistente de pruebas',businessName:'Tienda QA',autoReply:true,responseMode:'deepseek' as const,responseText:'',replyDelayMs:1500,saveToDatabase:true,
  deepseekApiKey:'',deepseekModel:'deepseek-flash' as const,aiTone:'friendly' as const,aiResponseLength:'brief' as const,aiSystemInstructions:'',maxRepliesPerHour:20,messageRetentionDays:0,orderReservationMinutes:15,
  productCatalogImageUrl:null,serviceCatalogImageUrl:null,transferEnabled:false,transferBankName:'',transferAccountHolder:'',transferAccountNumber:'',transferClabe:'',transferInstructions:'',
  appointmentsEnabled:false,appointmentTimeZone:'America/Mexico_City',appointmentDays:[1,2,3,4,5],appointmentStartTime:'09:00',appointmentEndTime:'17:00',appointmentDurationMinutes:60,
}

async function main():Promise<void>{
const settings=await loadAppSettings(fallback)
if(!settings.deepseekApiKey)throw new Error('No hay una API key de DeepSeek configurada en los ajustes locales.')
if(settings.responseMode!=='deepseek')throw new Error('El modo de respuesta configurado no es DeepSeek.')

config.db.database=testDatabase
const db=await import('../src/db')
await db.assertConversationEngineSchema()
await db.assertPublicOrderSchema()

const suffix=Date.now().toString(36).toUpperCase()
const runId=randomUUID()
const jid=`521${String(Date.now()).slice(-10)}@s.whatsapp.net`
const items=[
  {itemType:'product' as const,sku:`QA-COMFORT-${suffix}`,name:`Audífonos Comfort ${suffix}`,description:'Diseñados para comodidad durante jornadas largas y videollamadas; micrófono integrado.',imageUrl:null,price:'899.00',currency:'MXN',stockQuantity:6,isActive:true},
  {itemType:'product' as const,sku:`QA-STUDIO-${suffix}`,name:`Audífonos Studio ${suffix}`,description:'Audífonos de diadema con cancelación pasiva y micrófono con reducción de ruido para reuniones.',imageUrl:null,price:'1299.00',currency:'MXN',stockQuantity:3,isActive:true},
]
const createdItems:number[]=[]
let contactId:number|null=null
let createdOrderId:number|null=null
let turnId=0
let aiCalls=0
let pending:PendingIntent|null=null
const history:Array<ConversationTurn&{timestampMs:number}>=[]
const ports={
  listInventory:()=>db.listActiveInventory(null),
  listOrders:()=>db.listOrdersForContact(jid),
}
const settingsForProvider={
  transferEnabled:settings.transferEnabled,transferBankName:settings.transferBankName,transferAccountHolder:settings.transferAccountHolder,transferAccountNumber:settings.transferAccountNumber,
  transferClabe:settings.transferClabe,transferInstructions:settings.transferInstructions,appointmentsEnabled:settings.appointmentsEnabled,appointmentTimeZone:settings.appointmentTimeZone,
  appointmentDays:settings.appointmentDays,appointmentStartTime:settings.appointmentStartTime,appointmentEndTime:settings.appointmentEndTime,
  productCatalogImageUrl:settings.productCatalogImageUrl,serviceCatalogImageUrl:settings.serviceCatalogImageUrl,
}

async function sendAsCustomer(input:string):Promise<string>{
  const messageId=`live-chat-${++turnId}`
  console.log(`\nCliente: ${input}`)
  history.push({role:'user',content:input,timestampMs:Date.now()})

  if(pending){
    const route=classifyPendingInput(pending,input)
    if(route==='cancel'){
      await db.clearPendingIntent(jid);pending=null
      history.push({role:'assistant',content:'Entendido. No realicé cambios.',timestampMs:Date.now()})
      console.log('Bot: Entendido. No realicé cambios.')
      return 'Entendido. No realicé cambios.'
    }
    if(route==='new_request'){
      if(!((pending.kind==='inventory_selection'||pending.kind==='inventory_selected')&&isInventoryRecommendationQuestion(input))){
        await db.clearPendingIntent(jid);pending=null
      }
    }
    if(pending?.kind==='inventory_selection'&&inventorySelectionIndex(input,pending.candidates)!==null){
      const choice=inventorySelectionIndex(input,pending.candidates)!
      const selected=pending.candidates[choice]
      const item=(await db.listActiveInventory(null)).find(entry=>entry.sku===selected.sku&&entry.isActive)
      if(item){
        pending={kind:'inventory_selected',sku:item.sku,name:item.name,expiresAt:new Date(Date.now()+10*60_000).toISOString()}
        await db.savePendingIntent(jid,{intent:pending,sourceMessageId:messageId})
        const response=`${item.name} (${item.sku}) — ${item.price===null?'precio por cotizar':`${item.price} ${item.currency}`} — ${item.stockQuantity===null?'existencias no controladas':`existencias: ${item.stockQuantity}`}. Si quieres agregarlo al carrito, dime “lo quiero”.`
        history.push({role:'assistant',content:response,timestampMs:Date.now()});console.log(`Bot: ${response}`);return response
      }
    }else if(pending?.kind==='inventory_selected'&&wantsToBuySelectedItem(input)){
      const result=await db.applyShoppingCartActionVerified(jid,'add',[{sku:pending.sku,quantity:1}],`live:${runId}:${messageId}:cart-add`,messageId)
      pending=null
      const response=formatVerifiedCart(result,'add')
      history.push({role:'assistant',content:response,timestampMs:Date.now()});console.log(`Bot: ${response}`);return response
    }else if(pending.kind==='checkout_confirmation'&&route==='answer'){
      const result=await db.createWhatsAppOrderFromCartVerified(jid,pending.reservationMinutes,pending.cart,`live:${runId}:${messageId}:order-create`,messageId)
      pending=null
      if(result.status==='success'){
        createdOrderId=result.value.orderId
        const response=`Pedido ${result.value.publicId} creado en estado pendiente. Total: ${result.value.total} ${result.value.currency}. No se realizó ningún cobro.`
        history.push({role:'assistant',content:response,timestampMs:Date.now()});console.log(`Bot: ${response}`);return response
      }
      history.push({role:'assistant',content:result.message,timestampMs:Date.now()});console.log(`Bot: ${result.message}`);return result.message
    }
  }

  if(detectCheckoutRequest(input)){
    const cart=await db.getShoppingCart(jid)
    const response=formatCheckoutConfirmation(cart)
    if(cart.length){
      pending={kind:'checkout_confirmation',cart,reservationMinutes:settings.orderReservationMinutes,expiresAt:new Date(Date.now()+10*60_000).toISOString()}
      await db.savePendingIntent(jid,{intent:pending,sourceMessageId:messageId})
    }
    history.push({role:'assistant',content:response,timestampMs:Date.now()});console.log(`Bot: ${response}`);return response
  }

  const action=detectCartAction(input)
  if(action!=='none'){
    const [inventory,cart]=await Promise.all([db.listActiveInventory(null),db.getShoppingCart(jid)])
    const authorization=authorizeCartMutation(input,action,[],inventory,cart)
    if(authorization.result.status==='success'){
      const result=await db.applyShoppingCartActionVerified(jid,authorization.result.value.action,authorization.result.value.items,`live:${runId}:${messageId}:cart`)
      const response=formatVerifiedCart(result,action)
      history.push({role:'assistant',content:response,timestampMs:Date.now()});console.log(`Bot: ${response}`);return response
    }
    const response=authorization.result.message
    history.push({role:'assistant',content:response,timestampMs:Date.now()});console.log(`Bot: ${response}`);return response
  }

  const deterministic=await resolveDeterministicReply(input,settingsForProvider,ports)
  if(deterministic){
    if(deterministic.inventoryCandidates?.length){
      pending={kind:'inventory_selection',candidates:deterministic.inventoryCandidates,expiresAt:new Date(Date.now()+10*60_000).toISOString()}
      await db.savePendingIntent(jid,{intent:pending,sourceMessageId:messageId})
    }else if(deterministic.selectedInventory){
      pending={kind:'inventory_selected',...deterministic.selectedInventory,expiresAt:new Date(Date.now()+10*60_000).toISOString()}
      await db.savePendingIntent(jid,{intent:pending,sourceMessageId:messageId})
    }
    history.push({role:'assistant',content:deterministic.text,timestampMs:Date.now()});console.log(`Bot [${deterministic.outcome}]: ${deterministic.text}`);return deterministic.text
  }

  const [inventory,cart]=await Promise.all([db.listActiveInventory(null),db.getShoppingCart(jid)])
  const reply=await generateDeepSeekResponse(
    settings.deepseekApiKey,settings.deepseekModel,input,inventory,cart,settings.transferEnabled,
    {enabled:settings.appointmentsEnabled,timeZone:settings.appointmentTimeZone,days:settings.appointmentDays,startTime:settings.appointmentStartTime,endTime:settings.appointmentEndTime,durationMinutes:settings.appointmentDurationMinutes,nowLocal:DateTime.now().setZone(settings.appointmentTimeZone).toFormat("yyyy-MM-dd'T'HH:mm")},
    history.slice(-12),`El bot se llama ${settings.botName} y representa a ${settings.businessName}. Tono amable y cercano; responde de forma breve.`,
  )
  aiCalls++
  console.log(`DeepSeek propuesta [SKUs=${reply.productSkus.join(',')||'ninguno'}; acción=${reply.cartAction}]: ${reply.text}`)
  if(reply.productSkus.length){
    const allowed=pending?.kind==='inventory_selection'?new Set(pending.candidates.map(item=>item.sku)):pending?.kind==='inventory_selected'?new Set([pending.sku]):null
    const recommended=reply.productSkus.filter(sku=>!allowed||allowed.has(sku)).map(sku=>inventory.find(item=>item.sku===sku&&item.isActive))
      .filter((item):item is NonNullable<typeof item>=>!!item&&item.stockQuantity!==0).slice(0,2)
    if(recommended.length){
      if(recommended.length===1){const item=recommended[0];pending={kind:'inventory_selected',sku:item.sku,name:item.name,expiresAt:new Date(Date.now()+10*60_000).toISOString()}}
      else pending={kind:'inventory_selection',candidates:recommended.map(item=>({sku:item.sku,name:item.name})),expiresAt:new Date(Date.now()+10*60_000).toISOString()}
      await db.savePendingIntent(jid,{intent:pending,sourceMessageId:messageId})
      const response=formatVerifiedRecommendations(recommended)
      history.push({role:'assistant',content:response,timestampMs:Date.now()});console.log(`Bot [recomendaciones verificadas]: ${response}`);return response
    }
  }
  const safe=finalizeProviderConversation(reply.text)
  history.push({role:'assistant',content:safe.text,timestampMs:Date.now()})
  if(safe.text!==reply.text)console.log(`Bot [${safe.outcome}]: ${safe.text}`)
  else console.log(`Bot: ${safe.text}`)
  return safe.text
}

try{
  await db.assertPublicOrderSchema()
  for(const item of items){const created=await db.createInventoryItem(item);createdItems.push(created.id)}
  await db.upsertContactChat(jid,'Cliente QA')
  const [[contact]]:any=await db.pool.execute('SELECT c.id FROM contacts c JOIN contact_identifiers i ON i.contact_id=c.id WHERE i.jid=? LIMIT 1',[jid])
  contactId=Number(contact.id)
  console.log(`Chat QA aislado en MySQL: ${testDatabase}; modelo: ${settings.deepseekModel}; API key presente.`)

  await sendAsCustomer('Hola, me gustaría saber si venden audífonos?')
  await sendAsCustomer('¿Cuál me recomiendas para videollamadas largas y trabajo remoto?')
  await sendAsCustomer('La primera opción, por favor')
  await sendAsCustomer('Los quiero')
  await sendAsCustomer('Agrega uno más de esos')
  await sendAsCustomer('¿Qué llevo en el carrito?')
  await sendAsCustomer('Finalizar compra')
  await sendAsCustomer('Sí, confirmo')

  if(!createdOrderId)throw new Error('El diálogo terminó sin crear el pedido de prueba.')
  const [[order]]:any=await db.pool.execute('SELECT source,status,total,currency,reservation_status AS reservationStatus FROM orders WHERE id=?',[createdOrderId])
  const cart=await db.getShoppingCart(jid)
  if(order.source!=='whatsapp'||order.status!=='pending'||order.reservationStatus!=='active'||cart.length)throw new Error('La verificación del pedido o la reserva no coincide con el resultado esperado.')
  console.log(`\nVerificación: pedido ${order.status}, source=${order.source}, reserva=${order.reservationStatus}, total=${order.total} ${order.currency}, carrito vacío; llamadas reales a DeepSeek=${aiCalls}.`)
}finally{
  await db.pool.execute('DELETE FROM conversation_effects WHERE effect_key LIKE ?',[`live:${runId}:%`]).catch(()=>undefined)
  if(contactId!==null)await db.deleteContactData(contactId).catch(()=>undefined)
  for(const id of createdItems)await db.deleteInventoryItem(id).catch(()=>undefined)
  await db.closePool()
}
}

void main().catch(error=>{console.error(error instanceof Error?error.message:'La simulación de chat falló.');process.exitCode=1})
