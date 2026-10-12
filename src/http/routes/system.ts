import { getDashboardStats } from '../../db'
import { UiCallbacks } from '../../ui/settings'
import { ApiContext, sendJson } from '../shared'

export async function handleSystemRoute({ request, response, url }: ApiContext, callbacks: UiCallbacks): Promise<boolean> {
  if (request.method === 'GET' && url.pathname === '/api/status') { sendJson(response,200,callbacks.status());return true }
  if (request.method === 'GET' && url.pathname === '/api/summary') { sendJson(response,200,{...(await getDashboardStats()),...callbacks.status()});return true }
  return false
}
