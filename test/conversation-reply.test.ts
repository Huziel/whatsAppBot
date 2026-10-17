import test from 'node:test'
import assert from 'node:assert/strict'
import { catalogImageUrlForOutcome, finalizeProviderConversation, formatVerifiedRecommendations, resolveDeterministicOrProvider } from '../src/conversation-reply'
import type { InventoryItem } from '../src/db'

const inventory:InventoryItem[]=[
  {id:1,itemType:'product',sku:'REAL-1',name:'Producto real',description:null,imageUrl:null,price:'99.00',currency:'MXN',stockQuantity:4,isActive:true},
  {id:2,itemType:'product',sku:'REAL-2',name:'Producto real premium',description:null,imageUrl:null,price:'150.00',currency:'MXN',stockQuantity:0,isActive:true},
]
const settings={transferEnabled:true,transferBankName:'Banco',transferAccountHolder:'Titular',transferAccountNumber:'123',transferClabe:'012345678901234567',transferInstructions:'Referencia',appointmentsEnabled:true,appointmentTimeZone:'America/Mexico_City',appointmentDays:[1,2,3,4,5],appointmentStartTime:'09:00',appointmentEndTime:'17:00'}

test('saludos simples responden sin proveedor ni advertencia comercial',async()=>{
  for(const input of ['hola','¡Hola!','Buenos días','Buenas tardes','Buenas noches','Qué tal']){
    let calls=0
    const result=await resolveDeterministicOrProvider(input,settings,{listInventory:async()=>inventory,listOrders:async()=>[]},async()=>{calls++;return null})
    assert.equal(result.kind,'deterministic',input)
    assert.equal(calls,0,input)
    if(result.kind==='deterministic'){
      assert.equal(result.reply.outcome,'greeting')
      assert.equal(result.reply.text,'¡Hola! ¿En qué puedo ayudarte?')
    }
  }
})

test('saludo con solicitud conserva la intención específica',async()=>{
  let calls=0
  const result=await resolveDeterministicOrProvider('Hola, ¿cuánto cuesta REAL-1?',settings,{listInventory:async()=>inventory,listOrders:async()=>[]},async()=>{calls++;return null})
  assert.equal(result.kind,'deterministic');assert.equal(calls,0)
  if(result.kind==='deterministic'){assert.equal(result.reply.outcome,'inventory_success');assert.match(result.reply.text,/99\.00 MXN/)}
})

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
  if(result.kind==='deterministic'){assert.match(result.reply.text,/99\.00 MXN/);assert.match(result.reply.text,/existencias: 4/);assert.deepEqual(result.reply.selectedInventory,{sku:'REAL-1',name:'Producto real'})}
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

test('necesitar o buscar un producto consulta inventario y nunca modifica el carrito',async()=>{
  let calls=0
  const headphones=[...inventory,{id:3,itemType:'product' as const,sku:'AUD-BT-1',name:'Audífonos Bluetooth',description:null,imageUrl:null,price:'450.00',currency:'MXN',stockQuantity:3,isActive:true}]
  const result=await resolveDeterministicOrProvider('Necesito unos audífonos',settings,{listInventory:async()=>headphones,listOrders:async()=>[]},async()=>{calls++;return null})
  assert.equal(result.kind,'deterministic');assert.equal(calls,0)
  if(result.kind==='deterministic'){assert.equal(result.reply.outcome,'inventory_success');assert.match(result.reply.text,/Audífonos Bluetooth/);assert.match(result.reply.text,/450\.00 MXN/)}
  const unavailable=await resolveDeterministicOrProvider('Necesito unos audífonos',settings,{listInventory:async()=>inventory,listOrders:async()=>[]},async()=>{calls++;return null})
  assert.equal(unavailable.kind,'deterministic');assert.equal(calls,0)
  if(unavailable.kind==='deterministic')assert.match(unavailable.reply.text,/marca, modelo o alguna característica/i)
})

test('tienes o tiene más artículo se resuelve contra catálogo en vez de enviar fallback de IA',async()=>{
  const headphones=[...inventory,{id:3,itemType:'product' as const,sku:'AUD-DEMO',name:'DEMO - Audífonos',description:null,imageUrl:null,price:'499.00',currency:'MXN',stockQuantity:4,isActive:true}]
  for(const text of ['¿Tienes audífonos?','Por eso tiene audífonos?']){
    let calls=0
    const result=await resolveDeterministicOrProvider(text,settings,{listInventory:async()=>headphones,listOrders:async()=>[]},async()=>{calls++;return null})
    assert.equal(result.kind,'deterministic',text);assert.equal(calls,0,text)
    if(result.kind==='deterministic'){assert.equal(result.reply.outcome,'inventory_success');assert.match(result.reply.text,/DEMO - Audífonos/);assert.match(result.reply.text,/499\.00 MXN/)}
  }
  let unrelatedCalls=0
  const unrelated=await resolveDeterministicOrProvider('¿Tienes estacionamiento?',settings,{listInventory:async()=>headphones,listOrders:async()=>[]},async()=>{unrelatedCalls++;return null})
  assert.equal(unrelated.kind,'provider');assert.equal(unrelatedCalls,1)
})

test('preguntas formuladas con “venden” consultan el catálogo de forma determinista',async()=>{
  const headphones=[...inventory,{id:3,itemType:'product' as const,sku:'AUD-DEMO',name:'DEMO - Audífonos',description:null,imageUrl:null,price:'499.00',currency:'MXN',stockQuantity:4,isActive:true}]
  for(const text of ['¿Venden audífonos?','Me gustaría saber si venden audífonos?','Me gustaría saber si venden audifonos']){
    let calls=0
    const result=await resolveDeterministicOrProvider(text,settings,{listInventory:async()=>headphones,listOrders:async()=>[]},async()=>{calls++;return 'fallback'})
    assert.equal(result.kind,'deterministic',text)
    assert.equal(calls,0,text)
    if(result.kind==='deterministic'){
      assert.equal(result.reply.outcome,'inventory_success',text)
      assert.match(result.reply.text,/DEMO - Audífonos/,text)
      assert.deepEqual(result.reply.selectedInventory,{sku:'AUD-DEMO',name:'DEMO - Audífonos'})
    }
  }
})

test('respuesta de recomendación usa precios, existencias y descripción verificados',()=>{
  const reply=formatVerifiedRecommendations([inventory[0]])
  assert.match(reply,/Recomendado: Producto real \(REAL-1\)/)
  assert.match(reply,/Precio: 99\.00 MXN/)
  assert.match(reply,/Disponibles: 4/)
  assert.match(reply,/¿Quieres agregar alguna opción al carrito/)
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
    assert.equal(finalizeProviderConversation(text).outcome,'ai_reply_safety_fallback')
  }
  const neutral='Puedo ayudarte con consultas sobre productos, pedidos, pagos o citas.'
  assert.equal(finalizeProviderConversation(neutral).text,neutral)
  assert.equal(finalizeProviderConversation(neutral).outcome,'ai_reply')
  assert.equal(finalizeProviderConversation('Hola, ¿en qué puedo ayudarte?').text,'Hola, ¿en qué puedo ayudarte?')
})
