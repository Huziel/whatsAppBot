import { $, api, setNotice } from '../api.js'
import { setSettings, updateSettingsDraft } from '../state.mjs'

const values = () => ({
  botName:$('botName').value,businessName:$('businessName').value,autoReply:$('autoReply').checked,
  responseMode:$('responseMode').value,responseText:$('responseText').value,replyDelayMs:Number($('delay').value),
  saveToDatabase:$('saveToDatabase').checked,deepseekModel:$('deepseekModel').value,aiTone:$('aiTone').value,
  aiResponseLength:$('aiResponseLength').value,aiSystemInstructions:$('aiSystemInstructions').value,
  maxRepliesPerHour:Number($('maxRepliesPerHour').value),messageRetentionDays:Number($('messageRetentionDays').value),
  productCatalogImageUrl:$('productCatalogImageUrl').value||null,serviceCatalogImageUrl:$('serviceCatalogImageUrl').value||null,
  transferEnabled:$('transferEnabled').checked,transferBankName:$('transferBankName').value,
  transferAccountHolder:$('transferAccountHolder').value,transferAccountNumber:$('transferAccountNumber').value,
  transferClabe:$('transferClabe').value,transferInstructions:$('transferInstructions').value,
  appointmentsEnabled:$('appointmentsEnabled').checked,appointmentTimeZone:$('appointmentTimeZone').value,
  appointmentDays:[...document.querySelectorAll('.appointmentDay:checked')].map(element=>Number(element.value)),
  appointmentStartTime:$('appointmentStartTime').value,appointmentEndTime:$('appointmentEndTime').value,
  appointmentDurationMinutes:Number($('appointmentDurationMinutes').value),
  deepseekApiKey:$('deepseekApiKey').value,clearDeepseekApiKey:$('clearDeepseekApiKey').checked,
})

function fill(settings){
  const mapping={botName:'botName',businessName:'businessName',autoReply:'autoReply',responseMode:'responseMode',responseText:'responseText',replyDelayMs:'delay',saveToDatabase:'saveToDatabase',deepseekModel:'deepseekModel',aiTone:'aiTone',aiResponseLength:'aiResponseLength',aiSystemInstructions:'aiSystemInstructions',maxRepliesPerHour:'maxRepliesPerHour',messageRetentionDays:'messageRetentionDays',productCatalogImageUrl:'productCatalogImageUrl',serviceCatalogImageUrl:'serviceCatalogImageUrl',transferEnabled:'transferEnabled',transferBankName:'transferBankName',transferAccountHolder:'transferAccountHolder',transferAccountNumber:'transferAccountNumber',transferClabe:'transferClabe',transferInstructions:'transferInstructions',appointmentsEnabled:'appointmentsEnabled',appointmentTimeZone:'appointmentTimeZone',appointmentStartTime:'appointmentStartTime',appointmentEndTime:'appointmentEndTime',appointmentDurationMinutes:'appointmentDurationMinutes'}
  for(const [key,id] of Object.entries(mapping)){const el=$(id);if(el.type==='checkbox')el.checked=Boolean(settings[key]);else el.value=settings[key]??''}
  document.querySelectorAll('.appointmentDay').forEach(el=>el.checked=settings.appointmentDays.includes(Number(el.value)))
  $('deepseekApiKey').value=''
  $('deepseekApiKey').placeholder=settings.deepseekApiKeyConfigured?'API key guardada; vacío conserva la actual':'Introduce la API key'
  $('clearDeepseekApiKey').checked=false
  updateMode();updateCatalogPreviews()
}

function updateMode(){const ai=$('responseMode').value==='deepseek';$('responseTextLabel').textContent=ai?'Texto alternativo si DeepSeek falla':'Texto de respuesta'}
function updateCatalogPreviews(){for(const [inputId,imageId] of [['productCatalogImageUrl','productCatalogPreview'],['serviceCatalogImageUrl','serviceCatalogPreview']]){const input=$(inputId),image=$(imageId),url=input.value.trim();image.hidden=!url;if(url){image.src=url;image.onerror=()=>{image.hidden=true}}else image.removeAttribute('src')}}

