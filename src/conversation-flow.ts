import type { CartAction, CartChange, CartLine, InventoryItem } from './db'

export type VerifiedResult<T> =
  | { status: 'success'; value: T }
  | { status: 'missing_information'; message: string }
  | { status: 'ambiguous'; message: string; options: string[] }
  | { status: 'rejected'; message: string }
  | { status: 'unavailable'; message: string }
  | { status: 'infrastructure_error'; message: string }

export type PaymentIntent = 'none' | 'ask_methods' | 'request_transfer_details' | 'reported_paid' | 'declined_or_deferred' | 'unrelated_account'
export type ConfirmationReply = 'affirmative'|'negative'|'conflicting'|'other'
export type DirectiveSemantics = 'asserted'|'negated'|'conditional'|'conflicting'|'none'
export type ExplicitRequest = 'catalog'|'inventory'|'cart'|'checkout'|'payment'|'appointments'|'business_hours'|'orders'|'promotion'|'general_question'|null
export type PendingInputRoute = 'answer'|'correction'|'cancel'|'new_request'|'unclear'
export type CatalogRequest = 'products'|'services'|'both'|null

export type PendingIntent =
  | { kind: 'cart_selection'; action: 'add' | 'remove'; candidates: Array<{ sku: string; name: string }>; quantity: number; removeAll?:boolean; expiresAt: string }
  | { kind:'inventory_selection'; candidates:Array<{sku:string;name:string}>; expiresAt:string }
  | { kind:'inventory_selected'; sku:string; name:string; expiresAt:string }
  | { kind:'checkout_confirmation'; cart:CartLine[]; reservationMinutes:number; expiresAt:string }
  | { kind: 'appointment_details'; operation: 'book' | 'reschedule'; appointmentId?: number; settingsVersion:number; timeZone:string; expiresAt: string }
  | { kind: 'appointment_book_confirmation'; localStart: string; service: string | null; settingsVersion:number; timeZone:string; expiresAt: string }
  | { kind: 'appointment_cancel_selection'; appointments: Array<{ id: number; label: string }>; settingsVersion:number; timeZone:string; expiresAt: string }
  | { kind: 'appointment_cancel_confirmation'; appointmentId: number; label: string; settingsVersion:number; timeZone:string; expiresAt: string }
  | { kind: 'appointment_reschedule_selection'; appointments: Array<{ id: number; label: string }>; settingsVersion:number; timeZone:string; expiresAt: string }
  | { kind: 'appointment_reschedule_confirmation'; appointmentId: number; localStart: string; label: string; settingsVersion:number; timeZone:string; expiresAt: string }

export interface PendingIntentRecord {
  intent: PendingIntent
  sourceMessageId: string
}

export interface CartAuthorization {
  result: VerifiedResult<{ action: CartAction; items: CartChange[] }>
  candidates?: Array<{ sku: string; name: string }>
  quantity?: number
  removeAll?:boolean
}

const normalize = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9+._-]+/g, ' ').trim()
const escapeRegex=(value:string):string=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
const quantityWords:Record<string,number>={un:1,uno:1,una:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,siete:7,ocho:8,nueve:9,diez:10}
const quantityToken='-?\\d+(?:[.,]\\d+)?|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez'
const addVerb='agrega|agregar|agregame|agregues|anade|anadir|anademe|anadas|pon|incluye|incluir|incluyas|compra|comprar'
const removeVerb='quita|quitar|quitame|quites|elimina|eliminar|elimines|remueve|remover|remuevas|saca|sacar'

