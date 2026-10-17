const $=id=>document.getElementById(id)
const labels={pending:'Pendiente de confirmación',confirmed:'Confirmado',preparing:'En preparación',ready:'Listo',out_for_delivery:'En camino',completed:'Completado',cancelled:'Cancelado',expired:'Reserva expirada'}
const paymentLabels={unpaid:'Pago pendiente',pending:'Pago en revisión',paid:'Pagado',failed:'Pago fallido',refunded:'Reembolsado'}

async function initialize(){
  const segments=location.pathname.split('/').filter(Boolean),publicId=segments[segments.length-1]||''
  const storageKey=`wa-public-order:${publicId}`
  const fragment=new URLSearchParams(location.hash.slice(1)).get('token')||location.hash.slice(1)
  let fragmentStored=false
  if(fragment)try{sessionStorage.setItem(storageKey,fragment);fragmentStored=true}catch{}
  const token=fragment||safeStored(storageKey)
  if(location.hash&&fragmentStored)history.replaceState(null,'',location.pathname)
  if(!/^[A-Za-z0-9_-]{43}$/.test(token||'')){showError('Este enlace no contiene la clave segura necesaria para consultar el pedido.');return}
  try{
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15_000)
    let response
    try{response=await fetch(`/api/public/orders/${encodeURIComponent(publicId)}`,{headers:{authorization:`Bearer ${token}`},cache:'no-store',signal:controller.signal})}finally{clearTimeout(timeout)}
    const payload=await response.json().catch(()=>null)
    if(!response.ok)throw new Error(payload?.error?.message||'No se encontró el pedido o el enlace ya no es válido.')
    render(payload)
  }catch(error){showError(error.name==='AbortError'||error instanceof TypeError?'No se pudo conectar con el servidor. Inténtalo nuevamente.':error.message)}
}

function safeStored(key){try{return sessionStorage.getItem(key)}catch{return null}}
function showError(message){$('orderFolio').textContent='No se pudo consultar';$('orderStatusText').textContent='Verifica que abriste el enlace completo.';$('orderStatusNotice').textContent=message}
function render(order){
  $('orderFolio').textContent=order.publicId;$('orderStatusText').textContent=labels[order.status]||order.status;$('orderStatus').textContent=labels[order.status]||order.status;$('orderStatusNotice').textContent='';$('orderDetail').classList.remove('hidden')
  const root=$('orderItems');root.replaceChildren()
  for(const item of order.items){const row=document.createElement('article');row.className='menu-cart-line';const info=document.createElement('div');info.className='menu-cart-line-info';const name=document.createElement('strong');name.textContent=`${item.quantity} × ${item.itemName}`;const price=document.createElement('small');price.textContent=item.unitPrice===null?'Precio por confirmar':`${item.unitPrice} ${item.currency} c/u`;info.append(name,price);row.append(info);root.append(row)}
  $('orderTotal').textContent=order.total===null?'Por confirmar':`${Number(order.total).toFixed(2)} ${order.currency}`
  $('orderPayment').textContent=paymentLabels[order.paymentStatus]||order.paymentStatus
  $('orderExpiry').textContent=order.status==='pending'&&order.expiresAt?`Reserva vigente hasta ${new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short'}).format(new Date(order.expiresAt))}.`:'El negocio actualizará aquí el progreso del pedido.'
}

void initialize()
