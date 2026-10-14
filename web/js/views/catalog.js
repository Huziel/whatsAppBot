import { $, api } from '../api.js'

export function initializeCatalog(){
  $('itemType').value='product'
  $('itemType').closest('div').classList.add('hidden')
  $('itemFormTitle').textContent='Agregar producto'
  $('itemSubmit').textContent='Guardar producto'
  $('itemForm').onsubmit=saveProduct
  $('itemCancel').onclick=resetProductForm
  $('itemType').onchange=()=>{const service=$('itemType').value==='service';$('itemStock').disabled=service;if(service)$('itemStock').value=''}
  $('serviceForm').onsubmit=saveService
  $('serviceCancel').onclick=resetServiceForm
  $('serviceImageUrl').oninput=updateServicePreview
  void loadInventory()
}

async function loadInventory(){
  try{
    const items=await api('/api/inventory')
    const body=$('inventoryRows');body.replaceChildren()
    for(const item of items){
      const row=document.createElement('tr')
      const image=cell(row,'')
      if(item.imageUrl){
        const img=document.createElement('img');img.src=item.imageUrl;img.className='h-12 w-12 rounded-lg object-cover';img.alt='Imagen de '+item.name;img.loading='lazy';img.referrerPolicy='no-referrer';img.onerror=()=>{img.hidden=true};image.appendChild(img)
      }else image.textContent='—'
      cell(row,item.itemType==='product'?'Producto':'Servicio');cell(row,item.sku);cell(row,item.name);cell(row,item.price===null?'A cotizar':item.price+' '+item.currency);cell(row,item.itemType==='service'?'—':item.stockQuantity===null?'Sin control':String(item.stockQuantity));cell(row,item.isActive?'Activo':'Inactivo')
      const action=cell(row,'');action.className='whitespace-nowrap'
      const edit=document.createElement('button');edit.className='btn';edit.textContent='Editar';edit.onclick=()=>editItem(item)
      const remove=document.createElement('button');remove.className='btn-danger ml-1';remove.textContent='Eliminar';remove.onclick=()=>deleteItem(item)
      action.append(edit,remove);body.appendChild(row)
    }
    const products=items.filter(item=>item.itemType==='product').length
    const services=items.filter(item=>item.itemType==='service').length
    $('inventoryNotice').textContent=items.length?`${products} productos · ${services} servicios`:'Catálogo vacío.'
  }catch(error){$('inventoryNotice').textContent='No se pudo cargar el catálogo: '+error.message}
}

function cell(row,value){const td=document.createElement('td');td.textContent=value??'';row.appendChild(td);return td}

function editItem(item){
  if(item.itemType==='service'){editService(item);return}
  $('itemId').value=item.id;$('itemType').value='product';$('itemSku').value=item.sku;$('itemName').value=item.name;$('itemDescription').value=item.description||'';$('itemImageUrl').value=item.imageUrl||'';$('itemPrice').value=item.price??'';$('itemCurrency').value=item.currency;$('itemStock').value=item.stockQuantity??'';$('itemActive').checked=item.isActive
  $('itemFormTitle').textContent='Editar producto';$('itemSubmit').textContent='Guardar cambios';$('itemCancel').classList.remove('hidden');$('itemType').dispatchEvent(new Event('change'));$('itemFormTitle').scrollIntoView({behavior:'smooth'})
}

function editService(item){
  $('serviceId').value=item.id;$('serviceSku').value=item.sku;$('serviceName').value=item.name;$('serviceDescription').value=item.description||'';$('serviceImageUrl').value=item.imageUrl||'';$('servicePrice').value=item.price??'';$('serviceCurrency').value=item.currency;$('serviceActive').checked=item.isActive
  $('serviceFormTitle').textContent='Editar servicio';$('serviceSubmit').textContent='Guardar cambios';$('serviceCancel').classList.remove('hidden');$('serviceNotice').textContent=`Editando ${item.name}`;updateServicePreview();$('serviceFormCard').scrollIntoView({behavior:'smooth'})
}

function resetProductForm(){$('itemForm').reset();$('itemId').value='';$('itemType').value='product';$('itemCurrency').value='MXN';$('itemActive').checked=true;$('itemFormTitle').textContent='Agregar producto';$('itemSubmit').textContent='Guardar producto';$('itemCancel').classList.add('hidden');$('itemType').dispatchEvent(new Event('change'))}

function resetServiceForm(){$('serviceForm').reset();$('serviceId').value='';$('serviceCurrency').value='MXN';$('serviceActive').checked=true;$('serviceFormTitle').textContent='Dar de alta servicio';$('serviceSubmit').textContent='Guardar servicio';$('serviceCancel').classList.add('hidden');$('serviceNotice').textContent='';updateServicePreview()}

function updateServicePreview(){
  const url=$('serviceImageUrl').value.trim(),preview=$('serviceImagePreview'),placeholder=$('serviceImagePlaceholder')
  if(!url){preview.classList.add('hidden');preview.removeAttribute('src');placeholder.classList.remove('hidden');return}
  preview.src=url;preview.classList.remove('hidden');placeholder.classList.add('hidden')
  preview.onerror=()=>{preview.classList.add('hidden');placeholder.classList.remove('hidden');placeholder.textContent='No se pudo cargar la imagen'}
  preview.onload=()=>{preview.classList.remove('hidden');placeholder.classList.add('hidden');placeholder.textContent='Vista previa de imagen'}
}

async function saveProduct(event){
  event.preventDefault();if(!$('itemForm').reportValidity())return
  const id=$('itemId').value
  const body={itemType:'product',sku:$('itemSku').value,name:$('itemName').value,description:$('itemDescription').value,imageUrl:$('itemImageUrl').value,price:$('itemPrice').value===''?null:Number($('itemPrice').value),currency:$('itemCurrency').value,stockQuantity:$('itemStock').value===''?null:Number($('itemStock').value),isActive:$('itemActive').checked}
  try{await api(id?'/api/inventory/'+id:'/api/inventory',id?'PUT':'POST',body);resetProductForm();await loadInventory()}catch(error){$('inventoryNotice').textContent=error.message}
}

async function saveService(event){
  event.preventDefault();if(!$('serviceForm').reportValidity())return
  const id=$('serviceId').value
  const body={itemType:'service',sku:$('serviceSku').value,name:$('serviceName').value,description:$('serviceDescription').value,imageUrl:$('serviceImageUrl').value,price:$('servicePrice').value===''?null:Number($('servicePrice').value),currency:$('serviceCurrency').value,stockQuantity:null,isActive:$('serviceActive').checked}
  try{await api(id?'/api/inventory/'+id:'/api/inventory',id?'PUT':'POST',body);resetServiceForm();$('serviceNotice').textContent=id?'Servicio actualizado.':'Servicio agregado al catálogo.';await loadInventory()}catch(error){$('serviceNotice').textContent=error.message}
}

async function deleteItem(item){if(!confirm(`¿Eliminar ${item.name} (${item.sku})?`))return;try{await api('/api/inventory/'+item.id,'DELETE');if(item.itemType==='service'&&String(item.id)===$('serviceId').value)resetServiceForm();if(item.itemType==='product'&&String(item.id)===$('itemId').value)resetProductForm();await loadInventory()}catch(error){$('inventoryNotice').textContent=error.message}}