export function safeConversationalReply(text:string):string{
  const value=normalize(text)
  const transactionClaim=/\b(?:pago\s+(?:recibido|confirmado|procesado|pendiente)|pagad[oa]s?|transferencia\s+(?:recibida|confirmada|completada)|recibimos\s+(?:tu\s+)?(?:pago|transferencia)|(?:pedido|orden|carrito|compra|reserva|cita)\s+(?:confirmad[oa]|cread[oa]|registrad[oa]|agendad[oa]|reservad[oa]|cancelad[oa]|reprogramad[oa]|enviad[oa]|list[oa]|actualizad[oa]|completad[oa])|(?:reserva|pedido|cita)\s+(?:quedo|esta)\s+(?:list[oa]|confirmad[oa]|reservad[oa])|(?:agregad[oa]|anadid[oa]|quitad[oa]|eliminad[oa]|incluid[oa])\s+(?:al|del|en el|en tu)\s+(?:carrito|pedido|compra)|(?:registre|registramos|cree|creamos|agregue|anadi|quite|cancele|reprograme|confirme)\s+(?:el\s+|la\s+|tu\s+)?(?:pedido|orden|carrito|compra|reserva|cita|pago|transferencia)|(?:anadi|agregue|agrego|agregamos|inclui)\s+(?:uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d+)\b|aceptamos\s+(?:visa|mastercard|tarjeta|efectivo))\b/.test(value)
  const orderStatusClaim=/\b(?:pedido|orden)\b/.test(value)&&(
    /\b(?:pendiente|confirmad[oa]|preparando|preparad[oa]|preparacion|list[oa]|camino|salio|enviad[oa]|entregad[oa]|completad[oa]|cancelad[oa]|expirad[oa]|despachad[oa]|aprobad[oa]|vencid[oa])\b/.test(value)
    ||/\b(?:pedido|orden)\b.{0,32}\b(?:esta|fue|sigue|va|quedo|se encuentra|esta siendo)\b/.test(value)
  )
  const inventoryClaim=/\b(?:hay|tenemos|quedan|queda|disponible|agotado|agotada|sin existencias)\b.{0,36}\b(?:\d+|existencias?|unidades?|disponible|agotad[oa]|stock)\b|\b\d+\s+(?:existencias?|unidades?)\b/.test(value)
  const priceClaim=/\b(?:cuesta|vale|precio(?:\s+es)?|el costo|total)\b.{0,32}(?:\d|[$€£])|[$€£]\s*\d|\b\d+(?:[.,]\d{1,2})?\s*(?:mxn|usd|pesos?|dolares?)\b|\b(?:cuesta|vale|precio|total)\b.{0,40}\b(?:uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|veinte|treinta|cincuenta|noventa|cien)\b.{0,20}\b(?:pesos?|dolares?)\b/.test(value)
  const promotionClaim=/\b(?:hay|tenemos|tienes|ofrecemos|aplica|existe)\b.{0,32}\b(?:promocion|descuento|oferta)\b|\b(?:promocion|descuento|oferta)\b.{0,32}\b\d+\s*x\s*\d+\b|\b\d+\s*x\s*\d+\b/.test(value)
  const scheduleClaim=/\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(value)&&/\b(abrimos|cerramos|atendemos|horario)\b/.test(value)
  return transactionClaim||orderStatusClaim||inventoryClaim||priceClaim||promotionClaim||scheduleClaim
    ?'Puedo ayudarte, pero los datos comerciales y las operaciones deben verificarse en el servidor. Indica el producto, pedido, pago o cita que deseas consultar.'
    :text.trim()
}

function parseQuantity(value:string):number{
  const token=normalize(value).replace(',','.')
  return quantityWords[token]??Number(token)
}

function directiveQuantity(text:string):{kind:'none'}|{kind:'value';value:number}|{kind:'invalid'}{
  const value=normalize(text)
  const match=new RegExp(`\\b(?:${addVerb}|${removeVerb})\\b\\s+(?:me\\s+)?(${quantityToken})(?=$|\\s)`,'i').exec(value)
  if(!match)return {kind:'none'}
  const quantity=parseQuantity(match[1])
  return Number.isInteger(quantity)&&quantity>=1&&quantity<=100?{kind:'value',value:quantity}:{kind:'invalid'}
}

interface ReferenceMatch { item:InventoryItem; start:number; end:number; referenceLength:number }

function referencePattern(reference:string,pluralWords:boolean):RegExp{
  const tokens=normalize(reference).split(/\s+/).filter(Boolean)
  const source=tokens.map(token=>{
    const escaped=escapeRegex(token)
    return pluralWords&&/^[a-z]{4,}$/.test(token)?`${escaped}(?:s|es)?`:escaped
  }).join('\\s+')
  return new RegExp(`(?:^|\\s)(${source})(?=$|\\s)`,'i')
}

function findReference(text:string,item:InventoryItem):ReferenceMatch|null{
  const candidates=[{value:item.sku,plural:false},{value:item.name,plural:true}]
  let best:ReferenceMatch|null=null
  for(const candidate of candidates){
    const match=referencePattern(candidate.value,candidate.plural).exec(text)
    if(!match)continue
    const leading=match[0].length-match[1].length
    const found={item,start:match.index+leading,end:match.index+leading+match[1].length,referenceLength:normalize(candidate.value).length}
    if(!best||found.referenceLength>best.referenceLength)best=found
  }
  return best
}

function inventoryReferences(text:string,available:InventoryItem[]):ReferenceMatch[]{
  const matches=available.map(item=>findReference(text,item)).filter((item):item is ReferenceMatch=>!!item)
  return matches.filter(match=>!matches.some(other=>other!==match&&other.start<=match.start&&other.end>=match.end&&other.referenceLength>match.referenceLength)).sort((a,b)=>a.start-b.start||b.referenceLength-a.referenceLength)
}

