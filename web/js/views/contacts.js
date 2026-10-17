import { $, api } from '../api.js'
import { confirmAction, createFormModal, showToast } from '../ui/dialogs.js?v=dialogs-1'

let page=1,total=0,timer
let contactModal,bulkImportModal
const pageSize=20

export function initializeContacts(){
  $('view-contacts').querySelector('.section-copy').textContent='Mini CRM de WhatsApp: importa contactos, organiza etiquetas y abre cada chat con un clic.'
  $('contactPhone').previousElementSibling.textContent='WhatsApp internacional (incluye prefijo de país)'
  $('contactSearch').addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>loadContacts(true),250)})
  $('contactPrev').onclick=()=>{if(page>1){page--;void loadContacts()}}
  $('contactNext').onclick=()=>{if(page<Math.ceil(total/pageSize)){page++;void loadContacts()}}
  contactModal=createFormModal($('contactFormCard'),$('contactFormTitle'))
  $('newContact').onclick=()=>{showForm(null);contactModal.open()}
  $('contactCancel').onclick=()=>contactModal.close()
  $('contactForm').onsubmit=saveContact
  installBulkImport()
  void loadContacts()
}

function installBulkImport(){
  const card=document.createElement('section');card.className='glass-panel mt-5 p-5'
  const title=document.createElement('h3');title.className='section-title';title.textContent='Importar contactos'
  const help=document.createElement('p');help.className='section-copy mt-2';help.textContent='Pega un número por línea o usa CSV: número, nombre, etiquetas, notas. Incluye el prefijo internacional, por ejemplo +52.'
  const input=document.createElement('textarea');input.id='bulkContactsInput';input.className='control-area mt-4';input.rows=7;input.placeholder='+525512345678, Ana Pérez, clientes\n+525598765432'
  const fileRow=document.createElement('div');fileRow.className='mt-3 flex flex-wrap items-center gap-3'
  const fileLabel=document.createElement('label');fileLabel.className='btn cursor-pointer';fileLabel.textContent='Cargar CSV o TXT'
  const file=document.createElement('input');file.type='file';file.accept='.csv,.txt,text/csv,text/plain';file.className='sr-only';file.onchange=async()=>{const selected=file.files?.[0];if(selected)input.value=await selected.text()}
  fileLabel.appendChild(file)
  const submit=document.createElement('button');submit.type='button';submit.className='btn-primary';submit.textContent='Importar lista';submit.onclick=()=>void submitBulkImport(input,submit)
  const notice=document.createElement('div');notice.id='bulkContactsNotice';notice.className='hint mt-3';notice.setAttribute('role','status')
  fileRow.append(fileLabel,submit);card.append(title,help,input,fileRow,notice)
  const open=document.createElement('button');open.type='button';open.className='btn';open.textContent='Importar lista';open.onclick=()=>bulkImportModal.open();$('newContact').parentElement.appendChild(open)
  bulkImportModal=createFormModal(card,title)
}

function splitCsvLine(line,delimiter){
  const fields=[];let value='',quoted=false
  for(let i=0;i<line.length;i++){
    const char=line[i]
    if(char==='"'&&quoted&&line[i+1]==='"'){value+='"';i++}
    else if(char==='"')quoted=!quoted
    else if(char===delimiter&&!quoted){fields.push(value.trim());value=''}
    else value+=char
  }
  fields.push(value.trim());return fields
}

function parseBulkContacts(text){
  const lines=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean)
  if(!lines.length)throw new Error('Pega o carga al menos un número.')
  const delimiter=[',',';','\t'].find(char=>lines[0].includes(char))??','
  const first=splitCsvLine(lines[0],delimiter)
  const hasHeader=/^(telefono|teléfono|phone|numero|número|whatsapp)$/i.test(first[0].replace(/^\+/,''))
  const rows=hasHeader?lines.slice(1):lines
  return rows.map(line=>{
    const [phoneNumber,customName='',tags='',notes='']=splitCsvLine(line,delimiter)
    return {phoneNumber,customName,tags,notes}
  })
}

