export function createFormModal(element,heading){
  const dialog=document.createElement('dialog');dialog.className='app-modal';dialog.setAttribute('aria-labelledby',heading.id||'appModalTitle')
  const header=document.createElement('header');header.className='app-modal-header'
  if(!heading.id)heading.id='appModalTitle'
  heading.classList.add('app-modal-title');header.appendChild(heading)
  const close=document.createElement('button');close.type='button';close.className='app-modal-close';close.textContent='×';close.setAttribute('aria-label','Cerrar ventana');close.onclick=()=>dialog.close()
  header.appendChild(close)
  const content=document.createElement('div');content.className='app-modal-content'
  element.classList.remove('hidden','glass-panel','p-5','mt-5','relative','overflow-hidden')
  content.appendChild(element);dialog.append(header,content);document.body.appendChild(dialog)
  dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close()})
  return {open(){if(!dialog.open)dialog.showModal();[...dialog.querySelectorAll('input:not([type="hidden"]),textarea,select,button')].find(control=>!control.disabled&&!control.closest('.hidden'))?.focus()},close(){if(dialog.open)dialog.close()},setTitle(value){heading.textContent=value},dialog}
}

function buildActionDialog({title,message,confirmText,cancelText='Cancelar',danger=false,input}){
  const dialog=document.createElement('dialog');dialog.className='app-modal app-action-modal'
  const header=document.createElement('header');header.className='app-modal-header'
  const heading=document.createElement('h2');heading.className='app-modal-title';heading.textContent=title;heading.id='actionModalTitle';header.appendChild(heading)
  const close=document.createElement('button');close.type='button';close.className='app-modal-close';close.textContent='×';close.setAttribute('aria-label','Cerrar ventana');header.appendChild(close)
  const content=document.createElement('div');content.className='app-modal-content'
  const copy=document.createElement('p');copy.className='text-sm leading-6 text-muted';copy.textContent=message;content.appendChild(copy)
  let field
  if(input){const label=document.createElement('label');label.className='field-label mt-4';label.textContent=input.label;field=document.createElement('input');field.className='control';field.type=input.type??'text';field.value=input.value??'';field.placeholder=input.placeholder??'';field.required=!!input.required;if(input.step)field.step=input.step;if(input.min)field.min=input.min;label.htmlFor='actionModalInput';field.id='actionModalInput';content.append(label,field)}
  const actions=document.createElement('div');actions.className='app-modal-actions'
  const cancel=document.createElement('button');cancel.type='button';cancel.className='btn';cancel.textContent=cancelText
  const confirm=document.createElement('button');confirm.type='button';confirm.className=danger?'btn-danger':'btn-primary';confirm.textContent=confirmText
  actions.append(cancel,confirm);content.appendChild(actions);dialog.append(header,content);document.body.appendChild(dialog)
  close.onclick=cancel.onclick=()=>dialog.close()
  dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close()})
  return {dialog,field,confirm,cancel}
}

export function confirmAction(options){
  const modal=buildActionDialog({cancelText:'No, volver',...options})
  return new Promise(resolve=>{
    let result=false
    modal.confirm.onclick=()=>{result=true;modal.dialog.close()}
    modal.dialog.addEventListener('close',()=>{modal.dialog.remove();resolve(result)},{once:true})
    modal.dialog.showModal();modal.confirm.focus()
  })
}

export function promptAction(options){
  const modal=buildActionDialog({cancelText:'Cancelar',...options,input:{required:true,...options.input}})
  return new Promise(resolve=>{
    let result=null
    modal.confirm.onclick=()=>{if(!modal.field.reportValidity())return;result=modal.field.value;modal.dialog.close()}
    modal.dialog.addEventListener('close',()=>{modal.dialog.remove();resolve(result)},{once:true})
    modal.dialog.showModal();modal.field.focus()
  })
}

export function showToast(message,type='success'){
  let region=document.getElementById('appToastRegion')
  if(!region){region=document.createElement('div');region.id='appToastRegion';region.className='app-toast-region';region.setAttribute('aria-live','polite');region.setAttribute('aria-atomic','true');document.body.appendChild(region)}
  const toast=document.createElement('div');toast.className=`app-toast ${type==='error'?'app-toast-error':''}`;toast.textContent=message;region.appendChild(toast)
  setTimeout(()=>{toast.classList.add('app-toast-leaving');setTimeout(()=>toast.remove(),250)},4000)
}
