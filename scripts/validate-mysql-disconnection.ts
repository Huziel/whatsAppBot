import assert from 'node:assert/strict'
import { launchDashboardServer } from '../src/http/server'
import { closePool } from '../src/db'
import type { AppSettings } from '../src/ui/settings'

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

async function main(): Promise<void> {
  const server = await launchDashboardServer(fallback, {
    start: async () => undefined, logout: async () => undefined, sendManualMessage: async () => undefined,
    deleteContact: async () => false,
    clearConversations: async () => ({messages:0,chats:0,turns:0}),
    status: () => ({ serviceStatus: 'mocked', disconnectCode: null, pendingWrites: 0 }),
  }, 3102)
  try {
    const response = await fetch('http://127.0.0.1:3102/api/summary')
    const payload: any = await response.json()
    assert.equal(response.status, 503)
    assert.match(payload.error, /MySQL no está disponible/)
    assert.doesNotMatch(payload.error, /ECONNREFUSED|127\.0\.0\.1|SQLSTATE/)
    console.info(JSON.stringify({ status: response.status, error: payload.error }))
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await closePool()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