function quantityForReference(text:string,match:ReferenceMatch,previousEnd:number,nextStart:number):{kind:'none'}|{kind:'value';value:number}|{kind:'invalid'|'conflicting'}{
  const prefix=text.slice(previousEnd,match.start)
  const suffix=text.slice(match.end,nextStart)
  const found:string[]=[]
  const prefixPatterns=[
    new RegExp(`(?:\\b(?:${addVerb}|${removeVerb})\\b|^)\\s+(?:me\\s+)?(${quantityToken})\\s*(?:(?:unidades?|piezas?|botellas?|paquetes?)\\s+)?(?:del?\\s+)?$`,'i'),
    new RegExp(`\\b(${quantityToken})\\s+(?:(?:unidades?|piezas?|botellas?|paquetes?)\\s+)?(?:del?\\s+)?$`,'i'),
  ]
  for(const pattern of prefixPatterns){const value=pattern.exec(prefix)?.[1];if(value){found.push(value);break}}
  const suffixPatterns=[
    new RegExp(`^\\s*[,;]?\\s*(?:cantidad|cant(?:idad)?|x)\\s*[:=]?\\s*(${quantityToken})(?=$|\\s|[,;])`,'i'),
    new RegExp(`^\\s*[,;]?\\s*(${quantityToken})\\s+(?:unidades?|piezas?|botellas?|paquetes?)(?=$|\\s|[,;])`,'i'),
  ]
  for(const pattern of suffixPatterns){const value=pattern.exec(suffix)?.[1];if(value){found.push(value);break}}
  if(!found.length)return {kind:'none'}
  const quantities=found.map(parseQuantity)
  if(quantities.some(value=>!Number.isInteger(value)||value<1||value>100))return {kind:'invalid'}
  if(new Set(quantities).size>1)return {kind:'conflicting'}
  return {kind:'value',value:quantities[0]}
}

export function classifyPaymentIntent(text: string): PaymentIntent {
  const value = normalize(text)
  if (/\b(mi cuenta|cuenta de usuario|cuenta personal|crear cuenta|iniciar sesion|recuperar cuenta)\b/.test(value)) return 'unrelated_account'
  if (/\b(no quiero|no voy a|aun no|todavia no|despues|luego)\b.*\b(pagar|pago|transferir|transferencia)\b/.test(value)) return 'declined_or_deferred'
  if (/\b(ya pague|ya hice (el )?pago|ya transferi|acabo de pagar|pago realizado|transferencia realizada|te pague)\b/.test(value)) return 'reported_paid'
  if (/\b(datos (para|de) (la )?transferencia|clabe|numero de cuenta|a que cuenta|donde (te )?transfiero|quiero transferir|pasame (la )?cuenta)\b/.test(value)) return 'request_transfer_details'
  if (/\b(como (puedo )?pagar|metodos? de pago|formas? de pago|que pagos aceptan|aceptan (tarjeta|efectivo|transferencia)|(tienen|manejan) transferencia)\b/.test(value)) return 'ask_methods'
  return 'none'
}

export function classifyConfirmationReply(text:string):ConfirmationReply{
  const value=text.trim().toLocaleLowerCase('es').replace(/[.!?]+$/g,'').trim()
  const normalized=normalize(value)
  const affirmative=/^(?:si\s+)?(?:confirmo|correcto|de acuerdo|adelante|confirmar|ok|okay|claro)(?:\s+por favor)?$|^si(?:\s+por favor)?$/i.test(normalized)
  const negative=/^(?:no|cancelar|cancela|mejor no|olvidalo|olvida|no gracias|ya no)(?:\s+por favor)?$/i.test(normalized)
  if(affirmative&&negative)return 'conflicting'
  if(/\b(?:si|sí)\b.*\bno\b|\bno\b.*\b(?:si|sí)\b/i.test(value))return 'conflicting'
  if(affirmative)return 'affirmative'
  if(negative)return 'negative'
  if(/^(si|sí)\s+(?:hay|tiene|tienes|cuesta|es|esta|está|puede|puedes)\b/.test(normalized))return 'other'
  return 'other'
}

export function isAffirmative(text: string): boolean {
  return classifyConfirmationReply(text)==='affirmative'
}

export function isNegative(text: string): boolean {
  return classifyConfirmationReply(text)==='negative'
}

export function classifyCartDirective(text:string,action:'add'|'remove'|'clear'|'show'):DirectiveSemantics{
  if(action==='show')return 'asserted'
  const value=text.toLocaleLowerCase('es')
  const normalized=normalize(text)
  const verbs=action==='add'?addVerb:action==='remove'?removeVerb:'vaciar|vacia|limpiar|limpia|eliminar todo|quitar todo'
  if(!new RegExp(`\\b(?:${verbs})\\b`,'i').test(normalized))return 'none'
  const clauses=value.split(/;|\bpero\b/i)
  const semantics=new Set<'asserted'|'negated'|'conditional'>()
  for(const clause of clauses){
    const plain=normalize(clause)
    if(!new RegExp(`\\b(?:${verbs})\\b`,'i').test(plain))continue
    const conditional=/^(?:si(?!\s*,?\s*por favor)|solo si|en caso de|a menos que)\b/i.test(clause.trim())||/\bsi\b/i.test(clause)||/\b(?:solo si|a menos que|tal vez|quizas)\b/i.test(plain)
    const negated=new RegExp(`\\b(?:no|nunca|jamas)\\b.{0,40}\\b(?:${verbs})\\b|\\b(?:${verbs})\\b.{0,40}(?:,\\s*)?\\bno\\b`,'i').test(plain)
    semantics.add(conditional?'conditional':negated?'negated':'asserted')
  }
  if(semantics.size>1)return 'conflicting'
  return semantics.values().next().value??'none'
}

