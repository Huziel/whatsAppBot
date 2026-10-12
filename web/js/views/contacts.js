import { $, api } from '../api.js'

let page=1,total=0,timer
const pageSize=20

export function initializeContacts(){
  $('contactSearch').addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>loadContacts(true),250)})
  $('contactPrev').onclick=()=>{if(page>1){page--;void loadContacts()}}
  $('contactNext').onclick=()=>{if(page<Math.ceil(total/pageSize)){page++;void loadContacts()}}
  $('newContact').onclick=()=>showForm(null)
  $('contactCancel').onclick=()=>{$('contactFormCard').classList.add('hidden')}
  $('contactForm').onsubmit=saveContact
  void loadContacts()
}

function render(rows){const body=$('contactsRows');body.replaceChildren();for(const item of rows){const row=document.createElement('tr');cell(row,item.displayName||('Contacto '+item.contactId));cell(row,item.phoneNumber||(item.hasLid?'Sin correspondencia telefónica (LID)':'No resuelto'));cell(row,item.tags||'—');cell(row,String(item.chatCount));cell(row,String(item.messageCount));const actions=cell(row,'');actions.className='actions';const edit=document.createElement('button');edit.className='btn';edit.textContent='Editar';edit.onclick=()=>showForm(item);const remove=document.createElement('button');remove.className='btn-danger';remove.textContent='Eliminar';remove.onclick=()=>deleteContact(item);actions.append(edit,remove);body.appendChild(row)}const pages=Math.max(1,Math.ceil(total/pageSize));$('contactsNotice').textContent=total+' contactos';$('contactPageLabel').textContent=`Página ${page} de ${pages}`;$('contactPrev').disabled=page<=1;$('contactNext').disabled=page>=pages}
function cell(row,value){const td=document.createElement('td');td.textContent=value??'';row.appendChild(td);return td}
async function loadContacts(reset=false){try{if(reset)page=1;const params=new URLSearchParams({page:String(page),pageSize:String(pageSize),search:$('contactSearch').value.trim()});const result=await api('/api/contacts?'+params);page=result.page;total=result.total;render(result.rows)}catch(error){$('contactsNotice').textContent=error.message}}
function showForm(contact){$('contactForm').reset();$('contactId').value=contact?.contactId??'';$('contactFormTitle').textContent=contact?'Editar perfil de contacto':'Nuevo contacto';$('contactPhoneField').hidden=!!contact;$('contactPhone').required=!contact;$('contactName').value=contact?.customName||'';$('contactTags').value=contact?.tags||'';$('contactNotes').value=contact?.notes||'';$('contactFormCard').classList.remove('hidden');$('contactFormCard').scrollIntoView({behavior:'smooth'})}
async function saveContact(event){event.preventDefault();if(!$('contactForm').reportValidity())return;const id=$('contactId').value;const profile={customName:$('contactName').value,tags:$('contactTags').value,notes:$('contactNotes').value};try{if(id)await api('/api/contacts/'+id+'/profile','PATCH',profile);else await api('/api/contacts','POST',{phoneNumber:$('contactPhone').value,...profile});$('contactFormCard').classList.add('hidden');await loadContacts(true)}catch(error){$('contactsNotice').textContent=error.message}}
async function deleteContact(contact){if(!confirm('¿Eliminar permanentemente el contacto y chats, mensajes, pedidos, carritos y citas relacionados?'))return;try{await api('/api/contacts/'+contact.contactId,'DELETE');await loadContacts(true)}catch(error){$('contactsNotice').textContent=error.message}}