function validate(){
  if(!$('botName').value.trim()||!$('businessName').value.trim())return'Completa nombre del bot y del negocio.'
  const delay=Number($('delay').value);if(!Number.isInteger(delay)||delay<1500||delay>60000)return'La pausa debe ser un entero entre 1500 y 60000 ms.'
  if($('autoReply').checked&&$('responseMode').value==='fixed'&&!$('responseText').value.trim())return'Escribe el texto de respuesta fija.'
  if($('appointmentsEnabled').checked&&(!$('autoReply').checked||$('responseMode').value!=='deepseek'))return'Las citas requieren respuestas automáticas y DeepSeek.'
  if($('transferEnabled').checked&&(!$('transferBankName').value.trim()||!$('transferAccountHolder').value.trim()||(!$('transferClabe').value.trim()&&!$('transferAccountNumber').value.trim())))return'Completa banco, titular y CLABE o número de cuenta.'
  return''
}

function showConfigError(message){
  const lower=message.toLowerCase()
  const target=lower.includes('cita')||lower.includes('horario')||lower.includes('zona horaria')||lower.includes('día')?'appointments':lower.includes('transferencia')||lower.includes('clabe')||lower.includes('banco')||lower.includes('retención')?'privacy':lower.includes('deepseek')||lower.includes('modelo de ia')||lower.includes('tono de ia')||lower.includes('instrucciones adicionales')?'ai':lower.includes('imagen')||lower.includes('catálogo')?'catalog':'settings'
  if(location.hash.slice(1)!==target)location.hash=target
  setNotice('globalNotice',message,'error')
}

export async function loadSettings(){const settings=await api('/api/settings');setSettings(settings);fill(settings);setDirty(false);return settings}

export async function saveSettings(){
  const error=validate();if(error){showConfigError(error);return false}
  try{const result=await api('/api/settings','POST',values());const next={...values(),deepseekApiKey:'',deepseekApiKeyConfigured:result.deepseekApiKeyConfigured};setSettings(next);$('deepseekApiKey').value='';$('deepseekApiKey').placeholder=result.deepseekApiKeyConfigured?'API key guardada; vacío conserva la actual':'Introduce la API key';$('clearDeepseekApiKey').checked=false;setDirty(false);setNotice('globalNotice',result.message,'success');return true}
  catch(error){showConfigError(error.message);return false}
}

function setDirty(dirty){if(dirty)updateSettingsDraft(values());$('saveState').style.display=dirty?'':'none'}

export function initializeSettings(){
  const archiveLabel=document.querySelector('label[for="saveToDatabase"]')
  archiveLabel.textContent='Archivar contactos y mensajes en MySQL'
  const archiveNote=document.createElement('p')
  archiveNote.className='mt-1 text-xs text-muted'
  archiveNote.textContent='Con el autoresponder activo se conservan metadatos operativos y respuestas cifradas para evitar acciones duplicadas y recuperar envíos.'
  archiveLabel.parentElement.after(archiveNote)
  for(const selector of ['#botName','#businessName','#autoReply','#responseMode','#responseText','#delay','#saveToDatabase','#deepseekModel','#aiTone','#aiResponseLength','#aiSystemInstructions','#maxRepliesPerHour','#messageRetentionDays','#productCatalogImageUrl','#serviceCatalogImageUrl','#transferEnabled','#transferBankName','#transferAccountHolder','#transferAccountNumber','#transferClabe','#transferInstructions','#appointmentsEnabled','#appointmentTimeZone','#appointmentStartTime','#appointmentEndTime','#appointmentDurationMinutes','#deepseekApiKey','#clearDeepseekApiKey']){
    const element=document.querySelector(selector);element.addEventListener('input',()=>setDirty(true));element.addEventListener('change',()=>setDirty(true))
  }
  document.querySelectorAll('.appointmentDay').forEach(element=>element.addEventListener('change',()=>setDirty(true)))
  $('responseMode').addEventListener('change',updateMode)
  $('productCatalogImageUrl').addEventListener('input',updateCatalogPreviews)
  $('serviceCatalogImageUrl').addEventListener('input',updateCatalogPreviews)
  $('saveSettingsTop').addEventListener('click',()=>void saveSettings())
  $('saveSettingsMobile').addEventListener('click',()=>void saveSettings())
}
