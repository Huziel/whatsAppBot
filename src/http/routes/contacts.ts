import { createManualContact, exportContactData, importManualContacts, listContactMessages, listContacts, listInboxChats, setChatBotPaused, updateContactProfile, updateContactRecord } from '../../db'
import { UiCallbacks } from '../../ui/settings'
import { validateContactProfile } from '../../ui/validators'
import type { ManualMessage } from '../../ui/settings'
import { ApiContext, readJson, sendJson } from '../shared'
import { ValidationError } from '../../errors'

function profile(input:any){try{return validateContactProfile(input)}catch(error:any){throw new ValidationError(error?.message||'Perfil no válido.','INVALID_CONTACT_PROFILE')}}
function phone(value:unknown):string{
  if(typeof value!=='string'||!/^\+?[0-9\s().-]{5,32}$/.test(value.trim()))throw new ValidationError('Ingresa un número de WhatsApp internacional válido.','INVALID_PHONE')
  const digits=value.trim().replace(/\D/g,'')
  if(digits.length<5||digits.length>20)throw new ValidationError('El número debe contener entre 5 y 20 dígitos, incluido el prefijo de país.','INVALID_PHONE')
  return digits
}

export async function handleContactsRoute({ request, response, url }: ApiContext, callbacks: UiCallbacks): Promise<boolean> {
  if (request.method === 'GET' && url.pathname === '/api/inbox') {
    const page=Number(url.searchParams.get('page')??1),pageSize=Number(url.searchParams.get('pageSize')??20),search=(url.searchParams.get('search')??'').slice(0,120)
    sendJson(response,200,await listInboxChats(page,pageSize,search));return true
  }
  if (request.method === 'GET' && url.pathname === '/api/contacts') {
    const page=Number(url.searchParams.get('page')??1),pageSize=Number(url.searchParams.get('pageSize')??20),search=(url.searchParams.get('search')??'').slice(0,120)
    sendJson(response,200,await listContacts(page,pageSize,search));return true
  }
  if (request.method === 'POST' && url.pathname === '/api/contacts') {
    const body=await readJson(request)
    sendJson(response,201,{contactId:await createManualContact(phone(body.phoneNumber),profile(body))});return true
  }
  if(request.method==='POST'&&url.pathname==='/api/contacts/import'){
    const body=await readJson(request,256_000)
    if(!Array.isArray(body.contacts)||!body.contacts.length||body.contacts.length>500)throw new ValidationError('La importación debe incluir entre 1 y 500 contactos.','INVALID_CONTACT_IMPORT')
    const contacts=body.contacts.map((item:any,index:number)=>{
      try{return {phoneNumber:phone(item?.phoneNumber),...profile(item)}}
      catch(error:any){throw new ValidationError(`Fila ${index+1}: ${error?.message||'contacto no válido'}`,'INVALID_CONTACT_IMPORT_ROW')}
    })
    sendJson(response,200,await importManualContacts(contacts));return true
  }
  const route=url.pathname.match(/^\/api\/contacts\/(\d+)(?:\/(messages|pause|export|profile))?$/)
  if(!route)return false
  const contactId=Number(route[1]),action=route[2]
  if(request.method==='GET'&&action==='messages'){sendJson(response,200,await listContactMessages(contactId));return true}
  if(request.method==='PATCH'&&action==='profile'){
    const body=await readJson(request),contactProfile=profile(body)
    const updated=typeof body.phoneNumber==='string'
      ?await updateContactRecord(contactId,phone(body.phoneNumber),contactProfile)
      :await updateContactProfile(contactId,contactProfile)
    sendJson(response,updated?200:404,updated?{message:'Contacto actualizado'}:{error:'Contacto no encontrado'});return true
  }
  if(request.method==='POST'&&action==='pause'){
    const body=await readJson(request);if(typeof body.paused!=='boolean')throw new ValidationError('paused debe ser booleano.','INVALID_PAUSE_STATE')
    const updated=await setChatBotPaused(contactId,body.paused)
    sendJson(response,updated?200:404,updated?{botPaused:body.paused}:{error:'Contacto no encontrado'});return true
  }
  if(request.method==='POST'&&action==='messages'){
    const body=await readJson(request,7_100_000)
    const text=typeof body.text==='string'?body.text.trim():''
    if(text.length>4000)throw new ValidationError('El texto o pie de imagen admite hasta 4000 caracteres.','MESSAGE_TOO_LONG')
    let image:Buffer|null=null,mimeType:string|null=null
    if(body.imageData!==undefined&&body.imageData!==null&&body.imageData!==''){
      if(typeof body.imageData!=='string'||typeof body.imageMimeType!=='string')throw new ValidationError('La imagen no tiene un formato válido.','INVALID_IMAGE')
      if(!['image/jpeg','image/png','image/webp'].includes(body.imageMimeType))throw new ValidationError('La imagen debe ser JPG, PNG o WebP.','INVALID_IMAGE_TYPE')
      if(body.imageData.length>7_000_000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.imageData))throw new ValidationError('El archivo de imagen no es válido o supera 5 MB.','INVALID_IMAGE')
      image=Buffer.from(body.imageData,'base64')
      if(!image.length||image.length>5*1024*1024||image.toString('base64')!==body.imageData)throw new ValidationError('La imagen debe pesar como máximo 5 MB.','INVALID_IMAGE')
      mimeType=body.imageMimeType
    }
    if(!text&&!image)throw new ValidationError('Escribe un mensaje o selecciona una imagen.','EMPTY_MESSAGE')
    const message:ManualMessage={text,image,mimeType}
    await callbacks.sendManualMessage(contactId,message)
    sendJson(response,200,{message:'Mensaje enviado'});return true
  }
  if(request.method==='GET'&&action==='export'){
    const data=await exportContactData(contactId)
    if(!data){sendJson(response,404,{error:'Contacto no encontrado'});return true}
    response.writeHead(200,{'content-type':'application/json; charset=utf-8','content-disposition':`attachment; filename="contact-${contactId}-export.json"`,'cache-control':'no-store'})
    response.end(JSON.stringify(data,null,2));return true
  }
  if(request.method==='DELETE'&&!action){
    const deleted=await callbacks.deleteContact(contactId)
    sendJson(response,deleted?200:404,deleted?{message:'Datos del contacto eliminados'}:{error:'Contacto no encontrado'});return true
  }
  return false
}
