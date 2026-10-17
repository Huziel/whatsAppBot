import { $, api } from '../api.js'
import { confirmAction, showToast } from '../ui/dialogs.js?v=dialogs-1'
import { getSettings } from '../state.mjs'

let chats=[],selected=null,page=1,total=0,searchTimer
const pageSize=20
const maxManualImageBytes=5*1024*1024
let selectedImage=null
const pauseBusy=new Set()

export function initializeConversations(){
  $('inboxSearch').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadInbox(true),250)})
  $('inboxPrev').addEventListener('click',()=>{if(page>1){page--;void loadInbox()}})
  $('inboxNext').addEventListener('click',()=>{if(page<Math.ceil(total/pageSize)){page++;void loadInbox()}})
  $('togglePause').addEventListener('click',togglePause)
  $('manualMessageForm').addEventListener('submit',sendManual)
  $('manualImage').addEventListener('change',selectManualImage)
  $('removeManualImage').addEventListener('click',clearManualImage)
  $('deleteContact').addEventListener('click',deleteSelected)
  $('exportContact').addEventListener('click',event=>{if(!selected)event.preventDefault()})
  void loadInbox();setInterval(()=>{void loadInbox();if(selected)void loadMessages()},7000)
}

function renderInbox(){
  const body=$('inboxRows');body.replaceChildren()
  for(const chat of chats){const row=document.createElement('tr');if(selected?.contactId===chat.contactId)row.classList.add('selected-row');const name=document.createElement('td');name.textContent=chat.displayName||('Contacto '+chat.contactId);const last=document.createElement('td');last.textContent=chat.lastMessageText?(chat.lastMessageText.length>120?chat.lastMessageText.slice(0,120)+'…':chat.lastMessageText):'Mensaje sin texto';const state=document.createElement('td');const badge=document.createElement('span');badge.className='badge '+(chat.botPaused?'badge-warning':'badge-success');badge.textContent=chat.botPaused?'IA pausada':'IA activa';state.appendChild(badge);const actions=document.createElement('td');actions.className='whitespace-nowrap';const open=document.createElement('button');open.className='btn';open.textContent='Abrir';open.onclick=()=>selectChat(chat);const pause=document.createElement('button');pause.className=chat.botPaused?'btn-primary ml-1':'btn ml-1';pause.textContent=chat.botPaused?'Reanudar IA':'Pausar IA';pause.disabled=pauseBusy.has(chat.contactId);pause.setAttribute('aria-label',`${pause.textContent} para ${chat.displayName||'contacto'}`);pause.onclick=()=>void toggleChatPause(chat);actions.append(open,pause);row.append(name,last,state,actions);body.appendChild(row)}
  const pages=Math.max(1,Math.ceil(total/pageSize));$('inboxNotice').textContent=total?`${total} conversaciones`:'No hay conversaciones.';$('inboxPageLabel').textContent=`Página ${page} de ${pages}`;$('inboxPrev').disabled=page<=1;$('inboxNext').disabled=page>=pages
}

async function loadInbox(reset=false){try{if(reset)page=1;const query=new URLSearchParams({page:String(page),pageSize:String(pageSize),search:$('inboxSearch').value.trim()});const result=await api('/api/inbox?'+query);chats=result.rows;total=result.total;page=result.page;renderInbox();if(selected){const found=chats.find(item=>item.contactId===selected.contactId);if(found){selected=found;renderSelected()}}}catch(error){$('inboxNotice').textContent=error.message}}
function selectChat(chat){selected=chat;clearManualImage();$('manualText').value='';$('manualSendNotice').textContent='';renderInbox();renderSelected();void loadMessages()}
function renderSelected(){
  if(!selected)return
  const name=selected.displayName||('Contacto '+selected.contactId)
  $('chatPanel').classList.remove('hidden');$('chatTitle').textContent=name+(selected.phoneNumber?' · '+selected.phoneNumber:'')
  $('chatAvatar').textContent=name.trim().charAt(0).toLocaleUpperCase('es')||'C'
  $('togglePause').textContent=selected.botPaused?'Reanudar IA':'Pausar IA';$('exportContact').href='/api/contacts/'+selected.contactId+'/export'
}

function messageKindLabel(type){
  const labels={imageMessage:'▧ Imagen adjunta',videoMessage:'▷ Video adjunto',audioMessage:'♫ Audio adjunto',pttMessage:'♫ Mensaje de voz',documentMessage:'▤ Documento adjunto',stickerMessage:'◇ Sticker',locationMessage:'⌖ Ubicación',contactMessage:'♙ Contacto compartido'}
  return labels[type]??'Mensaje sin texto'
}

function dateKey(date,zone){return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date)}

