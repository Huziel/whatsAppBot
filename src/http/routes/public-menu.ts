import { assertPublicOrderSchema, createPublicMenuOrder, getPublicOrder, hasPublicOrderKey, listActiveInventoryPage } from '../../db'
import type { PublicOrderItemInput } from '../../db'
import { NotFoundError, RateLimitError, ValidationError } from '../../errors'
import { loadAppSettings, AppSettings } from '../../ui/settings'
import { ApiContext, readJson, sendJson } from '../shared'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

const checkoutAttemptsByPhone=new Map<string,number[]>(),checkoutAttemptsByClient=new Map<string,number[]>()
const lookupAttemptsByClient=new Map<string,number[]>()
let globalCheckoutAttempts:number[]=[]
const checkoutWindowMs=60*60*1000
const maxOrdersPerPhonePerHour=5
const maxAttemptsPerClientPerHour=20,maxGlobalAttemptsPerMinute=120,maxLimiterKeys=5_000
const maxLookupsPerClientPerMinute=120

function normalizePhone(value:unknown):string{
  const input=typeof value==='string'?value.trim():''
  if(!/^\+?[0-9\s().-]{8,24}$/.test(input))throw new ValidationError('Escribe un número de WhatsApp con prefijo internacional, por ejemplo +52 55 1234 5678.','INVALID_PHONE')
  const digits=input.replace(/\D/g,'')
  if(digits.length<8||digits.length>15)throw new ValidationError('El número de WhatsApp debe tener entre 8 y 15 dígitos internacionales.','INVALID_PHONE')
  return digits
}

function digest(value:string):string{return createHash('sha256').update(value).digest('hex')}
function clientKey(request:ApiContext['request']):string{
  const remote=request.socket.remoteAddress??'unknown'
  const forwarded=String(request.headers['x-forwarded-for']??'').trim()
  const trustedProxy=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)
  const address=trustedProxy&&forwarded&&!forwarded.includes(',')&&isIP(forwarded)?forwarded:remote
  return digest(address)
}
function recent(map:Map<string,number[]>,key:string,windowMs:number,now:number):number[]{const values=(map.get(key)??[]).filter(timestamp=>now-timestamp<windowMs);map.set(key,values);return values}
function trimLimiter(map:Map<string,number[]>):void{while(map.size>maxLimiterKeys)map.delete(map.keys().next().value!)}
function allowClientCheckout(client:string,now=Date.now()):{allowed:boolean;retryAfter:number}{
  globalCheckoutAttempts=globalCheckoutAttempts.filter(timestamp=>now-timestamp<60_000)
  const clientAttempts=recent(checkoutAttemptsByClient,client,checkoutWindowMs,now)
  trimLimiter(checkoutAttemptsByClient)
  if(globalCheckoutAttempts.length>=maxGlobalAttemptsPerMinute)return {allowed:false,retryAfter:60}
  if(clientAttempts.length>=maxAttemptsPerClientPerHour)return {allowed:false,retryAfter:3600}
  globalCheckoutAttempts.push(now);clientAttempts.push(now);checkoutAttemptsByClient.set(client,clientAttempts)
  return {allowed:true,retryAfter:0}
}
function allowPhoneCheckout(phone:string,now=Date.now()):boolean{
  const attempts=recent(checkoutAttemptsByPhone,digest(phone),checkoutWindowMs,now);trimLimiter(checkoutAttemptsByPhone)
  return attempts.length<maxOrdersPerPhonePerHour
}
function allowPublicLookup(client:string,now=Date.now()):boolean{
  const attempts=recent(lookupAttemptsByClient,client,60_000,now);trimLimiter(lookupAttemptsByClient)
  if(attempts.length>=maxLookupsPerClientPerMinute)return false
  attempts.push(now);lookupAttemptsByClient.set(client,attempts);return true
}
function recordSuccessfulCheckout(phone:string,now=Date.now()):void{
  const key=digest(phone),attempts=recent(checkoutAttemptsByPhone,key,checkoutWindowMs,now);attempts.push(now);checkoutAttemptsByPhone.set(key,attempts);trimLimiter(checkoutAttemptsByPhone)
}

function accessTokenFromHeader(value:string|undefined):string{
  const match=value?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)
  if(!match)throw new NotFoundError('Pedido no encontrado.','PUBLIC_ORDER_NOT_FOUND')
  return match[1]
}

