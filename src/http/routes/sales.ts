import { createOrderFromCart, listOrders, listShoppingCarts, setOrderStatus } from '../../db'
import { ApiContext, readJson, sendJson } from '../shared'

export async function handleSalesRoute({ request, response, url }: ApiContext): Promise<boolean> {
  if (request.method === 'GET' && url.pathname === '/api/carts') { sendJson(response,200,await listShoppingCarts());return true }
  if (request.method === 'GET' && url.pathname === '/api/orders') { sendJson(response,200,await listOrders());return true }
  const cartOrder=url.pathname.match(/^\/api\/carts\/(\d+)\/orders$/)
  if(request.method==='POST'&&cartOrder){sendJson(response,201,{orderId:await createOrderFromCart(Number(cartOrder[1]))});return true}
  const order=url.pathname.match(/^\/api\/orders\/(\d+)$/)
  if(request.method==='PATCH'&&order){
    const body=await readJson(request)
    if(!['confirmed','cancelled'].includes(body.status))throw new Error('Estado de pedido no válido')
    const changed=await setOrderStatus(Number(order[1]),body.status)
    sendJson(response,changed?200:404,changed?{message:'Estado del pedido actualizado'}:{error:'Pedido no encontrado o ya procesado'});return true
  }
  return false
}
