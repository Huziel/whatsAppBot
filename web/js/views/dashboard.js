import { $, api } from '../api.js'
import { getSettings, subscribeSettings } from '../state.mjs'

function renderConfiguredSummary(settings){
  if(!settings)return
  $('dashboardBusinessName').textContent=settings.businessName
  $('metricAiMode').textContent=settings.autoReply?(settings.responseMode==='deepseek'?'DeepSeek':'Texto fijo'):'Desactivadas'
}

export function initializeDashboard(){renderConfiguredSummary(getSettings());subscribeSettings(renderConfiguredSummary)}

export async function refreshDashboard(){
  try{
    const summary=await api('/api/summary')
    $('metricContacts').textContent=Number(summary.contacts).toLocaleString('es-MX')
    $('metricUnresolved').textContent='Sin resolver: '+Number(summary.unresolvedIdentities).toLocaleString('es-MX')
    $('metricChats').textContent=Number(summary.chats).toLocaleString('es-MX')
    $('metricMessages').textContent=Number(summary.messages).toLocaleString('es-MX')
    $('metricPending').textContent=Number(summary.pendingWrites).toLocaleString('es-MX')
    $('pendingBadge').textContent='Pendientes: '+Number(summary.pendingWrites).toLocaleString('es-MX')
    updateConnection(summary)
  }catch(error){$('dashboardServiceState').textContent='Resumen no disponible';$('globalNotice').textContent=error.message;$('globalNotice').classList.remove('hidden')}
}

export function updateConnection(state){
  const labels={stopped:'Detenido',connecting:'Conectando','waiting-qr':'Esperando QR',connected:'Conectado',reconnecting:'Reconectando','logged-out':'Requiere QR',error:'Error'}
  const label=labels[state.serviceStatus]||state.serviceStatus||'Desconocido'
  $('connectionBadge').textContent=label
  $('connectionDetail').textContent=state.disconnectCode?'Último código de desconexión: '+state.disconnectCode:'El QR de vinculación se muestra en la terminal.'
  $('dashboardServiceState').textContent=label
  const dot=$('connectionDot');dot.className='h-2.5 w-2.5 rounded-full '+(label==='Conectado'?'bg-whatsapp shadow-[0_0_12px_#25D366]':label==='Error'||label==='Requiere QR'?'bg-danger':'bg-amber')
}
