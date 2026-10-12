import { $, api, setNotice } from '../api.js'
import { saveSettings } from './settings.js'
import { refreshDashboard, updateConnection } from './dashboard.js'

let busy=false

export function initializeService(){
  document.querySelectorAll('.start-service').forEach(button=>button.addEventListener('click',start))
  document.querySelectorAll('.logout-service').forEach(button=>button.addEventListener('click',logout))
  refreshStatus();setInterval(refreshStatus,3000);setInterval(refreshDashboard,15000)
}

async function start(){
  if(busy)return
  busy=true;document.querySelectorAll('.start-service').forEach(button=>button.disabled=true)
  try{if(!await saveSettings())return;const result=await api('/api/start','POST',{});setNotice('globalNotice',result.message,'success');await refreshStatus()}
  catch(error){setNotice('globalNotice',error.message,'error')}
  finally{busy=false;await refreshStatus()}
}

async function logout(){
  if(!confirm('¿Cerrar la sesión vinculada y eliminar las credenciales locales? Para volver a conectar tendrás que escanear un QR.'))return
  try{const result=await api('/api/logout','POST',{});setNotice('globalNotice',result.message,'success');await refreshStatus()}
  catch(error){setNotice('globalNotice',error.message,'error')}
}

async function refreshStatus(){
  try{const status=await api('/api/status');updateConnection(status);const active=['connecting','waiting-qr','connected','reconnecting'].includes(status.serviceStatus);document.querySelectorAll('.start-service').forEach(button=>button.disabled=active||busy)}
  catch(error){setNotice('globalNotice',error.message,'error')}
}