async function loadMessages(){
  if(!selected)return
  const contactId=selected.contactId
  try{
    const items=await api('/api/contacts/'+contactId+'/messages')
    if(selected?.contactId!==contactId)return
    const panel=$('chatMessages');panel.replaceChildren()
    const zone=getSettings()?.appointmentTimeZone||'America/Mexico_City'
    const dayFormatter=new Intl.DateTimeFormat('es-MX',{timeZone:zone,weekday:'long',day:'numeric',month:'long',year:'numeric'})
    const timeFormatter=new Intl.DateTimeFormat('es-MX',{timeZone:zone,hour:'2-digit',minute:'2-digit'})
    let currentDay=''
    for(const item of items){
      const date=new Date(item.messageTimestamp),day=dateKey(date,zone)
      if(day!==currentDay){const divider=document.createElement('div');divider.className='chat-day-divider';divider.textContent=dayFormatter.format(date);panel.appendChild(divider);currentDay=day}
      const mine=Boolean(item.fromMe),row=document.createElement('div');row.className='chat-message-row'+(mine?' mine':'')
      if(!mine){const avatar=document.createElement('span');avatar.className='chat-message-avatar';avatar.textContent=(selected.displayName||'C').trim().charAt(0).toLocaleUpperCase('es')||'C';avatar.setAttribute('aria-hidden','true');row.appendChild(avatar)}
      const bubble=document.createElement('article');bubble.className='chat-bubble'+(mine?' mine':'')+(item.isDeleted?' deleted':'')
      const meta=document.createElement('div');meta.className='chat-message-meta'
      const sender=document.createElement('span');sender.className='chat-sender';sender.textContent=mine?'Tú':(selected.displayName||'Contacto')
      const time=document.createElement('time');time.className='chat-message-time';time.dateTime=Number.isNaN(date.getTime())?'':date.toISOString();time.textContent=Number.isNaN(date.getTime())?'':timeFormatter.format(date)
      meta.append(sender,time)
      if(item.isDeleted){const deleted=document.createElement('span');deleted.textContent='Eliminado';deleted.className='badge-warning';meta.appendChild(deleted)}
      bubble.appendChild(meta)
      if(item.isDeleted){const body=document.createElement('div');body.className='chat-message-body italic';body.textContent='Este mensaje fue eliminado';bubble.appendChild(body)}
      else if(item.text){const body=document.createElement('div');body.className='chat-message-body';body.textContent=item.text;bubble.appendChild(body)}
      else{const kind=document.createElement('div');kind.className='chat-message-kind';kind.textContent=messageKindLabel(item.messageType);bubble.appendChild(kind)}
      row.appendChild(bubble);panel.appendChild(row)
    }
    if(!items.length){const empty=document.createElement('div');empty.className='chat-empty';empty.textContent='Aún no hay mensajes guardados en esta conversación. Cuando llegue o envíes uno, aparecerá aquí.';panel.appendChild(empty)}
    panel.scrollTop=panel.scrollHeight
  }catch(error){$('inboxNotice').textContent=error.message}
}
async function togglePause(){if(selected)await toggleChatPause(selected)}
async function toggleChatPause(chat){
  if(pauseBusy.has(chat.contactId))return
  pauseBusy.add(chat.contactId);renderInbox()
  try{
    const result=await api('/api/contacts/'+chat.contactId+'/pause','POST',{paused:!chat.botPaused})
    chats=chats.map(item=>item.contactId===chat.contactId?{...item,botPaused:result.botPaused}:item)
    if(selected?.contactId===chat.contactId){selected={...selected,botPaused:result.botPaused};renderSelected()}
    $('inboxNotice').textContent=result.botPaused?'IA pausada para este contacto.':'IA reanudada para este contacto.'
  }catch(error){$('inboxNotice').textContent=error.message}
  finally{pauseBusy.delete(chat.contactId);renderInbox()}
}
async function selectManualImage(){
  const file=$('manualImage').files?.[0]
  if(!file){clearManualImage();return}
  if(file.size>maxManualImageBytes){clearManualImage();$('manualSendNotice').textContent='La imagen debe pesar como máximo 5 MB.';return}
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)){clearManualImage();$('manualSendNotice').textContent='Selecciona una imagen JPG, PNG o WebP.';return}
  selectedImage=file
  $('manualImageName').textContent=`${file.name} · ${(file.size/1024/1024).toFixed(2)} MB`
  $('removeManualImage').classList.remove('hidden')
  const preview=$('manualImagePreview');preview.src=URL.createObjectURL(file);preview.classList.remove('hidden')
  $('manualSendNotice').textContent=''
}

function clearManualImage(){
  const preview=$('manualImagePreview')
  if(preview.src.startsWith('blob:'))URL.revokeObjectURL(preview.src)
  preview.removeAttribute('src');preview.classList.add('hidden')
  $('manualImage').value='';$('manualImageName').textContent='JPG, PNG o WebP · máximo 5 MB';$('removeManualImage').classList.add('hidden');selectedImage=null
}

function fileAsBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',',2)[1]??'');reader.onerror=()=>reject(new Error('No se pudo leer la imagen seleccionada.'));reader.readAsDataURL(file)})}

async function sendManual(event){
  event.preventDefault()
  if(!selected)return
  const contactId=selected.contactId,text=$('manualText').value.trim(),image=selectedImage
  if(!text&&!image){$('manualSendNotice').textContent='Escribe un mensaje o adjunta una imagen.';return}
  const button=$('sendManual');button.disabled=true;$('manualSendNotice').textContent=image?'Enviando imagen…':'Enviando mensaje…'
  try{
    const body={text}
    if(image){body.imageData=await fileAsBase64(image);body.imageMimeType=image.type}
    await api(`/api/contacts/${contactId}/messages`,'POST',body)
    $('manualText').value='';clearManualImage();$('manualSendNotice').textContent='Enviado al contacto.'
    await loadMessages();await loadInbox()
  }catch(error){$('manualSendNotice').textContent=error.message}
  finally{button.disabled=false}
}
async function deleteSelected(){if(!selected||!await confirmAction({title:'Eliminar contacto',message:'Se eliminarán permanentemente el contacto y sus chats, mensajes, citas, carritos y pedidos.',confirmText:'Eliminar',danger:true}))return;try{await api('/api/contacts/'+selected.contactId,'DELETE');selected=null;$('chatPanel').classList.add('hidden');showToast('Contacto eliminado.');await loadInbox()}catch(error){$('inboxNotice').textContent=error.message;showToast(error.message,'error')}}