export function detectCartAction(text:string):CartAction{
  const value=normalize(text)
  if(/\b(vaciar|vacia|limpiar|limpia|eliminar todo|quitar todo)\b/.test(value))return 'clear'
  if(new RegExp(`\\b(?:${removeVerb})\\b`).test(value))return 'remove'
  if(new RegExp(`\\b(?:${addVerb})\\b`).test(value))return 'add'
  if(/\b(ver|muestra|muestrame|ensena|consultar|consulta)\b.*\bcarrito\b|\bque (?:hay|tengo|llevo) en (?:mi|el) carrito\b|\bmi carrito\b/.test(value))return 'show'
  return 'none'
}

export function selectedOption(text: string, maximum: number): number | null {
  const value = normalize(text)
  const words: Record<string,number> = { uno:1, una:1, primero:1, primera:1, primero1:1, dos:2, segundo:2, segunda:2, tres:3, tercero:3, tercera:3, cuatro:4, cuarto:4, cuarta:4, cinco:5, quinto:5, quinta:5 }
  const numeric=/^(?:(?:opcion|el|la)\s+)?(\d+)$/.exec(value)?.[1]
  const selected = numeric ? Number(numeric) : words[value]
  return Number.isInteger(selected) && selected >= 1 && selected <= maximum ? selected - 1 : null
}

export function inventorySelectionIndex(text:string,candidates:Array<{sku:string;name:string}>):number|null{
  const explicit=selectedOption(text,candidates.length)
  if(explicit!==null)return explicit
  const value=normalize(text)
  if(candidates.length===1&&/\b(?:lo|la|los|las|ese|esa|esos|esas|este|esta|estos|estas)\b/.test(value))return 0
  const ordinal=/\b(?:el|la|opcion)?\s*(primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta)\b/.exec(value)?.[1]
  return ordinal?selectedOption(ordinal,candidates.length):null
}

export function wantsToBuySelectedItem(text:string):boolean{
  const value=normalize(text)
  const purchase=/\b(?:quiero|quisiera|me llevo|me interesa comprar|dame|vendeme|comprar|compro|ponme|agregame|anademe|agregalo|agregala|agregalos|agregalas|anadelo|anadela|anadelos|anadelas)\b/.test(value)
  const reference=/\b(?:lo|la|los|las|ese|esa|esos|esas|este|esta|estos|estas|primero|primera|segundo|segunda)\b/.test(value)
  return purchase&&(reference||/\b(?:ponme|agregame|anademe|agregalo|agregala|agregalos|agregalas|anadelo|anadela|anadelos|anadelas)\b/.test(value))
}

export function isInventoryRecommendationQuestion(text:string):boolean{
  const value=normalize(text)
  return /\b(cual|que opcion|recomiendas|recomendacion|recomendar|mejor|conviene|preferible)\b/.test(value)
}

export function selectedItemQuantity(text:string):number|null{
  const value=normalize(text)
  const patterns=[
    new RegExp(`\\b(?:quiero|quisiera|dame|vendeme|ponme|agregame|anademe|comprar|compro)\\s+(${quantityToken})(?:\\s+de)?\\b`,'i'),
    new RegExp(`\\b(${quantityToken})\\s+(?:de\\s+)?(?:lo|la|los|las|ese|esa|esos|esas|este|esta|estos|estas)\\b`,'i'),
    new RegExp(`\\b(?:lo|la|los|las|ese|esa|esos|esas|este|esta|estos|estas)\\b.{0,20}\\b(?:cantidad|cant|x)\\s*[:=]?\\s*(${quantityToken})\\b`,'i'),
  ]
  const tokens=patterns.map(pattern=>pattern.exec(value)?.[1]).filter((token):token is string=>!!token)
  if(!tokens.length)return 1
  const quantities=tokens.map(parseQuantity)
  return quantities.every(quantity=>Number.isInteger(quantity)&&quantity>=1&&quantity<=100)&&new Set(quantities).size===1?quantities[0]:null
}

