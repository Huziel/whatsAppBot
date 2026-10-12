import type { CartAction, CartChange, CartLine, InventoryItem } from './db'

export type VerifiedResult<T> =
  | { status: 'success'; value: T }
  | { status: 'missing_information'; message: string }
  | { status: 'ambiguous'; message: string; options: string[] }
  | { status: 'rejected'; message: string }
  | { status: 'unavailable'; message: string }
  | { status: 'infrastructure_error'; message: string }

export type PaymentIntent = 'none' | 'ask_methods' | 'request_transfer_details' | 'reported_paid' | 'declined_or_deferred' | 'unrelated_account'

export type PendingIntent =
  | { kind: 'cart_selection'; action: 'add' | 'remove'; candidates: Array<{ sku: string; name: string }>; quantity: number; expiresAt: string }
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
}

const normalize = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9+._-]+/g, ' ').trim()

export function safeConversationalReply(text:string):string{
  const value=normalize(text)
  const unverified=/\b(pago (recibido|confirmado|aprobado)|hemos recibido (el )?pago|cita (agendada|reservada|cancelada|reprogramada|confirmada)|carrito (actualizado|modificado)|agregue|agregado al carrito|quite del carrito|pedido confirmado)\b/.test(value)
  return unverified?'Puedo orientarte, pero no puedo afirmar que una operación se completó sin verificarla en el servidor. Indica qué deseas consultar o realizar.':text.trim()
}

