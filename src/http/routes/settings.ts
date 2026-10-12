import { UiCallbacks, AppSettings, loadAppSettings, saveAppSettings } from '../../ui/settings'
import { getDashboardStats } from '../../db'
import { ApiContext, readJson, sendJson } from '../shared'

export async function handleSettingsRoute({ request, response, url }: ApiContext, fallback: AppSettings, callbacks: UiCallbacks): Promise<boolean> {
  if (request.method === 'GET' && url.pathname === '/api/settings') {
    const { deepseekApiKey, ...settings } = await loadAppSettings(fallback)
    sendJson(response, 200, { ...settings, deepseekApiKeyConfigured: !!deepseekApiKey })
    return true
  }
  if (request.method === 'POST' && url.pathname === '/api/settings') {
    const settings = await saveAppSettings(await readJson(request), fallback)
    await callbacks.applySettings?.(settings)
    sendJson(response, 200, { message: 'Configuración guardada.', deepseekApiKeyConfigured: !!settings.deepseekApiKey })
    return true
  }
  if (request.method === 'POST' && url.pathname === '/api/start') {
    await callbacks.start(await loadAppSettings(fallback))
    sendJson(response, 200, { message: 'Servicio iniciado. Escanea el QR mostrado en la terminal.' })
    return true
  }
  if (request.method === 'POST' && url.pathname === '/api/logout') {
    await callbacks.logout()
    sendJson(response, 200, { message: 'Sesión cerrada y credenciales locales eliminadas.' })
    return true
  }
  if (request.method === 'GET' && url.pathname === '/api/status') {
    sendJson(response, 200, callbacks.status())
    return true
  }
  if (request.method === 'GET' && url.pathname === '/api/summary') {
    sendJson(response, 200, { ...(await getDashboardStats()), ...callbacks.status() })
    return true
  }
  return false
}
