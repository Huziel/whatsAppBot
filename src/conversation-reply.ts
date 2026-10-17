import { classifyConfirmationReply, classifyExplicitRequest, classifyPaymentIntent, detectCatalogRequest, formatCatalog, resolveInventoryQuery, safeConversationalReply } from './conversation-flow'
import type { CatalogRequest } from './conversation-flow'
import type { InventoryItem } from './db'

export interface DeterministicSettings {
  transferEnabled:boolean
  transferBankName:string
  transferAccountHolder:string
  transferAccountNumber:string
  transferClabe:string
  transferInstructions:string
  appointmentsEnabled:boolean
  appointmentTimeZone:string
  appointmentDays:number[]
  appointmentStartTime:string
  appointmentEndTime:string
  productCatalogImageUrl?:string|null
  serviceCatalogImageUrl?:string|null
}

export interface DeterministicOrder {
  id:number
  publicId?:string|null
  status:string
  total:string|null
  currency:string|null
}

export interface DeterministicPorts {
  listInventory:()=>Promise<InventoryItem[]>
  listOrders:()=>Promise<DeterministicOrder[]>
}

export interface DeterministicReply { text:string; outcome:string; inventoryCandidates?:Array<{sku:string;name:string}>; selectedInventory?:{sku:string;name:string} }

export function catalogOutcome(request:Exclude<CatalogRequest,null>):string{return `catalog_${request}`}

export function catalogImageUrlForOutcome(outcome:string|null|undefined,settings:Pick<DeterministicSettings,'productCatalogImageUrl'|'serviceCatalogImageUrl'>):string|null{
  if(outcome==='catalog_products')return settings.productCatalogImageUrl??null
  if(outcome==='catalog_services')return settings.serviceCatalogImageUrl??null
  if(outcome==='catalog_both')return settings.productCatalogImageUrl??settings.serviceCatalogImageUrl??null
  return null
}

export function finalizeProviderConversation(text:string):DeterministicReply{
  const safeText=safeConversationalReply(text)
  return {outcome:safeText===text.trim()?'ai_reply':'ai_reply_safety_fallback',text:safeText}
}

export function formatVerifiedRecommendations(items:InventoryItem[]):string{
  if(!items.length)return 'No encontré una recomendación verificable en el catálogo. Indícame qué característica priorizas y lo reviso.'
  const lines=items.slice(0,2).map((item,index)=>{const description=(item.description?.trim()||'Sin descripción adicional').replace(/[.?!]+$/,'');return `• ${index===0?'Recomendado':'Alternativa'}: ${item.name} (${item.sku}) — ${description}. ${item.price===null?'Precio por cotizar':`Precio: ${item.price} ${item.currency}`}. ${item.itemType==='service'?'Existencias no aplican':item.stockQuantity===null?'Existencias no controladas':item.stockQuantity===0?'Agotado':`Disponibles: ${item.stockQuantity}`}.`})
  return `${lines.join('\n')}\n¿Quieres agregar alguna opción al carrito?`
}

function paymentReply(intent:ReturnType<typeof classifyPaymentIntent>,settings:DeterministicSettings):DeterministicReply|null{
  if(intent==='request_transfer_details')return {outcome:'payment_information',text:settings.transferEnabled
    ?[`Datos para transferencia:`,`Banco: ${settings.transferBankName}`,`Titular: ${settings.transferAccountHolder}`,settings.transferClabe?`CLABE: ${settings.transferClabe}`:'',settings.transferAccountNumber?`Número de cuenta: ${settings.transferAccountNumber}`:'',settings.transferInstructions?`Instrucciones: ${settings.transferInstructions}`:'','El envío de estos datos no confirma ningún pago.'].filter(Boolean).join('\n')
    :'La transferencia no está habilitada. Consulta directamente al negocio los métodos disponibles.'}
  if(intent==='ask_methods')return {outcome:'payment_methods',text:settings.transferEnabled?'Aceptamos transferencia. Si quieres los datos, pídeme explícitamente los datos de transferencia.':'Consulta directamente al negocio los métodos de pago disponibles.'}
  if(intent==='reported_paid')return {outcome:'payment_unverified',text:'Gracias por avisar. No puedo verificar ni confirmar la recepción del pago; el negocio debe comprobarlo.'}
  if(intent==='declined_or_deferred')return {outcome:'payment_declined',text:'Entendido. No compartí datos bancarios ni registré ningún pago.'}
  return null
}