async function submitBulkImport(input,button){
  const notice=$('bulkContactsNotice');button.disabled=true
  try{
    const contacts=parseBulkContacts(input.value)
    if(contacts.length>500)throw new Error('Puedes importar hasta 500 números por lote.')
    const result=await api('/api/contacts/import',{contacts})
    notice.textContent=`Importados: ${result.created}. Actualizados: ${result.updated}. Repetidos omitidos: ${result.duplicates}.`
    input.value='';bulkImportModal.close();showToast(notice.textContent);await loadContacts(true)
  }catch(error){notice.textContent=error.message;showToast(error.message,'error')}
  finally{button.disabled=false}
}

function render(rows){
  const body=$('contactsRows');body.replaceChildren()
  for(const item of rows){
    const row=document.createElement('tr')
    cell(row,item.customName||item.displayName||('Contacto '+item.contactId))
    cell(row,item.phoneNumber||'—');cell(row,item.tags||'—');cell(row,String(item.chatCount));cell(row,String(item.messageCount))
    const actions=cell(row,'');actions.className='actions'
    if(item.phoneNumber){const whatsapp=document.createElement('a');whatsapp.className='btn';whatsapp.href=`https://wa.me/${encodeURIComponent(item.phoneNumber)}`;whatsapp.target='_blank';whatsapp.rel='noopener noreferrer';whatsapp.textContent='WhatsApp';whatsapp.setAttribute('aria-label',`Abrir chat de WhatsApp con ${item.customName||item.displayName||item.phoneNumber}`);actions.appendChild(whatsapp)}
    const edit=document.createElement('button');edit.className='btn';edit.textContent='Editar';edit.onclick=()=>showForm(item)
    const remove=document.createElement('button');remove.className='btn-danger';remove.textContent='Eliminar';remove.onclick=()=>deleteContact(item)
    actions.append(edit,remove);body.appendChild(row)
  }
  const pages=Math.max(1,Math.ceil(total/pageSize));$('contactsNotice').textContent=total+' contactos';$('contactPageLabel').textContent=`Página ${page} de ${pages}`;$('contactPrev').disabled=page<=1;$('contactNext').disabled=page>=pages
}

function cell(row,value){const td=document.createElement('td');td.textContent=value??'';row.appendChild(td);return td}
async function loadContacts(reset=false){try{if(reset)page=1;const params=new URLSearchParams({page:String(page),pageSize:String(pageSize),search:$('contactSearch').value.trim()});const result=await api('/api/contacts?'+params);page=result.page;total=result.total;render(result.rows)}catch(error){$('contactsNotice').textContent=error.message}}
function showForm(contact){
  $('contactForm').reset();$('contactId').value=contact?.contactId??'';$('contactFormTitle').textContent=contact?'Editar contacto':'Nuevo contacto'
  $('contactPhoneField').hidden=false;$('contactPhone').required=true;$('contactPhone').value=contact?.phoneNumber??''
  $('contactPhone').pattern='\\+?[0-9\\s().-]{5,32}';$('contactPhone').maxLength=32
  $('contactName').value=contact?.customName||contact?.displayName||'';$('contactTags').value=contact?.tags||'';$('contactNotes').value=contact?.notes||''
  contactModal.setTitle(contact?'Editar contacto':'Nuevo contacto')
}
async function saveContact(event){
  event.preventDefault();if(!$('contactForm').reportValidity())return
  const id=$('contactId').value,profile={phoneNumber:$('contactPhone').value,customName:$('contactName').value,tags:$('contactTags').value,notes:$('contactNotes').value}
  try{if(id)await api('/api/contacts/'+id+'/profile','PATCH',profile);else await api('/api/contacts','POST',profile);contactModal.close();showToast(id?'Contacto actualizado.':'Contacto creado.');await loadContacts(true)}catch(error){$('contactsNotice').textContent=error.message;showToast(error.message,'error')}
}
async function deleteContact(contact){if(!await confirmAction({title:'Eliminar contacto',message:'Se eliminarán permanentemente el contacto, sus chats, mensajes, pedidos, carritos y citas.',confirmText:'Eliminar',danger:true}))return;try{await api('/api/contacts/'+contact.contactId,'DELETE');showToast('Contacto eliminado.');await loadContacts(true)}catch(error){$('contactsNotice').textContent=error.message;showToast(error.message,'error')}}
