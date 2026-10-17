import { createInventoryItem, deleteInventoryItem, listInventoryItems, updateInventoryItem } from '../../db'
import { validateInventoryItem } from '../../ui/validators'
import { ApiContext, readJson, sendJson } from '../shared'
import { ValidationError } from '../../errors'

function validate(input:any){try{return validateInventoryItem(input)}catch(error:any){throw new ValidationError(error?.message||'Artículo no válido.','INVALID_INVENTORY_ITEM')}}

export async function handleInventoryRoute({ request, response, url }: ApiContext): Promise<boolean> {
  if (request.method === 'GET' && url.pathname === '/api/inventory') {
    sendJson(response,200,await listInventoryItems());return true
  }
  if (request.method === 'POST' && url.pathname === '/api/inventory') {
    sendJson(response,201,await createInventoryItem(validate(await readJson(request))));return true
  }
  const match=url.pathname.match(/^\/api\/inventory\/(\d+)$/)
  if(!match)return false
  const id=Number(match[1])
  if(request.method==='PUT'){
    const item=await updateInventoryItem(id,validate(await readJson(request)))
    sendJson(response,item?200:404,item??{error:'Artículo no encontrado'});return true
  }
  if(request.method==='DELETE'){
    const deleted=await deleteInventoryItem(id)
    sendJson(response,deleted?200:404,deleted?{message:'Artículo eliminado'}:{error:'Artículo no encontrado'});return true
  }
  return false
}