export async function resolveDeterministicReply(input:string,settings:DeterministicSettings,ports:DeterministicPorts):Promise<DeterministicReply|null>{
  const normalizedInput=input.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
  const simpleGreeting=/^[¡¿\s]*(?:hola|buen(?:os dias|as tardes|as noches)|hey|que tal|buen dia)[!.,¡¿?\s]*$/.test(normalizedInput.trim())
  if(simpleGreeting)return {outcome:'greeting',text:'¡Hola! ¿En qué puedo ayudarte?'}
  const productNeed=/\b(?:necesito|busco|estoy buscando|quiero|quisiera)\b/.test(normalizedInput)&&! /\b(?:saber|conocer|explicar|ayuda|como|por que|pagar|pago|transferencia|cuenta|factura|cita|agenda|horario)\b/.test(normalizedInput)
  const classified=classifyExplicitRequest(input)
  const explicit=productNeed&&(classified===null||classified==='general_question')?'inventory':classified
  try{
    if(productNeed&&explicit==='inventory'){
      const result=resolveInventoryQuery(input,await ports.listInventory())
       if(result.status!=='not_found')return {outcome:`inventory_${result.status}`,text:result.text,inventoryCandidates:result.candidates,selectedInventory:result.selected}
      return {outcome:'inventory_not_found',text:'No encontré un producto activo que coincida con esa descripción. Dime la marca, modelo o alguna característica y lo busco en el catálogo.'}
    }
    if(explicit==='catalog'){
      const request=detectCatalogRequest(input)??'both'
      return {outcome:catalogOutcome(request),text:formatCatalog(await ports.listInventory(),request)}
    }
    if(explicit==='inventory'){
      const result=resolveInventoryQuery(input,await ports.listInventory())
      const normalized=input.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
      const genericAvailability=/\b(hay|tiene|tienes|tienen)\b/.test(normalized)&&! /\b(precio|cuesta|costo|valor|a cuanto|stock|disponible|disponibilidad|existencias?|les queda|producto|articulo|servicio|sku)\b/.test(normalized)
      if(genericAvailability&&result.status==='not_found')return null
      return {outcome:`inventory_${result.status}`,text:result.text,inventoryCandidates:result.candidates,selectedInventory:result.selected}
    }
    if(explicit==='promotion')return {outcome:'promotion_unavailable',text:'No tengo promociones verificadas registradas. Consulta directamente al negocio antes de asumir un descuento u oferta.'}
    if(explicit==='business_hours')return {outcome:'business_hours',text:settings.appointmentsEnabled
      ?`Horario de citas: ${settings.appointmentStartTime}–${settings.appointmentEndTime} (${settings.appointmentTimeZone}), días ${settings.appointmentDays.join(', ')}.`
      :'No tengo un horario de atención verificado configurado. Consulta directamente al negocio.'}
    if(explicit==='orders'){
      const orders=await ports.listOrders()
      if(!orders.length)return {outcome:'orders_data',text:'No encontré pedidos registrados para este contacto.'}
      return {outcome:'orders_data',text:`Pedidos registrados:\n${orders.slice(0,10).map(order=>`• ${order.publicId||'#'+order.id}: ${order.status}${order.total===null?' — total por revisar':` — ${order.total} ${order.currency}`}`).join('\n')}`}
    }
    const payment=paymentReply(classifyPaymentIntent(input),settings)
    if(payment)return payment
    if(classifyConfirmationReply(input)==='affirmative')return {outcome:'no_pending_confirmation',text:'No hay una operación pendiente válida para confirmar.'}
    return null
  }catch{
    return {outcome:'infrastructure_error',text:'No pude verificar la información en el servidor en este momento. Inténtalo nuevamente.'}
  }
}

export async function resolveDeterministicOrProvider<T>(input:string,settings:DeterministicSettings,ports:DeterministicPorts,provider:()=>Promise<T>):Promise<{kind:'deterministic';reply:DeterministicReply}|{kind:'provider';value:T}>{
  const reply=await resolveDeterministicReply(input,settings,ports)
  return reply?{kind:'deterministic',reply}:{kind:'provider',value:await provider()}
}