export function authorizeCartMutation(inputText: string, action: CartAction, proposedItems: CartChange[], inventory: InventoryItem[], cart: CartLine[]): CartAuthorization {
  if (action==='none'||!['add','remove','clear','show'].includes(action)) return { result: { status: 'rejected', message: 'No se solicitó una operación de carrito.' } }
  const text = normalize(inputText)
  if (action === 'show') return { result: { status: 'success', value: { action, items: [] } } }
  const semantics=classifyCartDirective(inputText,action)
  if(semantics==='negated')return {result:{status:'rejected',message:'No modifiqué el carrito porque la solicitud niega esa operación.'}}
  if(semantics==='conditional')return {result:{status:'missing_information',message:'No modifiqué el carrito porque la condición debe verificarse o aclararse primero.'}}
  if(semantics==='conflicting')return {result:{status:'ambiguous',message:'La solicitud contiene instrucciones positivas y negativas. Indica una sola modificación.',options:[]}}
  if(semantics==='none')return {result:{status:'rejected',message:'No modifiqué el carrito porque no hay una solicitud explícita.'}}
  if (action === 'clear') {
    if (!/\b(vaciar|vacia|limpiar|limpia|eliminar todo|quitar todo)\b/.test(text)) return { result: { status: 'rejected', message: 'Necesito una solicitud explícita para vaciar el carrito.' } }
    return { result: { status: 'success', value: { action, items: [] } } }
  }
  const available = action === 'add' ? inventory.filter(item => item.isActive) : cart.map(line => ({ ...line, id: 0, name: line.itemName, description: null, imageUrl: null, price: line.unitPrice, stockQuantity: null, isActive: true }))
  const exactMatches=inventoryReferences(text,available)
  const exact=exactMatches.map(match=>match.item)
  const contextualReference=/\b(otro igual|otra igual|el mismo|la misma)\b/.test(text)||/\b(agrega|agregame|anade|anademe|pon)\s+(un[oa]?|dos|tres|cuatro|cinco|\d+)\b/.test(text)
  const contextual = contextualReference && cart.length === 1
    ? available.filter(item => item.sku === cart[0].sku) : []
  const matches = exact.length ? exact : contextual
  if(exactMatches.some(match=>/\b(?:sin|excepto|menos)\s*$/.test(text.slice(Math.max(0,match.start-30),match.start))))return {result:{status:'ambiguous',message:'La solicitud incluye artículos excluidos. Indica en mensajes separados qué artículo deseas modificar.',options:[]}}
  if(exactMatches.length>1&&new Set(exactMatches.map(match=>`${match.start}:${match.end}`)).size<exactMatches.length){
    const candidates=exactMatches.map(match=>({sku:match.item.sku,name:match.item.name}))
    const quantity=directiveQuantity(inputText)
    if(quantity.kind==='invalid')return {result:{status:'rejected',message:'Indica una cantidad entera entre 1 y 100.'}}
    return {result:{status:'ambiguous',message:'Encontré varias opciones. Indica cuál quieres.',options:candidates.map((item,index)=>`${index+1}. ${item.name} (${item.sku})`)},candidates,quantity:quantity.kind==='value'?quantity.value:1,removeAll:action==='remove'&&quantity.kind==='none'}
  }
  if (matches.length > 1) {
    const distinctSpans=new Set(exactMatches.map(match=>`${match.start}:${match.end}`))
    if(distinctSpans.size===exactMatches.length){
      const items:CartChange[]=[]
      for(let index=0;index<exactMatches.length;index++){
        const match=exactMatches[index]
        const quantity=quantityForReference(text,match,index?exactMatches[index-1].end:0,exactMatches[index+1]?.start??text.length)
        if(quantity.kind==='invalid')return {result:{status:'rejected',message:'Indica cantidades enteras entre 1 y 100.'}}
        if(quantity.kind==='conflicting')return {result:{status:'ambiguous',message:'Encontré cantidades contradictorias para un artículo.',options:[]}}
        items.push({sku:match.item.sku,quantity:quantity.kind==='value'?quantity.value:1,...action==='remove'&&quantity.kind==='none'?{removeAll:true}:{}})
      }
      return {result:{status:'success',value:{action,items}}}
    }
    const candidates = matches.slice(0, 5).map(item => ({ sku: item.sku, name: item.name }))
    const quantity=directiveQuantity(inputText)
    if(quantity.kind==='invalid')return {result:{status:'rejected',message:'Indica una cantidad entera entre 1 y 100.'}}
    return { result: { status: 'ambiguous', message: 'Encontré varias opciones. Indica cuál quieres.', options: candidates.map((item, index) => `${index + 1}. ${item.name} (${item.sku})`) }, candidates, quantity:quantity.kind==='value'?quantity.value:1, removeAll:action==='remove'&&quantity.kind==='none' }
  }
  if (!matches.length) {
    const terms = text.split(' ').filter(term => term.length >= 4)
    const candidates = available.filter(item => terms.some(term => normalize(item.name).includes(term))).slice(0, 5).map(item => ({ sku: item.sku, name: item.name }))
    if (candidates.length){
      const quantity=directiveQuantity(inputText)
      if(quantity.kind==='invalid')return {result:{status:'rejected',message:'Indica una cantidad entera entre 1 y 100.'}}
      return { result: { status: 'ambiguous', message: 'No pude identificar un artículo exacto. Elige una opción.', options: candidates.map((item, index) => `${index + 1}. ${item.name} (${item.sku})`) }, candidates, quantity:quantity.kind==='value'?quantity.value:1, removeAll:action==='remove'&&quantity.kind==='none' }
    }
    return { result: { status: 'missing_information', message: 'Indica el producto o servicio exacto que quieres modificar en el carrito.' } }
  }
  const selected = matches[0]
  const selectedMatch=exactMatches.find(match=>match.item.sku===selected.sku)
  const local=selectedMatch?quantityForReference(text,selectedMatch,0,text.length):{kind:'none'} as const
  const parsed=local.kind==='none'?directiveQuantity(inputText):local
  if(parsed.kind==='invalid')return {result:{status:'rejected',message:'Indica una cantidad entera entre 1 y 100.'}}
  if(parsed.kind==='conflicting')return {result:{status:'ambiguous',message:'Encontré cantidades contradictorias para el artículo.',options:[]}}
  const quantity=parsed.kind==='value'?parsed.value:1
  return { result: { status: 'success', value: { action, items: [{ sku: selected.sku, quantity, ...action==='remove'&&parsed.kind==='none'?{removeAll:true}:{} }] } } }
}