function quantityFromText(text:string):number|null{
  const value=normalize(text)
  const match=value.match(/\b(\d{1,3}|un[oa]?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/)
  if(!match)return null
  const words:Record<string,number>={un:1,uno:1,una:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,siete:7,ocho:8,nueve:9,diez:10}
  return words[match[1]]??Number(match[1])
}

export function classifyPaymentIntent(text: string): PaymentIntent {
  const value = normalize(text)
  if (/\b(mi cuenta|cuenta de usuario|cuenta personal|crear cuenta|iniciar sesion|recuperar cuenta)\b/.test(value)) return 'unrelated_account'
  if (/\b(no quiero|no voy a|aun no|todavia no|despues|luego)\b.*\b(pagar|pago|transferir|transferencia)\b/.test(value)) return 'declined_or_deferred'
  if (/\b(ya pague|ya hice (el )?pago|ya transferi|acabo de pagar|pago realizado|transferencia realizada|te pague)\b/.test(value)) return 'reported_paid'
  if (/\b(datos (para|de) (la )?transferencia|clabe|numero de cuenta|a que cuenta|donde (te )?transfiero|quiero transferir|pasame (la )?cuenta)\b/.test(value)) return 'request_transfer_details'
  if (/\b(como (puedo )?pagar|metodos? de pago|formas? de pago|que pagos aceptan|aceptan (tarjeta|efectivo|transferencia))\b/.test(value)) return 'ask_methods'
  return 'none'
}

export function isAffirmative(text: string): boolean {
  return /^(si|confirmo|correcto|de acuerdo|adelante|confirmar|ok|okay)$/.test(normalize(text))
}

export function isNegative(text: string): boolean {
  return /^(no|cancelar|cancela|mejor no|olvidalo|olvida)$/.test(normalize(text))
}

export function selectedOption(text: string, maximum: number): number | null {
  const value = normalize(text)
  const words: Record<string,number> = { uno:1, una:1, dos:2, tres:3, cuatro:4, cinco:5 }
  const selected = /^\d+$/.test(value) ? Number(value) : words[value]
  return Number.isInteger(selected) && selected >= 1 && selected <= maximum ? selected - 1 : null
}

export function authorizeCartMutation(inputText: string, action: CartAction, proposedItems: CartChange[], inventory: InventoryItem[], cart: CartLine[]): CartAuthorization {
  if (!['add','remove','clear','show'].includes(action)) return { result: { status: 'rejected', message: 'No se solicitó una operación de carrito.' } }
  const text = normalize(inputText)
  if (/\b(no|nunca|sin)\b.*\b(agregar|agrega|anadir|anade|comprar|compra|quitar|quita|vaciar|vacia)\b/.test(text) || /\b(si|quizas|tal vez|podria|podrias)\b/.test(text)) {
    return { result: { status: 'rejected', message: 'No modifiqué el carrito porque la solicitud es negativa o condicional.' } }
  }
  if (action === 'show') return { result: { status: 'success', value: { action, items: [] } } }
  if (action === 'clear') {
    if (!/\b(vaciar|vacia|limpiar|limpia|eliminar todo|quitar todo)\b/.test(text)) return { result: { status: 'rejected', message: 'Necesito una solicitud explícita para vaciar el carrito.' } }
    return { result: { status: 'success', value: { action, items: [] } } }
  }
  const explicitVerb = action === 'add'
    ? /\b(agrega|agregame|anade|anademe|pon|quiero comprar|compra)\b/.test(text)
    : /\b(quita|quitame|elimina|remueve|saca)\b/.test(text)
  if (!explicitVerb) return { result: { status: 'rejected', message: 'No modifiqué el carrito porque no hay una solicitud explícita.' } }

  const available = action === 'add' ? inventory.filter(item => item.isActive) : cart.map(line => ({ ...line, id: 0, name: line.itemName, description: null, imageUrl: null, price: line.unitPrice, stockQuantity: null, isActive: true }))
  const exact = available.filter(item => text.includes(normalize(item.sku)) || text.includes(normalize(item.name)))
  const contextualReference=/\b(otro igual|otra igual|el mismo|la misma)\b/.test(text)||/\b(agrega|agregame|anade|anademe|pon)\s+(un[oa]?|dos|tres|cuatro|cinco|\d+)\b/.test(text)
  const contextual = contextualReference && cart.length === 1
    ? available.filter(item => item.sku === cart[0].sku) : []
  const matches = exact.length ? exact : contextual
  const explicitQuantity=quantityFromText(inputText)
  if(explicitQuantity!==null&&(!Number.isInteger(explicitQuantity)||explicitQuantity<1||explicitQuantity>100))return {result:{status:'rejected',message:'Indica una cantidad válida entre 1 y 100.'}}
  if (matches.length > 1) {
    const candidates = matches.slice(0, 5).map(item => ({ sku: item.sku, name: item.name }))
    return { result: { status: 'ambiguous', message: 'Encontré varias opciones. Indica cuál quieres.', options: candidates.map((item, index) => `${index + 1}. ${item.name} (${item.sku})`) }, candidates, quantity:explicitQuantity??1 }
  }
  if (!matches.length) {
    const terms = text.split(' ').filter(term => term.length >= 4)
    const candidates = available.filter(item => terms.some(term => normalize(item.name).includes(term))).slice(0, 5).map(item => ({ sku: item.sku, name: item.name }))
    if (candidates.length) return { result: { status: 'ambiguous', message: 'No pude identificar un artículo exacto. Elige una opción.', options: candidates.map((item, index) => `${index + 1}. ${item.name} (${item.sku})`) }, candidates, quantity:explicitQuantity??1 }
    return { result: { status: 'missing_information', message: 'Indica el producto o servicio exacto que quieres modificar en el carrito.' } }
  }
  const selected = matches[0]
  const proposal = proposedItems.find(item => item.sku === selected.sku)
  const quantity = explicitQuantity??proposal?.quantity??1
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) return { result: { status: 'rejected', message: 'Indica una cantidad válida entre 1 y 100.' } }
  return { result: { status: 'success', value: { action, items: [{ sku: selected.sku, quantity }] } } }
}

export function formatVerifiedCart(result: VerifiedResult<{ cart: CartLine[]; changed: boolean }>, action: CartAction): string {
  if (result.status !== 'success') return result.message
  if (!result.value.changed && action !== 'show') return 'No pude aplicar cambios al carrito con los datos indicados.'
  if (!result.value.cart.length) return action === 'show' ? 'Tu carrito está vacío.' : 'Carrito vaciado. No se realizó ningún cobro ni reserva.'
  const lines = result.value.cart.map(line => `• ${line.quantity} × ${line.itemName} — ${line.unitPrice === null ? 'precio por cotizar' : `${line.unitPrice} ${line.currency} c/u`}`)
  const heading = action === 'show' ? 'Tu carrito actual:' : 'Carrito actualizado:'
  return `${heading}\n${lines.join('\n')}\n\nEl carrito es informativo; no es un pedido confirmado, no se realizó ningún cobro ni se reservaron existencias.`
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
