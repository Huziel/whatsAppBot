import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { launchDashboardServer } from '../src/http/server'
import { closePool, deleteContactData } from '../src/db'
import type { AppSettings } from '../src/ui/settings'

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const outputDir = process.env.BROWSER_OUTPUT_DIR ?? path.resolve('browser-artifacts')
const browserDataDir = path.join(outputDir, 'edge-profile')
const debuggingPort = 9223
const dashboardPort = 3101

const fallback: AppSettings = {
  botName: 'Bot de prueba', businessName: 'Negocio de prueba', autoReply: false,
  responseMode: 'fixed', responseText: 'Respuesta simulada', replyDelayMs: 1500,
  saveToDatabase: true, deepseekApiKey: '', deepseekModel: 'deepseek-flash',
  aiTone: 'professional', aiResponseLength: 'brief', aiSystemInstructions: '',
  maxRepliesPerHour: 20, messageRetentionDays: 0, orderReservationMinutes:15,productCatalogImageUrl: null,
  serviceCatalogImageUrl: null, transferEnabled: false, transferBankName: '',
  transferAccountHolder: '', transferAccountNumber: '', transferClabe: '', transferInstructions: '',
  appointmentsEnabled: false, appointmentTimeZone: 'America/Mexico_City', appointmentDays: [1,2,3,4,5],
  appointmentStartTime: '09:00', appointmentEndTime: '17:00', appointmentDurationMinutes: 60,
}

type PendingCommand = { resolve: (value: any) => void; reject: (reason: unknown) => void }

async function waitFor<T>(action: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try { return await action() } catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  throw lastError ?? new Error('Tiempo de espera agotado')
}

async function main(): Promise<void> {
  assert.match(process.env.DB_NAME ?? '', /test/i, 'DB_NAME debe apuntar a una base de prueba')
  assert.ok(process.env.APP_DATA_DIR, 'APP_DATA_DIR debe estar aislado')
  await fs.mkdir(outputDir, { recursive: true })
  await fs.rm(browserDataDir, { recursive: true, force: true })

  const server = await launchDashboardServer(fallback, {
    start: async () => undefined,
    logout: async () => undefined,
    sendManualMessage: async () => { throw new Error('Envío real deshabilitado en validación') },
    deleteContact: deleteContactData,
    clearConversations: async () => ({messages:0,chats:0,turns:0}),
    status: () => ({ serviceStatus: 'mocked', disconnectCode: null, pendingWrites: 0 }),
  }, dashboardPort)
  const edge = spawn(edgePath, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${browserDataDir}`, 'about:blank',
  ], { stdio: 'ignore' })

  let socket: WebSocket | undefined
  try {
    const target: any = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${dashboardPort}/#dashboard`)}`, { method: 'PUT' })
      if (!response.ok) throw new Error(`CDP respondió ${response.status}`)
      return response.json()
    })
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => { socket!.addEventListener('open', () => resolve(), { once: true }); socket!.addEventListener('error', reject, { once: true }) })

    let commandId = 0
    const pending = new Map<number, PendingCommand>()
    const pageErrors: string[] = []
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      if (message.id) {
        const command = pending.get(message.id)
        if (!command) return
        pending.delete(message.id)
        if (message.error) command.reject(new Error(message.error.message)); else command.resolve(message.result)
      } else if (message.method === 'Runtime.exceptionThrown') {
        pageErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'Error de página')
      }
    })
    const command = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
      const id = ++commandId
      pending.set(id, { resolve, reject })
      socket!.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async (expression: string) => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result.value
    }
    const waitForJs = (expression: string) => waitFor(async () => {
      const value = await evaluate(expression)
      if (!value) throw new Error(`Condición pendiente: ${expression}`)
      return value
    })
    const screenshot = async (name: string) => {
      const metrics = await command('Page.getLayoutMetrics')
      const { width, height } = metrics.cssContentSize
      const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } })
      await fs.writeFile(path.join(outputDir, name), Buffer.from(result.data, 'base64'))
    }

    await command('Page.enable')
    await command('Runtime.enable')
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await waitForJs("document.readyState === 'complete' && document.querySelector('#metricContacts').textContent !== '—'")
    await screenshot('dashboard-desktop.png')

    await evaluate("location.hash='settings'")
    await waitForJs("!document.querySelector('#view-settings').classList.contains('hidden')")
    await evaluate("const input=document.querySelector('#botName');input.value='UI escritorio validado';input.dispatchEvent(new Event('input',{bubbles:true}));true")
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#saveState')).display !== 'none'"), true)
    await evaluate("document.querySelector('[data-route=\"ai\"]').click()")
    await waitForJs("!document.querySelector('#view-ai').classList.contains('hidden')")
    assert.equal(await evaluate("document.querySelector('#botName').value"), 'UI escritorio validado')
    await evaluate("document.querySelector('[data-route=\"settings\"]').click();document.querySelector('#saveSettingsTop').click()")
    await waitForJs("document.querySelector('#globalNotice').textContent.includes('guardada')")
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#saveState')).display === 'none'"), true)
    assert.equal(await evaluate("document.querySelector('#deepseekApiKey').value === '' && document.querySelector('#deepseekApiKey').placeholder.includes('conserva')"), true)
    await screenshot('settings-desktop.png')

    await command('Page.reload', { ignoreCache: true })
    await waitForJs("document.readyState === 'complete' && document.querySelector('#botName').value === 'UI escritorio validado'")
    const keyConfigured = await evaluate("fetch('/api/settings').then(r=>r.json()).then(s=>s.deepseekApiKeyConfigured)")
    assert.equal(keyConfigured, true)

    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await evaluate("location.hash='settings'")
    await waitForJs("getComputedStyle(document.querySelector('#saveSettingsMobile')).display !== 'none'")
    await evaluate("const input=document.querySelector('#businessName');input.value='UI móvil validado';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#saveSettingsMobile').click();true")
    await waitForJs("document.querySelector('#globalNotice').textContent.includes('guardada')")
    await screenshot('settings-mobile.png')
    await command('Page.reload', { ignoreCache: true })
    await waitForJs("document.readyState === 'complete' && document.querySelector('#businessName').value === 'UI móvil validado'")
    await evaluate("location.hash='dashboard'")
    await waitForJs("!document.querySelector('#view-dashboard').classList.contains('hidden')")
    assert.equal(await evaluate("document.querySelector('#dashboardBusinessName').textContent"), 'UI móvil validado')
    await screenshot('dashboard-mobile.png')

    assert.deepEqual(pageErrors, [])
    console.info(JSON.stringify({ desktopSave: true, mobileSave: true, pendingNavigation: true, apiKeyPreserved: true, reloadPersistence: true, pageErrors, screenshots: ['dashboard-desktop.png','settings-desktop.png','settings-mobile.png','dashboard-mobile.png'] }))
  } finally {
    socket?.close()
    edge.kill()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await closePool()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