export async function handlePublicMenuRoute({request,response,url}:ApiContext,fallback:AppSettings):Promise<boolean>{
  if(request.method==='GET'&&url.pathname==='/api/public/menu'){
    if(!allowPublicLookup(clientKey(request))){response.setHeader('Retry-After','60');throw new RateLimitError('Se alcanzó el límite temporal de consultas. Inténtalo más tarde.','PUBLIC_MENU_RATE_LIMITED')}
    const after=Number(url.searchParams.get('after')??0)
    if(!Number.isSafeInteger(after)||after<0)throw new ValidationError('El cursor del catálogo no es válido.','INVALID_CATALOG_CURSOR')
    const [inventory,settings]=await Promise.all([listActiveInventoryPage(after,500),loadAppSettings(fallback)])
    const nextCursor=inventory.length===500?inventory.at(-1)!.id:null
    const items=inventory.map(({id:_,reservedQuantity:__,availableQuantity:___,isActive:____,...item})=>item)
    sendJson(response,200,{businessName:settings.businessName,productCatalogImageUrl:settings.productCatalogImageUrl,serviceCatalogImageUrl:settings.serviceCatalogImageUrl,items,nextCursor})
    return true
  }
  const statusMatch=url.pathname.match(/^\/api\/public\/orders\/([A-Z0-9-]{6,20})$/)
  if(request.method==='GET'&&statusMatch){
    const accessToken=accessTokenFromHeader(request.headers.authorization)
    if(!allowPublicLookup(clientKey(request))){response.setHeader('Retry-After','60');throw new RateLimitError('Se alcanzó el límite temporal de consultas. Inténtalo más tarde.','ORDER_LOOKUP_RATE_LIMITED')}
    await assertPublicOrderSchema()
    const order=await getPublicOrder(statusMatch[1],accessToken)
    if(!order)throw new NotFoundError('Pedido no encontrado.','PUBLIC_ORDER_NOT_FOUND')
    sendJson(response,200,order);return true
  }
  if(request.method==='POST'&&url.pathname==='/api/public/orders'){
    const body=await readJson(request)
    if(typeof body.website==='string'&&body.website.trim())throw new ValidationError('No se pudo validar el pedido.','CHECKOUT_REJECTED')
    const phone=normalizePhone(body.phoneNumber)
    const customerName=typeof body.customerName==='string'?body.customerName.trim():''
    if(customerName.length>160)throw new ValidationError('El nombre admite hasta 160 caracteres.','INVALID_CUSTOMER_NAME')
    const orderKey=typeof body.orderKey==='string'?body.orderKey:''
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderKey))throw new ValidationError('No se pudo identificar esta solicitud. Recarga el menú e inténtalo de nuevo.','INVALID_IDEMPOTENCY_KEY')
    const accessToken=typeof body.accessToken==='string'?body.accessToken:''
    if(!/^[A-Za-z0-9_-]{43}$/.test(accessToken))throw new ValidationError('No se pudo proteger la consulta del pedido. Recarga el menú e inténtalo de nuevo.','INVALID_ACCESS_TOKEN')
    if(!Array.isArray(body.items)||body.items.length<1||body.items.length>30)throw new ValidationError('El pedido debe tener entre 1 y 30 artículos.','INVALID_ORDER_ITEMS')
    const seen=new Set<string>(),items:PublicOrderItemInput[]=[]
    let totalUnits=0
    for(const item of body.items){
      if(typeof item?.sku!=='string'||!/^[A-Za-z0-9._-]{1,64}$/.test(item.sku)||seen.has(item.sku))throw new ValidationError('El pedido contiene un artículo no válido o repetido.','INVALID_ORDER_ITEMS')
      if(!Number.isInteger(item.quantity)||item.quantity<1||item.quantity>100)throw new ValidationError('Cada cantidad debe ser un entero de 1 a 100.','INVALID_ORDER_QUANTITY')
      seen.add(item.sku);items.push({sku:item.sku,quantity:item.quantity});totalUnits+=item.quantity
    }
    if(totalUnits>100)throw new ValidationError('El pedido admite como máximo 100 unidades en total.','ORDER_TOO_LARGE')
    const client=clientKey(request),clientLimit=allowClientCheckout(client)
    if(!clientLimit.allowed){response.setHeader('Retry-After',String(clientLimit.retryAfter));throw new RateLimitError('Se alcanzó el límite temporal de pedidos. Inténtalo más tarde.','CHECKOUT_RATE_LIMITED')}
    await assertPublicOrderSchema()
    const duplicateKey=await hasPublicOrderKey(orderKey)
    if(!duplicateKey&&!allowPhoneCheckout(phone)){response.setHeader('Retry-After','3600');throw new RateLimitError('Se alcanzó el límite temporal de pedidos. Inténtalo más tarde.','CHECKOUT_RATE_LIMITED')}
    const settings=await loadAppSettings(fallback)
    const order=await createPublicMenuOrder(phone,customerName||null,items,orderKey,accessToken,settings.orderReservationMinutes)
    if(!order.duplicate)recordSuccessfulCheckout(phone)
    sendJson(response,order.duplicate?200:201,{publicId:order.publicId,status:order.status,paymentStatus:order.paymentStatus,total:order.total,currency:order.currency,expiresAt:order.expiresAt,statusPath:`/pedido/${order.publicId}`,message:order.duplicate?'Este pedido ya quedó registrado.':'Pedido reservado y enviado para confirmación.'})
    return true
  }
  return false
}