export function detectCatalogRequest(text:string):CatalogRequest{
  const value=normalize(text)
  const products=/\b(productos|articulos)\b/.test(value),services=/\bservicios\b/.test(value)
  const asks=/\b(tod[oa]s?|complet[oa]|catalogo|lista|listado|inventario|muestra|muestrame|ver|listar|dame|manda|enviame|que|cuales|tienes|tienen|vendes|venden|ofreces|ofrecen|manejas|manejan)\b/.test(value)
  if(!asks||(!products&&!services&&!/\bcatalogo|inventario\b/.test(value)))return null
  return products&&services?'both':products?'products':services?'services':'both'
}

const checkoutPattern=/\b(?:finaliza|finalizar|termina|terminar|cerrar)\s+(?:la\s+)?(?:compra|pedido|orden)\b|\b(?:hacer|crear|levantar|enviar|confirmar)\s+(?:mi|el|la|un|una)?\s*(?:pedido|orden)\b|\b(?:quiero|quisiera|deseo)\s+(?:hacer|crear|confirmar|finalizar|terminar)\s+(?:mi|el|la|un|una)?\s*(?:pedido|orden|compra)\b/

function checkoutMatch(text:string):RegExpExecArray|null{
  for(const rawClause of text.split(/[,;]|\bpero\b/i)){
    const clause=normalize(rawClause),match=checkoutPattern.exec(clause)
    if(!match)continue
    const prefix=clause.slice(0,match.index)
    if(/\b(?:no|nunca)\s+(?:(?:voy|vamos)\s+a\s+|puedo\s+|quiero\s+|deseo\s+|necesito\s+)?$/.test(prefix))continue
    return match
  }
  return null
}

export function detectCheckoutRequest(text:string):boolean{return checkoutMatch(text)!==null}

export function hasCartMutationAlongsideCheckout(text:string):boolean{
  const value=normalize(text),match=checkoutPattern.exec(value)
  if(!match||!detectCheckoutRequest(text))return false
  return [value.slice(0,match.index),value.slice(match.index+match[0].length)].some(segment=>{
    const action=detectCartAction(segment)
    return action!=='none'&&classifyCartDirective(segment,action)!=='negated'
  })
}

export function classifyExplicitRequest(text:string):ExplicitRequest{
  const value=normalize(text)
  if(detectCatalogRequest(text))return 'catalog'
  if(/\b(promocion|descuento|oferta)\b/.test(value))return 'promotion'
  if(/\b(horarios?|a que hora|cuando abren|cuando cierran|cuando atienden)\b/.test(value))return 'business_hours'
  if(classifyPaymentIntent(text)!=='none')return 'payment'
  if(detectCheckoutRequest(text))return 'checkout'
  if(/\b(pedido|orden|total de (mi|la) compra)\b/.test(value))return 'orders'
  if(detectCartAction(text)!=='none')return 'cart'
  if(/\b(cita|reservar|agenda|agendar|reprogramar|cancelar cita)\b/.test(value))return 'appointments'
  if(/\b(precio|cuesta|costo|valor|a cuanto|stock|disponible|disponibilidad|existencias?|les queda|tiene|tienes|tienen|hay|vende|venden|vendes|vendemos|vender|ofrece|ofrecen|ofreces|ofrecemos|maneja|manejan|manejas|manejamos)\b/.test(value))return 'inventory'
  if(/[?¿]/.test(text)||/^(?:como|cuando|donde|por que|que|cual|cuales|hacen|ofrecen)\b/.test(value))return 'general_question'
  return null
}

