import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ContactProfileInput, createInventoryItem, createManualContact, createOrderFromCart, deleteInventoryItem, exportContactData, InventoryItemInput, listAppointments, listContactMessages, listContacts, listInboxChats, listInventoryItems, listOrders, listShoppingCarts, rescheduleAppointment, setAppointmentStatus, setChatBotPaused, setOrderStatus, updateContactProfile, updateInventoryItem } from './db'
import { resolveAppointmentStart } from './appointment-time'
import { decryptAppSettings, encryptAppSettings } from './settings-crypto'

export interface AppSettings {
  botName: string
  businessName: string
  autoReply: boolean
  responseMode: 'fixed' | 'deepseek'
  responseText: string
  replyDelayMs: number
  saveToDatabase: boolean
  deepseekApiKey: string
  deepseekModel: 'deepseek-flash' | 'deepseek-v4-pro'
  aiTone: 'friendly' | 'professional' | 'formal'
  aiResponseLength: 'brief' | 'balanced' | 'detailed'
  aiSystemInstructions: string
  maxRepliesPerHour: number
  productCatalogImageUrl: string | null
  serviceCatalogImageUrl: string | null
  transferEnabled: boolean
  transferBankName: string
  transferAccountHolder: string
  transferAccountNumber: string
  transferClabe: string
  transferInstructions: string
  appointmentsEnabled: boolean
  appointmentTimeZone: string
  appointmentDays: number[]
  appointmentStartTime: string
  appointmentEndTime: string
  appointmentDurationMinutes: number
  messageRetentionDays: number
}

export interface UiCallbacks {
  start: (settings: AppSettings) => Promise<void>
  logout: () => Promise<void>
  sendManualMessage: (contactId: number, text: string) => Promise<void>
  deleteContact: (contactId: number) => Promise<boolean>
  status: () => { serviceStatus: string; disconnectCode: number | null; pendingWrites: number }
}

