import { createOrderFromCart, listOrders, listShoppingCarts, transitionOrderStatus } from '../../db'
import { ValidationError } from '../../errors'
import { AppSettings, loadAppSettings } from '../../ui/settings'
import { ApiContext, readJson, sendJson } from '../shared'

export async function handleSalesRoute({ request, response, url }: ApiContext,fallback:AppSettings): Promise<boolean> {
  if (request.method === 'GET' && url.pathname === '/api/carts') { sendJson(response,200,await listShoppingCarts());return true }
  if (request.method === 'GET' && url.pathname === '/api/orders') { sendJson(response,200,await listOrders());return true }
  const cartOrder=url.pathname.match(/^\/api\/carts\/(\d+)\/orders$/)
  if(request.method==='POST'&&cartOrder){const settings=await loadAppSettings(fallback);sendJson(response,201,{orderId:await createOrderFromCart(Number(cartOrder[1]),settings.orderReservationMinutes)});return true}
  const order=url.pathname.match(/^\/api\/orders\/(\d+)$/)
  if(request.method==='PATCH'&&order){
    const body=await readJson(request)
    if(!['confirmed','preparing','ready','out_for_delivery','completed','cancelled'].includes(body.status))throw new ValidationError('Estado de pedido no válido.','INVALID_ORDER_STATUS')
    const result=await transitionOrderStatus(Number(order[1]),body.status)
    sendJson(response,200,{message:result.duplicate?'El pedido ya tenía ese estado.':'Estado del pedido actualizado.',status:result.status,duplicate:result.duplicate});return true
  }
  return false
}
