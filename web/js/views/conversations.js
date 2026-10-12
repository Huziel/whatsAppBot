import { $, api } from '../api.js'
import { getSettings } from '../state.mjs'

let chats=[],selected=null,page=1,total=0,searchTimer
const pageSize=20

export function initializeConversations(){
  $('inboxSearch').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadInbox(true),250)})
  $('inboxPrev').addEventListener('click',()=>{if(page>1){page--;void loadInbox()}})
  $('inboxNext').addEventListener('click',()=>{if(page<Math.ceil(total/pageSize)){page++;void loadInbox()}})
  $('togglePause').addEventListener('click',togglePause)
  $('sendManual').addEventListener('click',sendManual)
  $('deleteContact').addEventListener('click',deleteSelected)
  $('exportContact').addEventListener('click',event=>{if(!selected)event.preventDefault()})
  void loadInbox();setInterval(()=>{void loadInbox();if(selected)void loadMessages()},7000)
}

function renderInbox(){
  const body=$('inboxRows');body.replaceChildren()
  for(const chat of chats){const row=document.createElement('tr');if(selected?.contactId===chat.contactId)row.classList.add('selected-row');const name=document.createElement('td');name.textContent=chat.displayName||('Contacto '+chat.contactId);const last=document.createElement('td');last.textContent=chat.lastMessageText?(chat.lastMessageText.length>120?chat.lastMessageText.slice(0,120)+'…':chat.lastMessageText):'Mensaje sin texto';const state=document.createElement('td');const badge=document.createElement('span');badge.className='badge '+(chat.botPaused?'badge-warning':'badge-success');badge.textContent=chat.botPaused?'IA pausada':'IA activa';state.appendChild(badge);const actions=document.createElement('td'),open=document.createElement('button');open.className='btn';open.textContent='Abrir';open.onclick=()=>selectChat(chat);actions.appendChild(open);row.append(name,last,state,actions);body.appendChild(row)}
  const pages=Math.max(1,Math.ceil(total/pageSize));$('inboxNotice').textContent=total?`${total} conversaciones`:'No hay conversaciones.';$('inboxPageLabel').textContent=`Página ${page} de ${pages}`;$('inboxPrev').disabled=page<=1;$('inboxNext').disabled=page>=pages
}

async function loadInbox(reset=false){try{if(reset)page=1;const query=new URLSearchParams({page:String(page),pageSize:String(pageSize),search:$('inboxSearch').value.trim()});const result=await api('/api/inbox?'+query);chats=result.rows;total=result.total;page=result.page;renderInbox();if(selected){const found=chats.find(item=>item.contactId===selected.contactId);if(found){selected=found;renderSelected()}}}catch(error){$('inboxNotice').textContent=error.message}}
function selectChat(chat){selected=chat;renderInbox();renderSelected();void loadMessages()}
function renderSelected(){if(!selected)return;$('chatPanel').classList.remove('hidden');$('chatTitle').textContent=(selected.displayName||('Contacto '+selected.contactId))+(selected.phoneNumber?' · '+selected.phoneNumber:'');$('togglePause').textContent=selected.botPaused?'Reanudar IA':'Pausar IA';$('exportContact').href='/api/contacts/'+selected.contactId+'/export'}
async function loadMessages(){if(!selected)return;try{const items=await api('/api/contacts/'+selected.contactId+'/messages');const panel=$('chatMessages');panel.replaceChildren();const zone=getSettings()?.appointmentTimeZone||'America/Mexico_City',fmt=new Intl.DateTimeFormat('es-MX',{timeZone:zone,dateStyle:'short',timeStyle:'short'});for(const item of items){const bubble=document.createElement('article');bubble.className='bubble'+(item.fromMe?' mine':'');const meta=document.createElement('small');meta.textContent=(item.fromMe?'Tú':'Contacto')+' · '+fmt.format(new Date(item.messageTimestamp))+(item.isDeleted?' · eliminado':'');const text=document.createElement('div');text.textContent=item.isDeleted?'Mensaje eliminado':item.text||`[${item.messageType}]`;bubble.append(meta,text);panel.appendChild(bubble)}panel.scrollTop=panel.scrollHeight}catch(error){$('inboxNotice').textContent=error.message}}
async function togglePause(){if(!selected)return;try{const result=await api('/api/contacts/'+selected.contactId+'/pause','POST',{paused:!selected.botPaused});selected.botPaused=result.botPaused;renderSelected();await loadInbox()}catch(error){$('inboxNotice').textContent=error.message}}
async function sendManual(){if(!selected)return;const text=$('manualText').value.trim();if(!text)return;try{await api('/api/contacts/'+selected.contactId+'/messages','POST',{text});$('manualText').value='';await loadMessages();await loadInbox()}catch(error){$('inboxNotice').textContent=error.message}}
async function deleteSelected(){if(!selected||!confirm('¿Eliminar permanentemente el contacto y sus chats, mensajes, citas, carritos y pedidos?'))return;try{await api('/api/contacts/'+selected.contactId,'DELETE');selected=null;$('chatPanel').classList.add('hidden');await loadInbox()}catch(error){$('inboxNotice').textContent=error.message}}
