import { getDashboardStats } from '../../db'
import { UiCallbacks } from '../../ui/settings'
import { ApiContext, readJson, sendJson } from '../shared'
import { ValidationError } from '../../errors'

export async function handleSystemRoute({ request, response, url }: ApiContext, callbacks: UiCallbacks): Promise<boolean> {
  if (request.method === 'GET' && url.pathname === '/api/status') { sendJson(response,200,callbacks.status());return true }
  if (request.method === 'GET' && url.pathname === '/api/summary') { sendJson(response,200,{...(await getDashboardStats()),...callbacks.status()});return true }
  if(request.method==='POST'&&url.pathname==='/api/conversations/clear'){
    const body=await readJson(request)
    if(body.confirm!=='VACIAR')throw new ValidationError('Escribe VACIAR para confirmar la eliminación del historial.','CLEAR_CONFIRMATION_REQUIRED')
    sendJson(response,200,{message:'Se vació el historial de conversaciones.',...await callbacks.clearConversations()});return true
  }
  return false
}
