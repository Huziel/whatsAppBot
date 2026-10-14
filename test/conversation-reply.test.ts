import test from 'node:test'
import assert from 'node:assert/strict'
import { catalogImageUrlForOutcome, finalizeProviderConversation, resolveDeterministicOrProvider } from '../src/conversation-reply'
import type { InventoryItem } from '../src/db'

const inventory:InventoryItem[]=[
  {id:1,itemType:'product',sku:'REAL-1',name:'Producto real',description:null,imageUrl:null,price:'99.00',currency:'MXN',stockQuantity:4,isActive:true},
  {id:2,itemType:'product',sku:'REAL-2',name:'Producto real premium',description:null,imageUrl:null,price:'150.00',currency:'MXN',stockQuantity:0,isActive:true},
]
const settings={transferEnabled:true,transferBankName:'Banco',transferAccountHolder:'Titular',transferAccountNumber:'123',transferClabe:'012345678901234567',transferInstructions:'Referencia',appointmentsEnabled:true,appointmentTimeZone:'America/Mexico_City',appointmentDays:[1,2,3,4,5],appointmentStartTime:'09:00',appointmentEndTime:'17:00'}

test('consultas deterministas no llaman al proveedor simulado',async()=>{
  for(const input of ['¿Cuánto cuesta Producto real premium?','¿A cuánto está REAL-1?','¿Qué stock tiene REAL-1?','¿Les queda REAL-1?','¿Tienen REAL-1?','Muéstrame todos los productos','¿Cómo puedo pagar?','¿Cuáles son sus horarios?','¿Cuándo atienden?']){
    let calls=0
    const result=await resolveDeterministicOrProvider(input,settings,{listInventory:async()=>inventory,listOrders:async()=>[]},async()=>{calls++;return 'proveedor'})
    assert.equal(result.kind,'deterministic',input)
    assert.equal(calls,0,input)
  }
})

test('catálogo conserva el tipo y selecciona su imagen general',async()=>{
  const configured={...settings,productCatalogImageUrl:'https://example.com/products.jpg',serviceCatalogImageUrl:'https://example.com/services.jpg'}
  const result=await resolveDeterministicOrProvider('¿Qué productos venden?',configured,{listInventory:async()=>inventory,listOrders:async()=>[]},async()=>null)
  assert.equal(result.kind,'deterministic')
  if(result.kind==='deterministic'){
    assert.equal(result.reply.outcome,'catalog_products')
    assert.equal(catalogImageUrlForOutcome(result.reply.outcome,configured),'https://example.com/products.jpg')
  }
  assert.equal(catalogImageUrlForOutcome('catalog_services',configured),'https://example.com/services.jpg')
  assert.equal(catalogImageUrlForOutcome('ai_reply',configured),null)
  const services=await resolveDeterministicOrProvider('¿Tienes servicios?',configured,{listInventory:async()=>inventory,listOrders:async()=>[]},async()=>null)
  assert.equal(services.kind,'deterministic')
  if(services.kind==='deterministic'){
    assert.equal(services.reply.outcome,'catalog_services')
    assert.equal(catalogImageUrlForOutcome(services.reply.outcome,configured),'https://example.com/services.jpg')
  }
})

test('sí aislado sin intención pendiente no confirma ninguna operación',async()=>{
  let calls=0
  const result=await resolveDeterministicOrProvider('Sí',settings,{listInventory:async()=>inventory,listOrders:async()=>[]},async()=>{calls++;return null})
  assert.equal(result.kind,'deterministic');assert.equal(calls,0)
  if(result.kind==='deterministic')assert.match(result.reply.text,/no hay una operación pendiente/i)
})

test('precio y stock exactos funcionan aunque el proveedor esté caído',async()=>{
  let calls=0
  const result=await resolveDeterministicOrProvider('¿Cuánto cuesta REAL-1 y qué stock tiene?',settings,{listInventory:async()=>inventory,listOrders:async()=>[]},async()=>{calls++;throw new Error('caído')})
  assert.equal(result.kind,'deterministic')
  assert.equal(calls,0)
  if(result.kind==='deterministic'){assert.match(result.reply.text,/99\.00 MXN/);assert.match(result.reply.text,/existencias: 4/)}
})

test('consulta ambigua pide aclaración sin usar al proveedor',async()=>{
  let calls=0
  const result=await resolveDeterministicOrProvider('¿Cuánto cuesta Producto?',settings,{listInventory:async()=>inventory,listOrders:async()=>[]},async()=>{calls++;return null})
  assert.equal(result.kind,'deterministic');assert.equal(calls,0)
  if(result.kind==='deterministic')assert.match(result.reply.text,/opciones/i)
})

test('consulta de inventario distingue dato faltante de artículo inexistente',async()=>{
  const ports={listInventory:async()=>inventory,listOrders:async()=>[]}
  const missing=await resolveDeterministicOrProvider('¿Cuánto cuesta?',settings,ports,async()=>null)
  const unknown=await resolveDeterministicOrProvider('¿Cuánto cuesta SKU-INEXISTENTE?',settings,ports,async()=>null)
  assert.equal(missing.kind,'deterministic');assert.equal(unknown.kind,'deterministic')
  if(missing.kind==='deterministic')assert.match(missing.reply.text,/indica el nombre o sku/i)
  if(unknown.kind==='deterministic')assert.match(unknown.reply.text,/no encontré/i)
})

test('vocabulario genérico no captura citas, pagos, pedidos ni preguntas ajenas',async()=>{
  const ports={listInventory:async()=>inventory,listOrders:async()=>[{id:7,status:'pending',total:'99.00',currency:'MXN'}]}
  const expected:[string,'deterministic'|'provider'][]=[
    ['¿Hay citas disponibles?','provider'],
    ['¿Tienen transferencia?','deterministic'],
    ['¿Cuánto cuesta mi pedido?','deterministic'],
    ['¿Hay estacionamiento?','provider'],
    ['¿Tienen REAL-1?','deterministic'],
  ]
  for(const [input,kind] of expected){
    const result=await resolveDeterministicOrProvider(input,settings,ports,async()=>null)
    assert.equal(result.kind,kind,input)
  }
})

test('fallo MySQL determinista no se disfraza como vacío ni consulta al proveedor',async()=>{
  let calls=0
  const result=await resolveDeterministicOrProvider('¿Qué stock tiene REAL-1?',settings,{listInventory:async()=>{throw new Error('db')},listOrders:async()=>[]},async()=>{calls++;return null})
  assert.equal(result.kind,'deterministic');assert.equal(calls,0)
  if(result.kind==='deterministic'){assert.match(result.reply.text,/no pude verificar/i);assert.doesNotMatch(result.reply.text,/agotado|no existe/i)}
})

test('texto crítico del proveedor simulado no llega como afirmación',()=>{
  for(const text of ['Tu reserva quedó lista','Ya está incluido en tu compra','Cuesta 10 MXN y quedan 8','Recibimos tu transferencia','Tienes una promoción inexistente','Listo, ya añadí dos REAL-1','Quedan ocho unidades','Vale noventa y nueve pesos','Aceptamos Visa','Abrimos de lunes a viernes']){
    assert.notEqual(finalizeProviderConversation(text).text,text)
  }
  assert.equal(finalizeProviderConversation('Hola, ¿en qué puedo ayudarte?').text,'Hola, ¿en qué puedo ayudarte?')
})
