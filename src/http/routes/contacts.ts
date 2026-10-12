import { createManualContact, exportContactData, listContactMessages, listContacts, listInboxChats, setChatBotPaused, updateContactProfile } from '../../db'
import { UiCallbacks } from '../../ui/settings'
import { validateContactProfile } from '../../ui/validators'
import { ApiContext, readJson, sendJson } from '../shared'

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
    if (typeof body.phoneNumber!=='string') throw new Error('El teléfono internacional es obligatorio')
    const phoneNumber=body.phoneNumber.trim().replace(/^\+/, '')
    if (!/^\d{5,20}$/.test(phoneNumber)) throw new Error('Escribe solo los dígitos internacionales, sin transformaciones')
    sendJson(response,201,{contactId:await createManualContact(phoneNumber,validateContactProfile(body))});return true
  }
  const route=url.pathname.match(/^\/api\/contacts\/(\d+)(?:\/(messages|pause|export|profile))?$/)
  if(!route)return false
  const contactId=Number(route[1]),action=route[2]
  if(request.method==='GET'&&action==='messages'){sendJson(response,200,await listContactMessages(contactId));return true}
  if(request.method==='PATCH'&&action==='profile'){
    const updated=await updateContactProfile(contactId,validateContactProfile(await readJson(request)))
    sendJson(response,updated?200:404,updated?{message:'Contacto actualizado'}:{error:'Contacto no encontrado'});return true
  }
  if(request.method==='POST'&&action==='pause'){
    const body=await readJson(request);if(typeof body.paused!=='boolean')throw new Error('paused debe ser booleano')
    const updated=await setChatBotPaused(contactId,body.paused)
    sendJson(response,updated?200:404,updated?{botPaused:body.paused}:{error:'Contacto no encontrado'});return true
  }
  if(request.method==='POST'&&action==='messages'){
    const body=await readJson(request)
    if(typeof body.text!=='string'||!body.text.trim()||body.text.length>4000)throw new Error('El mensaje manual debe tener entre 1 y 4000 caracteres')
    await callbacks.sendManualMessage(contactId,body.text.trim())
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
