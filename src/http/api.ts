import { AppSettings, UiCallbacks } from '../ui/settings'
import { handleAppointmentRoute } from './routes/appointments'
import { handleContactsRoute } from './routes/contacts'
import { handleInventoryRoute } from './routes/inventory'
import { handleSalesRoute } from './routes/sales'
import { handleSettingsRoute } from './routes/settings'
import { handleSystemRoute } from './routes/system'
import { handlePublicMenuRoute } from './routes/public-menu'
import { ApiContext, sendError, sendJson } from './shared'

type RouteHandler = (context: ApiContext, fallback: AppSettings, callbacks: UiCallbacks) => Promise<boolean>
const routeHandlers: RouteHandler[] = [
  (context,fallback) => handlePublicMenuRoute(context,fallback),
  (context,fallback,callbacks) => handleSettingsRoute(context,fallback,callbacks),
  (context,_fallback,callbacks) => handleSystemRoute(context,callbacks),
  (context,_fallback,callbacks) => handleContactsRoute(context,callbacks),
  context => handleInventoryRoute(context),
  (context,fallback) => handleSalesRoute(context,fallback),
  (context,fallback) => handleAppointmentRoute(context,fallback),
]

export async function handleApiRequest(context: ApiContext, fallback: AppSettings, callbacks: UiCallbacks): Promise<boolean> {
  try {
    for (const handler of routeHandlers) if (await handler(context,fallback,callbacks)) return true
    if (context.url.pathname.startsWith('/api/')) { sendJson(context.response,404,{error:'Ruta API no encontrada'});return true }
    return false
  } catch(error:any) {
    sendError(context.response,error)
    return true
  }
}