export function classifyPendingInput(pending:PendingIntent,input:string):PendingInputRoute{
  const explicit=classifyExplicitRequest(input)
  const confirmation=classifyConfirmationReply(input)
  const cancellation=/\b(olvida|olvidemos|cancela|cancelar|ya no|mejor no|deja eso)\b/i.test(normalize(input))
  if(explicit&&cancellation)return 'new_request'
  if(cancellation||confirmation==='negative')return 'cancel'
  if(pending.kind==='checkout_confirmation'&&hasCartMutationAlongsideCheckout(input))return 'new_request'
  if(pending.kind==='inventory_selected'&&wantsToBuySelectedItem(input))return 'answer'
  if(pending.kind==='inventory_selection'&&inventorySelectionIndex(input,pending.candidates)!==null&&wantsToBuySelectedItem(input))return 'answer'
  if(pending.kind==='checkout_confirmation'&&(confirmation==='affirmative'||explicit==='checkout'))return 'answer'
  if(explicit&&explicit!=='appointments')return 'new_request'
  if(pending.kind.endsWith('_confirmation')){
    if(confirmation==='affirmative')return 'answer'
    if(/\b(hoy|manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm))\b/.test(normalize(input)))return 'correction'
  }else if((pending.kind==='cart_selection'||pending.kind==='inventory_selection')&&selectedOption(input,pending.candidates.length)!==null)return 'answer'
  else if((pending.kind==='appointment_cancel_selection'||pending.kind==='appointment_reschedule_selection')&&selectedOption(input,pending.appointments.length)!==null)return 'answer'
  else if(pending.kind==='appointment_details'&&/\b(hoy|manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm))\b/.test(normalize(input)))return 'answer'
  if(explicit)return 'new_request'
  return 'unclear'
}

export function isPendingIntentCompatible(pending:PendingIntent,appointmentsEnabled:boolean,settingsVersion:number,timeZone:string):boolean{
  return pending.kind==='cart_selection'||pending.kind==='inventory_selection'||pending.kind==='inventory_selected'||pending.kind==='checkout_confirmation'||appointmentsEnabled&&pending.settingsVersion===settingsVersion&&pending.timeZone===timeZone
}

export function formatCatalog(inventory:InventoryItem[],request:CatalogRequest,limit=50):string{
  const types=request==='both'?['product','service'] as const:[request==='products'?'product':'service'] as const
  return types.map(type=>{
    const all=inventory.filter(item=>item.itemType===type),items=all.slice(0,limit)
    const title=type==='product'?'Productos':'Servicios'
    if(!items.length)return `No hay ${title.toLowerCase()} activos en este momento.`
    const suffix=all.length>items.length?`\nHay ${all.length-items.length} más; pide una búsqueda específica.`:''
    return `${title} disponibles:\n${items.map(item=>`• ${formatInventoryFact(item)}`).join('\n')}${suffix}`
  }).join('\n\n')
}

export interface InventoryQueryAnswer { text:string;status:'success'|'ambiguous'|'missing_information'|'not_found';candidates?:Array<{sku:string;name:string}>;selected?:{sku:string;name:string} }

function inventoryAlternatives(item:InventoryItem,inventory:InventoryItem[]):InventoryItem[]{
  const terms=new Set(normalize(item.name).split(/\s+/).filter(term=>term.length>=3))
  return inventory.filter(candidate=>candidate.sku!==item.sku&&candidate.isActive&&(candidate.itemType==='service'||candidate.stockQuantity!==0))
    .map(candidate=>({candidate,score:normalize(candidate.name).split(/\s+/).filter(term=>terms.has(term)).length}))
    .filter(entry=>entry.score>0).sort((left,right)=>right.score-left.score||left.candidate.name.localeCompare(right.candidate.name,'es'))
    .slice(0,3).map(entry=>entry.candidate)
}

export function resolveInventoryQuery(input:string,inventory:InventoryItem[]):InventoryQueryAnswer{
  const value=normalize(input)
  const matches=inventoryReferences(value,inventory).map(match=>match.item)
  if(matches.length===1){
    const selected=matches[0]
    if(selected.itemType==='product'&&selected.stockQuantity===0){
      const alternatives=inventoryAlternatives(selected,inventory)
      if(alternatives.length){const candidates=alternatives.map(item=>({sku:item.sku,name:item.name}));return {status:'ambiguous',candidates,text:`${formatInventoryFact(selected)}. Alternativas disponibles:\n${candidates.map((item,index)=>`${index+1}. ${item.name} (${item.sku})`).join('\n')}\nIndica cuál quieres consultar.`}}
    }
    return {status:'success',selected:{sku:selected.sku,name:selected.name},text:`${formatInventoryFact(selected)}.`}
  }
  if(matches.length>1){const candidates=matches.slice(0,5).map(item=>({sku:item.sku,name:item.name}));return {status:'ambiguous',candidates,text:`Encontré varias opciones:\n${candidates.map((item,index)=>`${index+1}. ${item.name} (${item.sku})`).join('\n')}\nIndica cuál quieres consultar.`}}
  const terms=value.split(/\s+/).filter(term=>term.length>=3&&!/^(precio|cuesta|costo|valor|cuanto|stock|disponible|disponibilidad|existencias|tienen|tiene|tienes|queda|quedan|hay|que|cual|me|gustaria|saber|si|venden|vende|vendes|vendemos|vender|ofrece|ofrecen|ofreces|ofrecemos|maneja|manejan|manejas|manejamos|articulo|articulos)$/.test(term))
  const candidates=inventory.filter(item=>terms.some(term=>normalize(item.name).includes(term)||normalize(item.sku).includes(term))).slice(0,5)
  if(candidates.length===1){const item=candidates[0];return {status:'success',selected:{sku:item.sku,name:item.name},text:`${formatInventoryFact(item)}.`}}
  if(candidates.length>1){const choices=candidates.map(item=>({sku:item.sku,name:item.name}));return {status:'ambiguous',candidates:choices,text:`No pude identificar un artículo exacto. Opciones:\n${choices.map((item,index)=>`${index+1}. ${item.name} (${item.sku})`).join('\n')}`}}
  if(!terms.length)return {status:'missing_information',text:'Indica el nombre o SKU del producto o servicio que deseas consultar.'}
  return {status:'not_found',text:'No encontré un artículo activo que coincida exactamente con la consulta.'}
}