const settingsPath = path.resolve('data/app-settings.json')
const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp — Configuración</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#101a1d;color:#e9f3f1;font:16px system-ui,Segoe UI,sans-serif}.wrap{max-width:1100px;margin:6vh auto;padding:0 18px}.card{background:#18272b;border:1px solid #2b4145;border-radius:14px;padding:24px;margin:16px 0;box-shadow:0 12px 35px #0003}h1{margin:0 0 6px;font-size:25px}p{color:#adc2c0;line-height:1.5}.field{margin:20px 0}label.title{display:block;font-weight:650;margin-bottom:8px}textarea,input[type=number],input[type=text],input[type=password],input[type=url],select{width:100%;border-radius:8px;border:1px solid #496166;background:#0e191c;color:#f4fffd;padding:11px;font:inherit}textarea{min-height:88px;resize:vertical}.check{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:17px 0}.check input{width:18px;height:18px;accent-color:#18a879}.buttons{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}button{border:0;border-radius:8px;padding:9px 13px;font:600 14px system-ui;cursor:pointer;background:#168b69;color:#fff}button.secondary{background:#315056}button.danger{background:#a84343}.status{padding:12px;border-radius:8px;background:#102023;color:#a8e5c4}.hint{font-size:13px;color:#91aaa7}#notice,#inventoryNotice,#inboxNotice,#ordersNotice{min-height:24px;margin-top:12px;color:#f2cb79}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;margin:16px 0}th,td{text-align:left;padding:9px;border-bottom:1px solid #31474b}td.actions{white-space:nowrap}td.actions button{margin-right:5px}.check input{flex:0 0 auto}.thumb{width:72px;height:72px;object-fit:cover;border-radius:8px;background:#0e191c}.chat-messages{height:380px;overflow-y:auto;background:#102023;padding:12px;border-radius:8px}.bubble{max-width:85%;margin:8px 0;padding:10px 12px;border-radius:10px;background:#22373b;white-space:pre-wrap;overflow-wrap:anywhere}.bubble.mine{margin-left:auto;background:#165b49}.bubble small{display:block;color:#a9c1bf;margin-bottom:4px}.selected-row{background:#203638}button:disabled{opacity:.55;cursor:wait}</style></head>
<body><main class="wrap"><section class="card"><h1>Configuración del servicio</h1><p>Configura la captura y la respuesta de prueba antes de iniciar WhatsApp. Este panel escucha únicamente en esta computadora.</p><div class="status">Estado: <strong id="status">cargando…</strong> <span id="extra"></span></div></section>
<section class="card"><form id="form"><div class="check"><input id="autoReply" type="checkbox"><label for="autoReply">Responder mensajes directos nuevos</label></div>
<div class="field"><label class="title" for="botName">Nombre del bot</label><input id="botName" type="text" maxlength="100" required></div><div class="field"><label class="title" for="businessName">Nombre del negocio</label><input id="businessName" type="text" maxlength="160" required></div>
<div class="field"><label class="title" for="responseMode">Modo de respuesta</label><select id="responseMode"><option value="fixed">Texto fijo</option><option value="deepseek">Generar con DeepSeek</option></select></div>
<div class="field"><label class="title" id="responseTextLabel" for="responseText">Texto de respuesta</label><textarea id="responseText" maxlength="1000"></textarea><p class="hint">En texto fijo puedes usar {botName} y {businessName} como marcadores.</p></div>
<div id="deepseekFields" hidden><div class="field"><label class="title" for="deepseekModel">Modelo DeepSeek</label><select id="deepseekModel"><option value="deepseek-flash">deepseek-flash</option><option value="deepseek-v4-pro">deepseek-v4-pro</option></select></div>
<div class="field"><label class="title" for="aiTone">Tono de respuesta</label><select id="aiTone"><option value="friendly">Amable y cercano</option><option value="professional">Profesional</option><option value="formal">Formal</option></select></div>
<div class="field"><label class="title" for="aiResponseLength">Longitud de respuesta</label><select id="aiResponseLength"><option value="brief">Breve (1–2 frases)</option><option value="balanced">Equilibrada</option><option value="detailed">Detallada</option></select></div>
<div class="field"><label class="title" for="aiSystemInstructions">Comportamiento e instrucciones adicionales</label><textarea id="aiSystemInstructions" maxlength="2000" placeholder="Ej.: saluda por su nombre cuando lo conozcas; no prometas descuentos; si falta información, pregunta antes de confirmar..."></textarea></div>
<div class="field"><label class="title" for="deepseekApiKey">API key de DeepSeek</label><input id="deepseekApiKey" type="password" autocomplete="new-password" placeholder="Pega tu API key; se guarda localmente"><div class="check"><input id="clearDeepseekApiKey" type="checkbox"><label for="clearDeepseekApiKey">Borrar API key guardada</label></div></div>
<p class="hint">El mensaje entrante, los productos/servicios activos y el carrito actual se envían a DeepSeek para generar la respuesta. No se envía el historial completo de WhatsApp. Las acciones del carrito se guardan en MySQL aunque desactives guardar mensajes. El carrito no cobra ni reserva existencias. La API key se guarda cifrada localmente; la clave se deriva de DB_PASSWORD en .env.</p></div>
<details><summary>Imágenes generales de catálogo</summary><p class="hint">Con DeepSeek activo, se enviarán al chat cuando el cliente solicite el catálogo completo. Usa URLs HTTPS directas a imágenes públicas.</p>
<div class="field"><label class="title" for="productCatalogImageUrl">Imagen general de productos</label><input id="productCatalogImageUrl" type="url" maxlength="2048" placeholder="https://... (opcional)"><img id="productCatalogPreview" class="thumb" hidden alt="Vista previa catálogo productos"></div>
<div class="field"><label class="title" for="serviceCatalogImageUrl">Imagen general de servicios</label><input id="serviceCatalogImageUrl" type="url" maxlength="2048" placeholder="https://... (opcional)"><img id="serviceCatalogPreview" class="thumb" hidden alt="Vista previa catálogo servicios"></div></details>
<div class="field"><label class="title" for="delay">Pausa fija antes de responder (milisegundos)</label><input id="delay" type="number" min="1500" max="60000" step="1" required></div>
<div class="field"><label class="title" for="maxRepliesPerHour">Límite de respuestas automáticas por contacto/hora</label><input id="maxRepliesPerHour" type="number" min="1" max="200" step="1" required></div>
<details><summary>Pago por transferencia bancaria</summary><div class="check"><input id="transferEnabled" type="checkbox"><label for="transferEnabled">Ofrecer transferencia cuando pregunten cómo pagar</label></div>
<div class="field"><label class="title" for="transferBankName">Banco</label><input id="transferBankName" type="text" maxlength="100"></div>
<div class="field"><label class="title" for="transferAccountHolder">Titular de la cuenta</label><input id="transferAccountHolder" type="text" maxlength="160"></div>
<div class="field"><label class="title" for="transferClabe">CLABE (opcional, 18 dígitos)</label><input id="transferClabe" type="text" inputmode="numeric" maxlength="18" pattern="[0-9]{18}"></div>
<div class="field"><label class="title" for="transferAccountNumber">Número de cuenta (opcional)</label><input id="transferAccountNumber" type="text" maxlength="64"></div>
<div class="field"><label class="title" for="transferInstructions">Instrucciones/referencia (opcional)</label><textarea id="transferInstructions" maxlength="1000"></textarea></div>
<p class="hint">Estos datos se guardan localmente en data/app-settings.json. Se incluyen en la respuesta solo cuando el cliente pregunta por pagos y no se envían a DeepSeek.</p></details>
<details><summary>Sistema de citas</summary><div class="check"><input id="appointmentsEnabled" type="checkbox"><label for="appointmentsEnabled">Activar reservas de citas por WhatsApp</label></div>
<div class="field"><label class="title" for="appointmentTimeZone">Zona horaria</label><input id="appointmentTimeZone" type="text" maxlength="64" placeholder="America/Mexico_City"></div>
<div class="field"><label class="title">Días disponibles</label><div class="check"><input class="appointmentDay" type="checkbox" value="1" id="day1"><label for="day1">Lunes</label><input class="appointmentDay" type="checkbox" value="2" id="day2"><label for="day2">Martes</label><input class="appointmentDay" type="checkbox" value="3" id="day3"><label for="day3">Miércoles</label><input class="appointmentDay" type="checkbox" value="4" id="day4"><label for="day4">Jueves</label><input class="appointmentDay" type="checkbox" value="5" id="day5"><label for="day5">Viernes</label><input class="appointmentDay" type="checkbox" value="6" id="day6"><label for="day6">Sábado</label><input class="appointmentDay" type="checkbox" value="0" id="day0"><label for="day0">Domingo</label></div></div>
<div class="field"><label class="title" for="appointmentStartTime">Horario de apertura</label><input id="appointmentStartTime" type="time"></div><div class="field"><label class="title" for="appointmentEndTime">Horario de cierre</label><input id="appointmentEndTime" type="time"></div>
<div class="field"><label class="title" for="appointmentDurationMinutes">Duración de cada cita (minutos)</label><input id="appointmentDurationMinutes" type="number" min="15" max="240" step="5"></div>
<p class="hint">DeepSeek puede reservar, consultar y cancelar citas. Se confirmarán solo dentro del horario disponible; las citas usan esta zona horaria y se almacenan en UTC.</p></details>
<div class="check"><input id="saveToDatabase" type="checkbox"><label for="saveToDatabase">Guardar contactos y mensajes en MySQL</label></div>
<details><summary>Retención de mensajes</summary><div class="field"><label class="title" for="messageRetentionDays">Días de conservación (0 = no borrar automáticamente)</label><input id="messageRetentionDays" type="number" min="0" max="3650" step="1"></div><p class="hint">Al iniciar y una vez al día, se eliminarán mensajes importados antes del plazo configurado. Los contactos y las citas no se eliminan automáticamente.</p></details>
<p class="hint">Las respuestas automáticas solo se aplican a eventos nuevos recibidos después de iniciar el proceso; no contestan historial, grupos, estados ni mensajes propios. La pausa no oculta automatización ni evita controles de WhatsApp.</p>
<div class="buttons"><button type="button" id="save">Guardar configuración</button><button type="button" id="start">Iniciar servicio WhatsApp</button><button type="button" class="danger" id="logout">Salir de la sesión</button></div><div id="notice" aria-live="polite"></div></form></section>
<section class="card"><h2>Bandeja de conversaciones</h2><p>Pausa las respuestas automáticas por contacto y responde manualmente desde aquí.</p><input id="inboxSearch" type="text" placeholder="Buscar nombre o teléfono"><div id="inboxNotice" aria-live="polite"></div><div class="table-wrap"><table><thead><tr><th>Contacto</th><th>Último mensaje</th><th>Estado IA</th><th></th></tr></thead><tbody id="inboxRows"></tbody></table></div><div class="buttons"><button type="button" id="inboxPrev" class="secondary">Anterior</button><span id="inboxPageLabel" class="hint"></span><button type="button" id="inboxNext" class="secondary">Siguiente</button></div>
<div id="chatPanel" hidden><h3 id="chatTitle"></h3><div id="chatMessages" class="chat-messages"></div><div class="buttons"><button type="button" id="togglePause" class="secondary"></button><a id="exportContact" class="button-link" download>Exportar contacto</a><button type="button" id="deleteContact" class="danger">Eliminar datos del contacto</button></div><div class="field"><label class="title" for="manualText">Respuesta manual</label><textarea id="manualText" maxlength="4000" placeholder="Escribe una respuesta manual..."></textarea><button type="button" id="sendManual">Enviar desde WhatsApp</button></div></div></section>
<section class="card"><h2>Contactos</h2><p>Los contactos con conversaciones se crean al sincronizar WhatsApp. Puedes añadir contactos manualmente con su número internacional, sin crear mensajes ni chats.</p><input id="contactSearch" type="text" placeholder="Buscar nombre, etiqueta o teléfono"><div id="contactsNotice" class="hint"></div><div class="table-wrap"><table><thead><tr><th>Nombre</th><th>Teléfono</th><th>Etiquetas</th><th>Chats</th><th>Mensajes</th><th></th></tr></thead><tbody id="contactsRows"></tbody></table></div><div class="buttons"><button type="button" id="contactPrev" class="secondary">Anterior</button><span id="contactPageLabel" class="hint"></span><button type="button" id="contactNext" class="secondary">Siguiente</button><button type="button" id="newContact" class="secondary">Nuevo contacto</button></div>
<form id="contactForm" hidden><h3 id="contactFormTitle">Nuevo contacto</h3><input id="contactId" type="hidden"><div class="field" id="contactPhoneField"><label class="title" for="contactPhone">Número internacional (solo dígitos; no se transforma el prefijo)</label><input id="contactPhone" type="tel" inputmode="tel" pattern="\+?[0-9]{5,20}" maxlength="21" placeholder="Ej. 5215512345678" required></div><div class="field"><label class="title" for="contactName">Nombre visible</label><input id="contactName" type="text" maxlength="160"></div><div class="field"><label class="title" for="contactTags">Etiquetas (separadas por comas)</label><input id="contactTags" type="text" maxlength="500"></div><div class="field"><label class="title" for="contactNotes">Notas</label><textarea id="contactNotes" maxlength="4000"></textarea></div><div class="buttons"><button type="submit">Guardar contacto</button><button type="button" id="contactCancel" class="secondary">Cancelar</button></div></form></section>
<section class="card"><h2>Productos y servicios</h2><p>La IA usa como referencia únicamente artículos activos. Si recomienda un producto activo con imagen configurada, el bot envía su miniatura al chat (máximo dos por respuesta). Los registros de demostración se crean inactivos; edítalos antes de activarlos.</p>
<div class="table-wrap"><table><thead><tr><th>Imagen</th><th>Tipo</th><th>Código</th><th>Nombre</th><th>Precio</th><th>Existencias</th><th>Estado</th><th>Acciones</th></tr></thead><tbody id="inventoryRows"></tbody></table></div><div id="inventoryNotice" aria-live="polite"></div>
<h3 id="itemFormTitle">Agregar artículo</h3><form id="itemForm"><input id="itemId" type="hidden"><div class="field"><label class="title" for="itemType">Tipo</label><select id="itemType"><option value="product">Producto</option><option value="service">Servicio</option></select></div>
<div class="field"><label class="title" for="itemSku">Código/SKU</label><input id="itemSku" type="text" maxlength="64" pattern="[A-Za-z0-9._-]{1,64}" required></div>
<div class="field"><label class="title" for="itemName">Nombre</label><input id="itemName" type="text" maxlength="200" required></div>
<div class="field"><label class="title" for="itemDescription">Descripción</label><textarea id="itemDescription" maxlength="2000"></textarea></div>
<div class="field"><label class="title" for="itemImageUrl">URL de imagen (HTTPS)</label><input id="itemImageUrl" type="url" maxlength="2048" placeholder="https://... (opcional)"></div>
<div class="field"><label class="title" for="itemPrice">Precio (opcional)</label><input id="itemPrice" type="number" min="0" max="9999999999.99" step="0.01"></div>
<div class="field"><label class="title" for="itemCurrency">Moneda ISO (3 letras)</label><input id="itemCurrency" type="text" minlength="3" maxlength="3" pattern="[A-Za-z]{3}" value="MXN" required></div>
<div class="field" id="stockField"><label class="title" for="itemStock">Existencias (vacío = no controladas)</label><input id="itemStock" type="number" min="0" max="4294967295" step="1"></div>
<div class="check"><input id="itemActive" type="checkbox" checked><label for="itemActive">Activo; la IA puede recomendarlo</label></div>
<div class="buttons"><button type="submit" id="itemSubmit">Guardar artículo</button><button type="button" id="itemCancel" class="secondary" hidden>Cancelar edición</button></div></form></section>
<section class="card"><h2>Carritos activos</h2><p>Convierte un carrito en pedido pendiente para revisarlo manualmente.</p><div class="table-wrap"><table><thead><tr><th>Contacto</th><th>Artículos</th><th>Acciones</th></tr></thead><tbody id="cartRows"></tbody></table></div><div id="cartNotice" class="hint"></div></section>
<section class="card"><h2>Pedidos</h2><div class="table-wrap"><table><thead><tr><th>Pedido</th><th>Fecha</th><th>Contacto</th><th>Artículos</th><th>Total</th><th>Estado</th><th>Acciones</th></tr></thead><tbody id="orderRows"></tbody></table></div><div id="ordersNotice"></div></section>
<section class="card"><h2>Citas guardadas</h2><p>Las fechas se muestran en la zona horaria configurada para el negocio.</p><button type="button" id="refreshAppointments" class="secondary">Actualizar citas</button><div id="appointmentsNotice" aria-live="polite"></div>
<div class="table-wrap"><table><thead><tr><th>Fecha y hora</th><th>Contacto</th><th>Teléfono</th><th>Servicio</th><th>Estado</th></tr></thead><tbody id="appointmentsRows"></tbody></table></div></section>
<section class="card"><p>Al iniciar, el QR de vinculación se mostrará en la terminal donde se ejecuta el programa.</p></section></main>
<script>
const $=id=>document.getElementById(id);let busy=false;let currentAppointmentTimeZone='America/Mexico_City';let inboxChats=[];let selectedChat=null;let inboxPage=1;let inboxPageSize=20;let inboxTotal=0;let inboxSearchTimer;let contactPage=1;let contactPageSize=20;let contactTotal=0;let contactSearchTimer;
function values(){return{botName:$('botName').value,businessName:$('businessName').value,autoReply:$('autoReply').checked,responseMode:$('responseMode').value,responseText:$('responseText').value,replyDelayMs:Number($('delay').value),saveToDatabase:$('saveToDatabase').checked,deepseekModel:$('deepseekModel').value,aiTone:$('aiTone').value,aiResponseLength:$('aiResponseLength').value,deepseekApiKey:$('deepseekApiKey').value,clearDeepseekApiKey:$('clearDeepseekApiKey').checked,aiSystemInstructions:$('aiSystemInstructions').value,maxRepliesPerHour:Number($('maxRepliesPerHour').value),messageRetentionDays:Number($('messageRetentionDays').value),productCatalogImageUrl:$('productCatalogImageUrl').value,serviceCatalogImageUrl:$('serviceCatalogImageUrl').value,transferEnabled:$('transferEnabled').checked,transferBankName:$('transferBankName').value,transferAccountHolder:$('transferAccountHolder').value,transferAccountNumber:$('transferAccountNumber').value,transferClabe:$('transferClabe').value,transferInstructions:$('transferInstructions').value,appointmentsEnabled:$('appointmentsEnabled').checked,appointmentTimeZone:$('appointmentTimeZone').value,appointmentDays:[...document.querySelectorAll('.appointmentDay:checked')].map(x=>Number(x.value)),appointmentStartTime:$('appointmentStartTime').value,appointmentEndTime:$('appointmentEndTime').value,appointmentDurationMinutes:Number($('appointmentDurationMinutes').value)}}
function notice(text){$('notice').textContent=text}
async function call(url,method='GET',body){const r=await fetch(url,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw Error(data.error||'Error de solicitud');return data}
function validate(showErrors=true){const delay=$('delay'),text=$('responseText');const n=Number(delay.value);delay.setCustomValidity(Number.isInteger(n)&&n>=1500&&n<=60000?'':'La pausa debe ser un número entero entre 1500 y 60000 ms.');text.setCustomValidity($('autoReply').checked&&!text.value.trim()?'Escribe un texto de respuesta o desactiva las respuestas automáticas.':'');return showErrors?$('form').reportValidity():$('form').checkValidity()}
async function save(){if(!validate())throw Error('Revisa los campos marcados.');const s=await call('/api/settings','POST',values());$('deepseekApiKey').value='';$('deepseekApiKey').placeholder=s.deepseekApiKeyConfigured?'API key guardada; vacío conserva la actual':'Pega tu API key; se guarda localmente';$('clearDeepseekApiKey').checked=false;notice(s.message)}
async function status(){try{const s=await call('/api/status');$('status').textContent=s.serviceStatus;$('extra').textContent=s.disconnectCode?' · código '+s.disconnectCode:'';const active=['connecting','waiting-qr','connected','reconnecting'].includes(s.serviceStatus);$('start').disabled=active||busy}catch{}}
function cell(row,text){const td=document.createElement('td');td.textContent=text;row.appendChild(td);return td}
async function loadInventory(){try{const items=await call('/api/inventory');const body=$('inventoryRows');body.replaceChildren();for(const item of items){const row=document.createElement('tr');const image=cell(row,'');if(item.imageUrl){const img=document.createElement('img');img.className='thumb';img.src=item.imageUrl;img.alt='Imagen de '+item.name;img.loading='lazy';img.referrerPolicy='no-referrer';img.onerror=()=>{img.hidden=true};image.appendChild(img)}else image.textContent='—';cell(row,item.itemType==='product'?'Producto':'Servicio');cell(row,item.sku);cell(row,item.name);cell(row,item.price===null?'A cotizar':item.price+' '+item.currency);cell(row,item.itemType==='service'?'—':item.stockQuantity===null?'No controladas':String(item.stockQuantity));cell(row,item.isActive?'Activo':'Inactivo');const actions=cell(row,'');actions.className='actions';const edit=document.createElement('button');edit.textContent='Editar';edit.className='secondary';edit.onclick=()=>editItem(item);const del=document.createElement('button');del.textContent='Eliminar';del.className='danger';del.onclick=()=>removeItem(item);actions.append(edit,del);body.appendChild(row)}$('inventoryNotice').textContent=items.length?'':'Inventario vacío.'}catch(e){$('inventoryNotice').textContent='No se pudo leer inventario. Aplica migraciones y verifica MySQL: '+e.message}}
async function loadAppointments(){try{const items=await call('/api/appointments');const body=$('appointmentsRows');body.replaceChildren();const formatter=new Intl.DateTimeFormat('es-MX',{timeZone:currentAppointmentTimeZone,dateStyle:'medium',timeStyle:'short'});for(const item of items){const row=document.createElement('tr');cell(row,formatter.format(new Date(item.startsAt)));cell(row,item.displayName||('Contacto '+item.contactId));cell(row,item.phoneNumber||'Teléfono no resuelto');cell(row,item.serviceRequested||'—');cell(row,item.status==='booked'?'Agendada':'Cancelada');const actions=cell(row,'');actions.className='actions';if(item.status==='booked'){const reschedule=document.createElement('button');reschedule.textContent='Reprogramar';reschedule.className='secondary';reschedule.onclick=async()=>{const localStart=prompt('Nueva fecha/hora local (AAAA-MM-DDTHH:mm)');if(!localStart)return;try{await call('/api/appointments/'+item.id,'PATCH',{action:'reschedule',localStart});await loadAppointments()}catch(e){$('appointmentsNotice').textContent=e.message}};const cancel=document.createElement('button');cancel.textContent='Cancelar';cancel.className='danger';cancel.onclick=async()=>{if(!confirm('¿Cancelar esta cita?'))return;try{await call('/api/appointments/'+item.id,'PATCH',{action:'cancel'});await loadAppointments()}catch(e){$('appointmentsNotice').textContent=e.message}};actions.append(reschedule,cancel)}body.appendChild(row)}$('appointmentsNotice').textContent=items.length?'Citas: '+items.length:'No hay citas guardadas.'}catch(e){$('appointmentsNotice').textContent='No se pudieron cargar citas. Aplica migraciones y verifica MySQL: '+e.message}}
async function loadCarts(){try{const items=await call('/api/carts');const body=$('cartRows');body.replaceChildren();for(const cart of items){const row=document.createElement('tr');cell(row,cart.displayName||('Contacto '+cart.contactId)+(cart.phoneNumber?' · '+cart.phoneNumber:''));cell(row,cart.items.map(item=>item.quantity+' × '+item.itemName).join(', '));const action=cell(row,'');const order=document.createElement('button');order.textContent='Crear pedido pendiente';order.onclick=async()=>{try{await call('/api/carts/'+cart.contactId+'/orders','POST',{});await loadCarts();await loadOrders()}catch(e){$('cartNotice').textContent=e.message}};action.appendChild(order);body.appendChild(row)}$('cartNotice').textContent=items.length?'Carritos: '+items.length:'No hay carritos activos.'}catch(e){$('cartNotice').textContent='No se pudieron cargar carritos: '+e.message}}
async function loadOrders(){try{const orders=await call('/api/orders');const body=$('orderRows');body.replaceChildren();const formatter=new Intl.DateTimeFormat('es-MX',{timeZone:currentAppointmentTimeZone,dateStyle:'short',timeStyle:'short'});for(const order of orders){const row=document.createElement('tr');cell(row,String(order.id));cell(row,formatter.format(new Date(order.createdAt)));cell(row,order.displayName||('Contacto '+order.contactId));cell(row,order.items.map(item=>item.quantity+' × '+item.itemName).join(', '));cell(row,order.total===null?'A cotizar':order.total+' '+order.currency);cell(row,order.status==='pending'?'Pendiente':order.status==='confirmed'?'Confirmado':'Cancelado');const actions=cell(row,'');if(order.status==='pending'){const confirm=document.createElement('button');confirm.textContent='Confirmar';confirm.onclick=()=>changeOrderStatus(order.id,'confirmed');const cancel=document.createElement('button');cancel.textContent='Cancelar';cancel.className='danger';cancel.onclick=()=>changeOrderStatus(order.id,'cancelled');actions.append(confirm,cancel)}body.appendChild(row)}$('ordersNotice').textContent=orders.length?'Pedidos: '+orders.length:'No hay pedidos.'}catch(e){$('ordersNotice').textContent='No se pudieron cargar pedidos: '+e.message}}
async function changeOrderStatus(id,status){try{await call('/api/orders/'+id,'PATCH',{status});await loadOrders()}catch(e){$('ordersNotice').textContent=e.message}}
function renderInbox(){const body=$('inboxRows');body.replaceChildren();for(const chat of inboxChats){const name=chat.displayName||('Contacto '+chat.contactId);const row=document.createElement('tr');if(selectedChat&&selectedChat.contactId===chat.contactId)row.className='selected-row';cell(row,name);cell(row,chat.lastMessageText?(chat.lastMessageText.length>120?chat.lastMessageText.slice(0,120)+'…':chat.lastMessageText):'Mensaje sin texto');cell(row,chat.botPaused?'IA pausada':'IA activa');const action=cell(row,'');action.className='actions';const open=document.createElement('button');open.textContent='Abrir';open.className='secondary';open.onclick=()=>selectChat(chat);action.appendChild(open);body.appendChild(row)}const pageCount=Math.max(1,Math.ceil(inboxTotal/inboxPageSize));$('inboxNotice').textContent=inboxTotal?'Conversaciones: '+inboxTotal:'';$('inboxPageLabel').textContent='Página '+inboxPage+' de '+pageCount;$('inboxPrev').disabled=inboxPage<=1;$('inboxNext').disabled=inboxPage>=pageCount}
async function loadInbox(resetPage=false){try{if(resetPage)inboxPage=1;const params=new URLSearchParams({page:String(inboxPage),pageSize:String(inboxPageSize),search:$('inboxSearch').value.trim()});const result=await call('/api/inbox?'+params.toString());inboxChats=result.rows;inboxTotal=result.total;inboxPage=result.page;renderInbox();if(selectedChat){const fresh=inboxChats.find(chat=>chat.contactId===selectedChat.contactId);if(fresh){selectedChat=fresh;updateSelectedChat()}}}catch(e){$('inboxNotice').textContent='No se pudo cargar la bandeja: '+e.message}}
function renderContacts(rows){const body=$('contactsRows');body.replaceChildren();for(const contact of rows){const row=document.createElement('tr');cell(row,contact.displayName||'—');cell(row,contact.phoneNumber||(contact.hasLid?'Sin correspondencia telefónica (LID)':'No resuelto'));cell(row,contact.tags||'—');cell(row,String(contact.chatCount));cell(row,String(contact.messageCount));const actions=cell(row,'');actions.className='actions';const edit=document.createElement('button');edit.textContent='Editar';edit.className='secondary';edit.onclick=()=>editContact(contact);const remove=document.createElement('button');remove.textContent='Eliminar';remove.className='danger';remove.onclick=()=>removeContact(contact);actions.append(edit,remove);body.appendChild(row)}const pages=Math.max(1,Math.ceil(contactTotal/contactPageSize));$('contactsNotice').textContent='Contactos: '+contactTotal;$('contactPageLabel').textContent='Página '+contactPage+' de '+pages;$('contactPrev').disabled=contactPage<=1;$('contactNext').disabled=contactPage>=pages}
async function loadContacts(reset=false){try{if(reset)contactPage=1;const params=new URLSearchParams({page:String(contactPage),pageSize:String(contactPageSize),search:$('contactSearch').value.trim()});const result=await call('/api/contacts?'+params.toString());contactPage=result.page;contactTotal=result.total;renderContacts(result.rows)}catch(e){$('contactsNotice').textContent='No se pudieron cargar contactos: '+e.message}}
function showContactForm(contact){$('contactForm').hidden=false;$('contactForm').reset();$('contactId').value=contact?.contactId??'';$('contactFormTitle').textContent=contact?'Editar contacto':'Nuevo contacto';$('contactPhoneField').hidden=!!contact;$('contactPhone').required=!contact;$('contactName').value=contact?.customName||'';$('contactTags').value=contact?.tags||'';$('contactNotes').value=contact?.notes||'';$('contactForm').scrollIntoView({behavior:'smooth'})}
function editContact(contact){showContactForm(contact)}
async function removeContact(contact){if(!confirm('¿Eliminar permanentemente el contacto y sus chats, mensajes, citas, carritos y pedidos?'))return;try{await call('/api/contacts/'+contact.contactId,'DELETE');await loadContacts();await loadInbox();await loadAppointments();await loadCarts();await loadOrders()}catch(e){$('contactsNotice').textContent=e.message}}
async function submitContact(event){event.preventDefault();if(!$('contactForm').reportValidity())return;const id=$('contactId').value;const body={customName:$('contactName').value,tags:$('contactTags').value,notes:$('contactNotes').value};try{if(id)await call('/api/contacts/'+id+'/profile','PATCH',body);else await call('/api/contacts','POST',{phoneNumber:$('contactPhone').value, ...body});$('contactForm').hidden=true;await loadContacts()}catch(e){$('contactsNotice').textContent=e.message}}
function clearSelectedChat(){$('chatPanel').hidden=true;selectedChat=null}
function updateSelectedChat(){if(!selectedChat)return;$('chatPanel').hidden=false;$('chatTitle').textContent=(selectedChat.displayName||('Contacto '+selectedChat.contactId))+(selectedChat.phoneNumber?' · '+selectedChat.phoneNumber:'');$('togglePause').textContent=selectedChat.botPaused?'Reanudar IA':'Pausar IA';$('exportContact').href='/api/contacts/'+selectedChat.contactId+'/export'}
async function selectChat(chat){selectedChat=chat;updateSelectedChat();renderInbox();await loadChatMessages()}
async function loadChatMessages(){if(!selectedChat)return;try{const messages=await call('/api/contacts/'+selectedChat.contactId+'/messages');const panel=$('chatMessages');panel.replaceChildren();const formatter=new Intl.DateTimeFormat('es-MX',{timeZone:currentAppointmentTimeZone,dateStyle:'short',timeStyle:'short'});for(const message of messages){const bubble=document.createElement('div');bubble.className='bubble'+(message.fromMe?' mine':'');const meta=document.createElement('small');meta.textContent=(message.fromMe?'Tú':'Contacto')+' · '+formatter.format(new Date(message.messageTimestamp))+(message.isDeleted?' · eliminado':'');const content=document.createElement('div');content.textContent=message.isDeleted?'Mensaje eliminado':message.text||('['+message.messageType+']');bubble.append(meta,content);panel.appendChild(bubble)}panel.scrollTop=panel.scrollHeight}catch(e){$('inboxNotice').textContent='No se pudo cargar el chat: '+e.message}}
function resetItemForm(){ $('itemForm').reset();$('itemId').value='';$('itemCurrency').value='MXN';$('itemActive').checked=true;$('itemFormTitle').textContent='Agregar artículo';$('itemSubmit').textContent='Guardar artículo';$('itemCancel').hidden=true;updateItemType() }
function updateItemType(){const service=$('itemType').value==='service';$('itemStock').disabled=service;if(service)$('itemStock').value=''}
function editItem(item){$('itemId').value=item.id;$('itemType').value=item.itemType;$('itemSku').value=item.sku;$('itemName').value=item.name;$('itemDescription').value=item.description||'';$('itemImageUrl').value=item.imageUrl||'';$('itemPrice').value=item.price??'';$('itemCurrency').value=item.currency;$('itemStock').value=item.stockQuantity??'';$('itemActive').checked=item.isActive;$('itemFormTitle').textContent='Editar artículo';$('itemSubmit').textContent='Guardar cambios';$('itemCancel').hidden=false;updateItemType();$('itemFormTitle').scrollIntoView({behavior:'smooth'})}
async function removeItem(item){if(!confirm('¿Eliminar '+item.name+' ('+item.sku+')?'))return;try{await call('/api/inventory/'+item.id,'DELETE');await loadInventory()}catch(e){$('inventoryNotice').textContent=e.message}}
async function submitItem(event){event.preventDefault();if(!$('itemForm').reportValidity())return;const id=$('itemId').value;const item={itemType:$('itemType').value,sku:$('itemSku').value,name:$('itemName').value,description:$('itemDescription').value,imageUrl:$('itemImageUrl').value,price:$('itemPrice').value===''?null:Number($('itemPrice').value),currency:$('itemCurrency').value,stockQuantity:$('itemType').value==='service'||$('itemStock').value===''?null:Number($('itemStock').value),isActive:$('itemActive').checked};try{await call(id?'/api/inventory/'+id:'/api/inventory',id?'PUT':'POST',item);resetItemForm();await loadInventory();$('inventoryNotice').textContent='Inventario guardado.'}catch(e){$('inventoryNotice').textContent=e.message}}
function updateMode(){const ai=$('responseMode').value==='deepseek';$('deepseekFields').hidden=!ai;$('responseTextLabel').textContent=ai?'Texto fijo alternativo si DeepSeek falla':'Texto de respuesta'}
function updatePreview(inputId,imageId){const url=$(inputId).value.trim(),image=$(imageId);image.hidden=!url;if(url){image.src=url;image.onerror=()=>{image.hidden=true}}else image.removeAttribute('src')}
async function load(){const s=await call('/api/settings');$('botName').value=s.botName;$('businessName').value=s.businessName;$('autoReply').checked=s.autoReply;$('responseMode').value=s.responseMode;$('responseText').value=s.responseText;$('delay').value=s.replyDelayMs;$('saveToDatabase').checked=s.saveToDatabase;$('deepseekModel').value=s.deepseekModel;$('aiTone').value=s.aiTone;$('aiResponseLength').value=s.aiResponseLength;$('aiSystemInstructions').value=s.aiSystemInstructions;$('maxRepliesPerHour').value=s.maxRepliesPerHour;$('messageRetentionDays').value=s.messageRetentionDays;$('deepseekApiKey').value='';$('deepseekApiKey').placeholder=s.deepseekApiKeyConfigured?'API key guardada; vacío conserva la actual':'Pega tu API key; se guarda localmente';$('productCatalogImageUrl').value=s.productCatalogImageUrl||'';$('serviceCatalogImageUrl').value=s.serviceCatalogImageUrl||'';$('transferEnabled').checked=s.transferEnabled;$('transferBankName').value=s.transferBankName;$('transferAccountHolder').value=s.transferAccountHolder;$('transferAccountNumber').value=s.transferAccountNumber;$('transferClabe').value=s.transferClabe;$('transferInstructions').value=s.transferInstructions;$('appointmentsEnabled').checked=s.appointmentsEnabled;$('appointmentTimeZone').value=s.appointmentTimeZone;currentAppointmentTimeZone=s.appointmentTimeZone;$('appointmentStartTime').value=s.appointmentStartTime;$('appointmentEndTime').value=s.appointmentEndTime;$('appointmentDurationMinutes').value=s.appointmentDurationMinutes;document.querySelectorAll('.appointmentDay').forEach(x=>x.checked=s.appointmentDays.includes(Number(x.value)));updatePreview('productCatalogImageUrl','productCatalogPreview');updatePreview('serviceCatalogImageUrl','serviceCatalogPreview');updateMode();await status()}
$('save').onclick=async()=>{try{await save()}catch(e){notice(e.message)}};
$('start').onclick=async()=>{if(busy||!validate())return;busy=true;$('start').disabled=true;try{await save();const s=await call('/api/start','POST',{});notice(s.message);await status()}catch(e){notice(e.message)}finally{busy=false;await status()}};
$('delay').oninput=()=>validate(false);$('responseText').oninput=()=>validate(false);$('autoReply').onchange=()=>validate(false);
$('responseMode').onchange=updateMode;$('itemForm').onsubmit=submitItem;$('itemType').onchange=updateItemType;$('itemCancel').onclick=resetItemForm;
$('productCatalogImageUrl').oninput=()=>updatePreview('productCatalogImageUrl','productCatalogPreview');$('serviceCatalogImageUrl').oninput=()=>updatePreview('serviceCatalogImageUrl','serviceCatalogPreview');
$('refreshAppointments').onclick=loadAppointments;
$('inboxSearch').oninput=()=>{clearTimeout(inboxSearchTimer);inboxSearchTimer=setTimeout(()=>loadInbox(true),250)};$('inboxPrev').onclick=()=>{if(inboxPage>1){inboxPage--;void loadInbox()}};$('inboxNext').onclick=()=>{if(inboxPage<Math.ceil(inboxTotal/inboxPageSize)){inboxPage++;void loadInbox()}};$('togglePause').onclick=async()=>{if(!selectedChat)return;try{await call('/api/contacts/'+selectedChat.contactId+'/pause','POST',{paused:!selectedChat.botPaused});selectedChat.botPaused=!selectedChat.botPaused;updateSelectedChat();await loadInbox()}catch(e){$('inboxNotice').textContent=e.message}};
$('contactSearch').oninput=()=>{clearTimeout(contactSearchTimer);contactSearchTimer=setTimeout(()=>loadContacts(true),250)};$('contactPrev').onclick=()=>{if(contactPage>1){contactPage--;void loadContacts()}};$('contactNext').onclick=()=>{if(contactPage<Math.ceil(contactTotal/contactPageSize)){contactPage++;void loadContacts()}};$('newContact').onclick=()=>showContactForm(null);$('contactCancel').onclick=()=>{$('contactForm').hidden=true};$('contactForm').onsubmit=submitContact;
$('sendManual').onclick=async()=>{if(!selectedChat)return;const text=$('manualText').value.trim();if(!text)return;try{await call('/api/contacts/'+selectedChat.contactId+'/messages','POST',{text});$('manualText').value='';await loadChatMessages();await loadInbox()}catch(e){$('inboxNotice').textContent=e.message}};
$('deleteContact').onclick=async()=>{if(!selectedChat||!confirm('¿Eliminar todos los datos guardados de este contacto? Esta acción no se puede deshacer.'))return;try{await call('/api/contacts/'+selectedChat.contactId,'DELETE');clearSelectedChat();await loadInbox();await loadAppointments()}catch(e){$('inboxNotice').textContent=e.message}};
$('logout').onclick=async()=>{if(!confirm('¿Cerrar la sesión vinculada y borrar las credenciales locales? Tendrás que escanear un QR para volver a vincular.'))return;try{const s=await call('/api/logout','POST',{});notice(s.message);await status()}catch(e){notice(e.message)}};
load().catch(e=>notice(e.message));loadInventory();loadAppointments();loadInbox();loadContacts();loadCarts();loadOrders();setInterval(status,2500);setInterval(()=>{loadInbox();if(selectedChat)loadChatMessages();loadContacts();loadCarts();loadOrders();loadAppointments()},10000);
</script></body></html>`

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function readJson(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 16_384) throw new Error('Solicitud demasiado grande')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function validateSettings(input: any, fallbackApiKey = ''): AppSettings {
  const botName = typeof input.botName === 'string' ? input.botName.trim() : 'Asistente de WhatsApp'
  const businessName = typeof input.businessName === 'string' ? input.businessName.trim() : 'Mi negocio'
  if (!botName || botName.length > 100) throw new Error('El nombre del bot es obligatorio y admite hasta 100 caracteres')
  if (!businessName || businessName.length > 160) throw new Error('El nombre del negocio es obligatorio y admite hasta 160 caracteres')
  if (typeof input?.autoReply !== 'boolean' || typeof input?.saveToDatabase !== 'boolean') throw new Error('Las opciones deben ser booleanas')
  if (typeof input?.responseText !== 'string' || input.responseText.length > 1000 || (input.autoReply && !input.responseText.trim())) throw new Error('El texto debe tener entre 1 y 1000 caracteres')
  if (!Number.isInteger(input.replyDelayMs) || input.replyDelayMs < 1500 || input.replyDelayMs > 60_000) throw new Error('La pausa debe ser un entero entre 1500 y 60000 ms')
  const responseMode = input.responseMode ?? 'fixed'
  if (!['fixed', 'deepseek'].includes(responseMode)) throw new Error('Modo de respuesta no válido')
  const deepseekModel = input.deepseekModel ?? 'deepseek-flash'
  if (!['deepseek-flash', 'deepseek-v4-pro'].includes(deepseekModel)) throw new Error('Modelo DeepSeek no válido')
  const aiTone = input.aiTone ?? 'professional'
  if (!['friendly','professional','formal'].includes(aiTone)) throw new Error('Tono de IA no válido')
  const aiResponseLength = input.aiResponseLength ?? 'brief'
  if (!['brief','balanced','detailed'].includes(aiResponseLength)) throw new Error('Longitud de respuesta de IA no válida')
  const aiSystemInstructions = typeof input.aiSystemInstructions === 'string' ? input.aiSystemInstructions.trim() : ''
  if (aiSystemInstructions.length > 2000) throw new Error('Las instrucciones adicionales admiten hasta 2000 caracteres')
  const maxRepliesPerHour = input.maxRepliesPerHour ?? 20
  if (!Number.isInteger(maxRepliesPerHour) || maxRepliesPerHour < 1 || maxRepliesPerHour > 200) throw new Error('El límite debe ser entre 1 y 200 respuestas por contacto/hora')
  const messageRetentionDays = input.messageRetentionDays ?? 0
  if (!Number.isInteger(messageRetentionDays) || messageRetentionDays < 0 || messageRetentionDays > 3650) throw new Error('La retención debe ser entre 0 y 3650 días')
  const enteredApiKey = typeof input.deepseekApiKey === 'string' ? input.deepseekApiKey.trim() : ''
  const deepseekApiKey = input.clearDeepseekApiKey ? '' : enteredApiKey || fallbackApiKey
  if (input.autoReply && responseMode === 'deepseek' && !deepseekApiKey) throw new Error('Configura la API key de DeepSeek antes de iniciar con ese modo')
  const validateCatalogUrl = (value: unknown, label: string): string | null => {
    if (value === undefined || value === null || value === '') return null
    if (typeof value !== 'string' || value.length > 2048) throw new Error(`${label}: URL demasiado larga`)
    let url: URL
    try { url = new URL(value) } catch { throw new Error(`${label}: URL no válida`) }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error(`${label}: se requiere una URL HTTPS pública`)
    return url.toString()
  }
  const transferEnabled = input.transferEnabled ?? false
  if (typeof transferEnabled !== 'boolean') throw new Error('La opción de transferencia debe ser booleana')
  const transferBankName = typeof input.transferBankName === 'string' ? input.transferBankName.trim() : ''
  const transferAccountHolder = typeof input.transferAccountHolder === 'string' ? input.transferAccountHolder.trim() : ''
  const transferAccountNumber = typeof input.transferAccountNumber === 'string' ? input.transferAccountNumber.trim() : ''
  const transferClabe = typeof input.transferClabe === 'string' ? input.transferClabe.trim() : ''
  const transferInstructions = typeof input.transferInstructions === 'string' ? input.transferInstructions.trim() : ''
  if (transferBankName.length > 100 || transferAccountHolder.length > 160 || transferAccountNumber.length > 64 || transferInstructions.length > 1000) throw new Error('Los datos de transferencia exceden el límite de caracteres')
  if (transferClabe && !/^\d{18}$/.test(transferClabe)) throw new Error('La CLABE debe contener exactamente 18 dígitos')
  if (transferEnabled && (!transferBankName || !transferAccountHolder || (!transferClabe && !transferAccountNumber))) throw new Error('Para activar transferencia, indica banco, titular y CLABE o número de cuenta')
  const appointmentsEnabled = input.appointmentsEnabled ?? false
  if (typeof appointmentsEnabled !== 'boolean') throw new Error('La opción de citas debe ser booleana')
  const appointmentTimeZone = typeof input.appointmentTimeZone === 'string' ? input.appointmentTimeZone.trim() : 'America/Mexico_City'
  try { new Intl.DateTimeFormat('en-US', { timeZone: appointmentTimeZone }) } catch { throw new Error('La zona horaria de citas no es válida') }
  const appointmentDays: number[] = Array.isArray(input.appointmentDays) ? [...new Set<number>(input.appointmentDays)] : [1, 2, 3, 4, 5]
  if (appointmentDays.some((day: unknown) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6)) throw new Error('Selecciona días válidos (0=domingo a 6=sábado)')
  const appointmentStartTime = input.appointmentStartTime ?? '09:00'
  const appointmentEndTime = input.appointmentEndTime ?? '17:00'
  if (typeof appointmentStartTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(appointmentStartTime) || typeof appointmentEndTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(appointmentEndTime)) throw new Error('Los horarios deben usar formato HH:mm')
  const appointmentDurationMinutes = input.appointmentDurationMinutes ?? 60
  if (!Number.isInteger(appointmentDurationMinutes) || appointmentDurationMinutes < 15 || appointmentDurationMinutes > 240 || appointmentDurationMinutes % 5 !== 0) throw new Error('La duración debe ser de 15 a 240 minutos en intervalos de 5')
  if (appointmentsEnabled && (!appointmentDays.length || appointmentEndTime <= appointmentStartTime)) throw new Error('Activa al menos un día y configura un horario de cierre posterior a la apertura')
  if (appointmentsEnabled && !input.autoReply) throw new Error('Para gestionar citas, activa las respuestas automáticas')
  if (appointmentsEnabled && responseMode !== 'deepseek') throw new Error('Para gestionar citas, selecciona DeepSeek como modo de respuesta')
  return {
    botName, businessName, autoReply: input.autoReply, responseMode, responseText: input.responseText.trim(), replyDelayMs: input.replyDelayMs,
    saveToDatabase: input.saveToDatabase, deepseekApiKey, deepseekModel, aiTone, aiResponseLength, aiSystemInstructions, maxRepliesPerHour, messageRetentionDays,
    productCatalogImageUrl: validateCatalogUrl(input.productCatalogImageUrl, 'Imagen general de productos'),
    serviceCatalogImageUrl: validateCatalogUrl(input.serviceCatalogImageUrl, 'Imagen general de servicios'),
    transferEnabled, transferBankName, transferAccountHolder, transferAccountNumber, transferClabe, transferInstructions,
    appointmentsEnabled, appointmentTimeZone, appointmentDays, appointmentStartTime, appointmentEndTime, appointmentDurationMinutes,
  }
}

export function validateInventoryItem(input: any): InventoryItemInput {
  if (!['product', 'service'].includes(input?.itemType)) throw new Error('Tipo debe ser producto o servicio')
  const sku = typeof input.sku === 'string' ? input.sku.trim() : ''
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(sku)) throw new Error('El código debe tener 1-64 caracteres alfanuméricos, punto, guion o guion bajo')
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 200) throw new Error('El nombre es obligatorio y admite hasta 200 caracteres')
  if (typeof input.description !== 'string' || input.description.length > 2000) throw new Error('La descripción admite hasta 2000 caracteres')
  let imageUrl: string | null = null
  if (input.imageUrl !== null && input.imageUrl !== undefined && input.imageUrl !== '') {
    if (typeof input.imageUrl !== 'string' || input.imageUrl.length > 2048) throw new Error('La URL de imagen es demasiado larga')
    let parsed: URL
    try { parsed = new URL(input.imageUrl) } catch { throw new Error('La URL de imagen no es válida') }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) throw new Error('La imagen debe tener una URL HTTPS pública')
    imageUrl = parsed.toString()
  }
  const rawPrice = input.price === '' || input.price === null || input.price === undefined ? null : Number(input.price)
  if (rawPrice !== null && (!Number.isFinite(rawPrice) || rawPrice < 0 || rawPrice > 9_999_999_999.99)) throw new Error('El precio debe ser un número positivo válido')
  const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : ''
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('La moneda debe ser un código de 3 letras, por ejemplo MXN')
  let stockQuantity: number | null = null
  if (input.itemType === 'product' && input.stockQuantity !== null && input.stockQuantity !== '') {
    stockQuantity = Number(input.stockQuantity)
    if (!Number.isInteger(stockQuantity) || stockQuantity < 0 || stockQuantity > 4_294_967_295) throw new Error('Las existencias deben ser un entero igual o mayor que cero')
  }
  if (typeof input.isActive !== 'boolean') throw new Error('El estado activo debe ser booleano')
  return { itemType: input.itemType, sku, name, description: input.description.trim() || null, imageUrl, price: rawPrice === null ? null : rawPrice.toFixed(2), currency, stockQuantity, isActive: input.isActive }
}

export function validateContactProfile(input: any): ContactProfileInput {
  const customName=typeof input?.customName==='string'?input.customName.trim():''
  const tags=typeof input?.tags==='string'?input.tags.trim():''
  const notes=typeof input?.notes==='string'?input.notes.trim():''
  if(customName.length>160||tags.length>500||notes.length>4000)throw new Error('Nombre, etiquetas o notas exceden el límite permitido')
  return { customName:customName||null,tags:tags||null,notes:notes||null }
}

export async function loadAppSettings(fallback: AppSettings): Promise<AppSettings> {
  try {
    const stored = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    const legacySecrets = ['deepseekApiKey','transferAccountHolder','transferAccountNumber','transferClabe','transferInstructions'].some(key => typeof stored[key] === 'string' && stored[key] && !stored[key].startsWith('enc:v1:'))
    const decrypted = decryptAppSettings(stored)
    if (legacySecrets) {
      const temp = `${settingsPath}.tmp`
      await fs.writeFile(temp, JSON.stringify(encryptAppSettings(decrypted), null, 2), 'utf8')
      await fs.rename(temp, settingsPath)
    }
    return validateSettings({ ...fallback, ...decrypted }, fallback.deepseekApiKey)
  } catch (error: any) { if (error.code === 'ENOENT') return fallback; throw error }
}

export async function launchConfigUi(fallback: AppSettings, callbacks: UiCallbacks, port = 3000): Promise<ReturnType<typeof createServer>> {
  const server = createServer(async (request, response) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) {
      sendJson(response, 403, { error: 'Acceso solo desde localhost' }); return
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(html); return
      }
      if (request.method === 'GET' && url.pathname === '/api/settings') {
        const { deepseekApiKey, ...settings } = await loadAppSettings(fallback)
        sendJson(response, 200, { ...settings, deepseekApiKeyConfigured: !!deepseekApiKey }); return
      }
      if (request.method === 'GET' && url.pathname === '/api/status') {
        sendJson(response, 200, callbacks.status()); return
      }
      if (request.method === 'GET' && url.pathname === '/api/inventory') {
        sendJson(response, 200, await listInventoryItems()); return
      }
      if (request.method === 'GET' && url.pathname === '/api/appointments') {
        sendJson(response, 200, await listAppointments()); return
      }
      if (request.method === 'GET' && url.pathname === '/api/inbox') {
        const page = Number(url.searchParams.get('page') ?? 1)
        const pageSize = Number(url.searchParams.get('pageSize') ?? 20)
        const search = (url.searchParams.get('search') ?? '').slice(0, 120)
        sendJson(response, 200, await listInboxChats(page,pageSize,search)); return
      }
      if (request.method === 'GET' && url.pathname === '/api/contacts') {
        const page=Number(url.searchParams.get('page')??1),pageSize=Number(url.searchParams.get('pageSize')??20),search=(url.searchParams.get('search')??'').slice(0,120)
        sendJson(response, 200, await listContacts(page,pageSize,search)); return
      }
      if (request.method === 'POST' && url.pathname === '/api/contacts') {
        const body=await readJson(request)
        if (typeof body.phoneNumber!=='string') throw new Error('El teléfono internacional es obligatorio')
        const phoneNumber=body.phoneNumber.trim().replace(/^\+/, '')
        if (!/^\d{5,20}$/.test(phoneNumber)) throw new Error('Escribe solo los dígitos internacionales, sin transformaciones')
        const profile=validateContactProfile(body)
        const contactId=await createManualContact(phoneNumber,profile)
        sendJson(response,201,{contactId});return
      }
      if (request.method === 'GET' && url.pathname === '/api/carts') {
        sendJson(response, 200, await listShoppingCarts()); return
      }
      if (request.method === 'GET' && url.pathname === '/api/orders') {
        sendJson(response, 200, await listOrders()); return
      }
      const contactRoute = url.pathname.match(/^\/api\/contacts\/(\d+)(?:\/(messages|pause|export|profile))?$/)
      if (contactRoute) {
        const contactId = Number(contactRoute[1])
        const action = contactRoute[2]
        if (request.method === 'GET' && action === 'messages') { sendJson(response, 200, await listContactMessages(contactId)); return }
        if (request.method === 'PATCH' && action === 'profile') {
          const updated=await updateContactProfile(contactId,validateContactProfile(await readJson(request)))
          sendJson(response,updated?200:404,updated?{message:'Contacto actualizado'}:{error:'Contacto no encontrado'});return
        }
        if (request.method === 'POST' && action === 'pause') {
          const body = await readJson(request)
          if (typeof body.paused !== 'boolean') throw new Error('paused debe ser booleano')
          if (!await setChatBotPaused(contactId, body.paused)) { sendJson(response, 404, { error: 'Contacto no encontrado' }); return }
          sendJson(response, 200, { botPaused: body.paused }); return
        }
        if (request.method === 'POST' && action === 'messages') {
          const body = await readJson(request)
          if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) throw new Error('El mensaje manual debe tener entre 1 y 4000 caracteres')
          await callbacks.sendManualMessage(contactId, body.text.trim())
          sendJson(response, 200, { message: 'Mensaje enviado' }); return
        }
        if (request.method === 'GET' && action === 'export') {
          const data = await exportContactData(contactId)
          if (!data) { sendJson(response, 404, { error: 'Contacto no encontrado' }); return }
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="contact-${contactId}-export.json"`, 'cache-control': 'no-store' })
          response.end(JSON.stringify(data, null, 2)); return
        }
        if (request.method === 'DELETE' && !action) {
          const deleted = await callbacks.deleteContact(contactId)
          sendJson(response, deleted ? 200 : 404, deleted ? { message: 'Datos del contacto eliminados' } : { error: 'Contacto no encontrado' }); return
        }
      }
      const cartOrder = url.pathname.match(/^\/api\/carts\/(\d+)\/orders$/)
      if (request.method === 'POST' && cartOrder) {
        const orderId = await createOrderFromCart(Number(cartOrder[1]))
        sendJson(response, 201, { orderId }); return
      }
      const orderRoute = url.pathname.match(/^\/api\/orders\/(\d+)$/)
      if (request.method === 'PATCH' && orderRoute) {
        const body = await readJson(request)
        if (!['confirmed','cancelled'].includes(body.status)) throw new Error('Estado de pedido no válido')
        const changed = await setOrderStatus(Number(orderRoute[1]), body.status)
        sendJson(response, changed ? 200 : 404, changed ? { message: 'Estado del pedido actualizado' } : { error: 'Pedido no encontrado o ya procesado' }); return
      }
      const appointmentRoute = url.pathname.match(/^\/api\/appointments\/(\d+)$/)
      if (request.method === 'PATCH' && appointmentRoute) {
        const body = await readJson(request)
        const id = Number(appointmentRoute[1])
        if (body.action === 'cancel') {
          const changed = await setAppointmentStatus(id, 'cancelled')
          sendJson(response, changed ? 200 : 404, changed ? { message: 'Cita cancelada' } : { error: 'Cita no encontrada' }); return
        }
        if (body.action === 'reschedule' && typeof body.localStart === 'string') {
          const settings = await loadAppSettings(fallback)
          const localStart = resolveAppointmentStart(body.localStart, {
            timeZone: settings.appointmentTimeZone, days: settings.appointmentDays,
            startTime: settings.appointmentStartTime, endTime: settings.appointmentEndTime,
            durationMinutes: settings.appointmentDurationMinutes,
          })
          const startsAt = localStart.toUTC().toJSDate()
          const endsAt = localStart.plus({ minutes: settings.appointmentDurationMinutes }).toUTC().toJSDate()
          const changed = await rescheduleAppointment(id, startsAt, endsAt)
          sendJson(response, changed ? 200 : 409, changed ? { message: 'Cita reprogramada' } : { error: 'El horario está ocupado o la cita ya no está activa' }); return
        }
        throw new Error('Acción de cita no válida')
      }
      if (request.method === 'POST' && url.pathname === '/api/inventory') {
        const item = await createInventoryItem(validateInventoryItem(await readJson(request)))
        sendJson(response, 201, item); return
      }
      const inventoryId = url.pathname.match(/^\/api\/inventory\/(\d+)$/)
      if (request.method === 'PUT' && inventoryId) {
        const item = await updateInventoryItem(Number(inventoryId[1]), validateInventoryItem(await readJson(request)))
        if (!item) { sendJson(response, 404, { error: 'Artículo no encontrado' }); return }
        sendJson(response, 200, item); return
      }
      if (request.method === 'DELETE' && inventoryId) {
        const deleted = await deleteInventoryItem(Number(inventoryId[1]))
        sendJson(response, deleted ? 200 : 404, deleted ? { message: 'Artículo eliminado' } : { error: 'Artículo no encontrado' }); return
      }
      if (request.method === 'POST' && url.pathname === '/api/settings') {
        const current = await loadAppSettings(fallback)
        const settings = validateSettings(await readJson(request), current.deepseekApiKey)
        await fs.mkdir(path.dirname(settingsPath), { recursive: true })
        const temp = `${settingsPath}.tmp`
        await fs.writeFile(temp, JSON.stringify(encryptAppSettings(settings), null, 2), 'utf8')
        await fs.rename(temp, settingsPath)
        sendJson(response, 200, { message: 'Configuración guardada.', deepseekApiKeyConfigured: !!settings.deepseekApiKey }); return
      }
      if (request.method === 'POST' && url.pathname === '/api/start') {
        const settings = await loadAppSettings(fallback)
        await callbacks.start(settings)
        sendJson(response, 200, { message: 'Servicio iniciado. Escanea el QR mostrado en la terminal.' }); return
      }
      if (request.method === 'POST' && url.pathname === '/api/logout') {
        await callbacks.logout()
        sendJson(response, 200, { message: 'Sesión cerrada y credenciales locales eliminadas.' }); return
      }
      sendJson(response, 404, { error: 'Ruta no encontrada' })
    } catch (error: any) { sendJson(response, 400, { error: error.message || 'Error interno' }) }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return server
}
