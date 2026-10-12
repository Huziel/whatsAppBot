import { AppSettings, UiCallbacks } from '../ui/settings'
import { handleAppointmentRoute } from './routes/appointments'
import { handleContactsRoute } from './routes/contacts'
import { handleInventoryRoute } from './routes/inventory'
import { handleSalesRoute } from './routes/sales'
import { handleSettingsRoute } from './routes/settings'
import { handleSystemRoute } from './routes/system'
import { ApiContext, sendJson } from './shared'

type RouteHandler = (context: ApiContext, fallback: AppSettings, callbacks: UiCallbacks) => Promise<boolean>
const mysqlConnectionErrors = new Set(['ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','PROTOCOL_CONNECTION_LOST','ER_ACCESS_DENIED_ERROR','ER_BAD_DB_ERROR'])
const routeHandlers: RouteHandler[] = [
  (context,fallback,callbacks) => handleSettingsRoute(context,fallback,callbacks),
  (context,_fallback,callbacks) => handleSystemRoute(context,callbacks),
  (context,_fallback,callbacks) => handleContactsRoute(context,callbacks),
  context => handleInventoryRoute(context),
  context => handleSalesRoute(context),
  (context,fallback) => handleAppointmentRoute(context,fallback),
]

export async function handleApiRequest(context: ApiContext, fallback: AppSettings, callbacks: UiCallbacks): Promise<boolean> {
  try {
    for (const handler of routeHandlers) if (await handler(context,fallback,callbacks)) return true
    if (context.url.pathname.startsWith('/api/')) { sendJson(context.response,404,{error:'Ruta API no encontrada'});return true }
    return false
  } catch(error:any) {
    if (mysqlConnectionErrors.has(error?.code)) {
      sendJson(context.response,503,{error:'MySQL no está disponible. Revisa que el servidor esté iniciado y que la conexión configurada sea correcta.'})
    } else {
      sendJson(context.response,400,{error:error.message||'Error interno'})
    }
    return true
  }
}