export function answerInventoryQuery(input:string,inventory:InventoryItem[]):string{return resolveInventoryQuery(input,inventory).text}

export function resolveInventorySelection(pending:Extract<PendingIntent,{kind:'inventory_selection'}>,input:string,inventory:InventoryItem[]):InventoryQueryAnswer{
  const choice=selectedOption(input,pending.candidates.length)
  if(choice===null)return {status:'ambiguous',candidates:pending.candidates,text:`Elige una opción:\n${pending.candidates.map((item,index)=>`${index+1}. ${item.name} (${item.sku})`).join('\n')}`}
  const selected=pending.candidates[choice],item=inventory.find(entry=>entry.sku===selected.sku&&entry.isActive)
  return item?{status:'success',selected:{sku:item.sku,name:item.name},text:`${formatInventoryFact(item)}.`}:{status:'not_found',text:'La opción seleccionada ya no está disponible para consulta.'}
}

export function formatVerifiedCart(result: VerifiedResult<{ cart: CartLine[]; changed: boolean }>, action: CartAction): string {
  if (result.status !== 'success') return result.message
  if (!result.value.changed && action !== 'show') return 'No pude aplicar cambios al carrito con los datos indicados.'
  if (!result.value.cart.length) return action === 'show' ? 'Tu carrito está vacío.' : 'Carrito vaciado. No se realizó ningún cobro ni reserva.'
  const lines = result.value.cart.map(line => `• ${line.quantity} × ${line.itemName} — ${line.unitPrice === null ? 'precio por cotizar' : `${line.unitPrice} ${line.currency} c/u`}`)
  const heading = action === 'show' ? 'Tu carrito actual:' : 'Carrito actualizado:'
  return `${heading}\n${lines.join('\n')}\n\nEl carrito es informativo; no es un pedido confirmado, no se realizó ningún cobro ni se reservaron existencias.`
}

export function formatCheckoutConfirmation(cart:CartLine[]):string{
  if(!cart.length)return 'Tu carrito está vacío. Agrega al menos un artículo antes de finalizar el pedido.'
  const currencies=new Set(cart.map(line=>line.currency))
  const total=currencies.size===1&&cart.every(line=>line.unitPrice!==null)
    ?cart.reduce((sum,line)=>{const [whole,fraction='']=line.unitPrice!.split('.');return sum+(BigInt(whole)*100n+BigInt((fraction+'00').slice(0,2)))*BigInt(line.quantity)},0n)
    :null
  const currency=currencies.size===1?[...currencies][0]:null
  const lines=cart.map(line=>`• ${line.quantity} × ${line.itemName} — ${line.unitPrice===null?'precio por cotizar':`${line.unitPrice} ${line.currency} c/u`}`)
  const totalLine=total===null?'Total por revisar antes del pago.':`Total: ${total/100n}.${String(total%100n).padStart(2,'0')} ${currency}`
  return `Resumen del pedido:\n${lines.join('\n')}\n${totalLine}\n\n¿Confirmas crear el pedido y reservar las existencias disponibles? Responde “sí” o “no”. No se realizará ningún cobro.`
}

export function formatInventoryFact(item:InventoryItem):string{
  const price=item.price===null?'precio por cotizar':`${item.price} ${item.currency}`
  const availability=item.itemType==='service'?'existencias no aplicables':item.stockQuantity===0?'agotado':item.stockQuantity===null?'existencias no controladas':`existencias: ${item.stockQuantity}`
  return `${item.name} (${item.sku}) — ${price} — ${availability}`
}

export class KeyedSerialExecutor {
  private readonly chains = new Map<string, Promise<void>>()

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    let release!: () => void
    const marker = new Promise<void>(resolve => { release = resolve })
    const chain = previous.catch(() => undefined).then(() => marker)
    this.chains.set(key, chain)
    return previous.catch(() => undefined).then(operation).finally(() => {
      release()
      if (this.chains.get(key) === chain) this.chains.delete(key)
    })
  }
}
