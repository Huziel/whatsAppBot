const $=id=>document.getElementById(id)
let catalog={items:[],businessName:'Menú del negocio',productCatalogImageUrl:null,serviceCatalogImageUrl:null}
let category='all',search='',cart=new Map(),checkoutLocked=false
const attemptStorageKey='wa-public-checkout-attempt-v1',draftStorageKey='wa-public-checkout-draft-v1'
const memoryStorage=new Map()
const sessionStorageAvailable=(()=>{try{const key='wa-storage-check';sessionStorage.setItem(key,'1');sessionStorage.removeItem(key);return true}catch{return false}})()

function base64Url(bytes){let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function newOrderKey(){if(crypto.randomUUID)return crypto.randomUUID();const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`}
function newAttempt(){return {orderKey:newOrderKey(),accessToken:base64Url(crypto.getRandomValues(new Uint8Array(32)))}}
function readStorage(key){try{const value=sessionStorage.getItem(key);if(value!==null)return JSON.parse(value)}catch{}return memoryStorage.get(key)??null}
function writeStorage(key,value){memoryStorage.set(key,value);try{sessionStorage.setItem(key,JSON.stringify(value))}catch{}}
function removeStorage(key){memoryStorage.delete(key);try{sessionStorage.removeItem(key)}catch{}}
function currentAttempt(){const stored=readStorage(attemptStorageKey);if(stored&&typeof stored.orderKey==='string'&&typeof stored.accessToken==='string')return stored;const attempt=newAttempt();writeStorage(attemptStorageKey,attempt);return attempt}

async function api(path,body){
  let response;const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20_000)
  try{response=await fetch(path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,credentials:'same-origin',cache:'no-store',signal:controller.signal})}
  catch(error){const network=new Error(error.name==='AbortError'?'El servidor tardó demasiado. Inténtalo nuevamente.':'No se pudo conectar con el servidor. Revisa tu conexión e inténtalo nuevamente.');network.kind='network';throw network}
  finally{clearTimeout(timeout)}
  const result=await response.json().catch(()=>null)
  if(!response.ok){const failure=new Error(result?.error?.message||'No se pudo completar la solicitud.');failure.status=response.status;failure.code=result?.error?.code;failure.requestId=result?.error?.requestId;failure.retryAfter=Number(response.headers.get('retry-after'))||null;throw failure}
  return result
}

async function loadCatalog(){
  let first=null,cursor=null
  const items=[]
  do{
    const page=await api(`/api/public/menu${cursor===null?'':`?after=${encodeURIComponent(cursor)}`}`)
    first??=page;items.push(...page.items);cursor=page.nextCursor
  }while(cursor!==null)
  items.sort((left,right)=>left.itemType.localeCompare(right.itemType)||left.name.localeCompare(right.name,'es'))
  return {...first,items}
}

async function initialize(){
  $('menuSearch').addEventListener('input',event=>{search=event.target.value.trim().toLocaleLowerCase('es');renderMenu()})
  document.querySelectorAll('.menu-filter').forEach(button=>button.addEventListener('click',()=>{category=button.dataset.category;document.querySelectorAll('.menu-filter').forEach(item=>item.classList.toggle('active',item===button));renderMenu()}))
  $('checkoutForm').addEventListener('submit',submitOrder)
  $('customerName').addEventListener('input',saveDraft);$('phoneNumber').addEventListener('input',saveDraft)
  try{
    catalog=await loadCatalog()
    $('menuBusinessName').textContent=catalog.businessName||'Menú del negocio'
    document.title=`Menú — ${catalog.businessName||'Negocio'}`
    $('menuNotice').textContent=catalog.items.length?'':'Todavía no hay productos o servicios disponibles.'
    restoreDraft();renderMenu();renderCart()
    if(!sessionStorageAvailable){$('checkoutNotice').textContent='Habilita el almacenamiento de sesión del navegador para enviar pedidos de forma segura.';$('checkoutNotice').classList.remove('hidden')}
    else void resumeCheckout()
  }catch(error){$('menuNotice').textContent=error.message}
}

function restoreDraft(){
  const draft=readStorage(draftStorageKey)
  if(!draft)return
  $('customerName').value=typeof draft.customerName==='string'?draft.customerName:'';$('phoneNumber').value=typeof draft.phoneNumber==='string'?draft.phoneNumber:''
  const submitted=readStorage(attemptStorageKey)?.submittedPayload
  if(Array.isArray(draft.items))for(const saved of draft.items){const item=catalog.items.find(candidate=>candidate.sku===saved.sku);if(!item)continue;const maximum=submitted?100:item.itemType==='product'&&item.stockQuantity!==null?Number(item.stockQuantity):100;const quantity=Math.min(maximum,Number(saved.quantity));if(Number.isInteger(quantity)&&quantity>0)cart.set(item.sku,{item,quantity})}
}

function saveDraft(){writeStorage(draftStorageKey,{customerName:$('customerName').value,phoneNumber:$('phoneNumber').value,items:[...cart.values()].map(line=>({sku:line.item.sku,quantity:line.quantity}))})}

function formatPrice(item){return item.price===null?'Precio por confirmar':`${Number(item.price).toFixed(2)} ${item.currency}`}
function available(item){return item.itemType==='service'||item.stockQuantity===null||Number(item.stockQuantity)>0}
function quantityInCart(sku){return cart.get(sku)?.quantity??0}

function renderMenu(){
  const items=catalog.items.filter(item=>(category==='all'||item.itemType===category)&&(!search||`${item.name} ${item.description||''} ${item.sku}`.toLocaleLowerCase('es').includes(search)))
  const root=$('menuItems');root.replaceChildren()
  for(const item of items){
    const card=document.createElement('article');card.className='menu-item-card'
    const imageBox=document.createElement('div');imageBox.className='menu-item-image'
    const imageUrl=item.imageUrl||(item.itemType==='service'?catalog.serviceCatalogImageUrl:catalog.productCatalogImageUrl)
    if(imageUrl){const image=document.createElement('img');image.src=imageUrl;image.alt=item.name;image.loading='lazy';image.referrerPolicy='no-referrer';image.onerror=()=>{image.remove();imageBox.classList.add('no-image')};imageBox.appendChild(image)}else imageBox.classList.add('no-image')
    const type=document.createElement('span');type.className='menu-item-type';type.textContent=item.itemType==='service'?'Servicio':'Producto';imageBox.appendChild(type);card.appendChild(imageBox)
    const detail=document.createElement('div');detail.className='menu-item-detail'
    const name=document.createElement('h3');name.textContent=item.name;detail.appendChild(name)
    if(item.description){const description=document.createElement('p');description.textContent=item.description;detail.appendChild(description)}
    const footer=document.createElement('div');footer.className='menu-item-footer'
    const price=document.createElement('strong');price.className='menu-item-price';price.textContent=formatPrice(item);footer.appendChild(price)
    const button=document.createElement('button');button.type='button';button.className='menu-add-button';button.textContent=available(item)?(quantityInCart(item.sku)?`Agregar · ${quantityInCart(item.sku)}`:'Agregar'):'Agotado';button.disabled=!available(item)||checkoutLocked;button.onclick=()=>addToCart(item);footer.appendChild(button)
    detail.appendChild(footer);card.appendChild(detail);root.appendChild(card)
  }
  if(!items.length&&catalog.items.length)$('menuNotice').textContent='No encontramos artículos con esa búsqueda.'
  else if(items.length)$('menuNotice').textContent=''
}

function addToCart(item){
  if(!available(item)||checkoutLocked)return
  const current=quantityInCart(item.sku),max=item.itemType==='product'&&item.stockQuantity!==null?Number(item.stockQuantity):100
  if(current>=max){$('menuNotice').textContent=`No hay más existencias disponibles de ${item.name}.`;return}
  cart.set(item.sku,{item,quantity:current+1});saveDraft();renderCart();renderMenu()
}

function changeQuantity(sku,delta){
  if(checkoutLocked)return
  const line=cart.get(sku);if(!line)return
  const maximum=line.item.itemType==='product'&&line.item.stockQuantity!==null?Number(line.item.stockQuantity):100
  const quantity=Math.min(maximum,line.quantity+delta)
  if(quantity<1)cart.delete(sku);else cart.set(sku,{...line,quantity});saveDraft()
  renderCart();renderMenu()
}

function renderCart(){
  const root=$('cartItems');root.replaceChildren()
  const lines=[...cart.values()]
  $('cartEmpty').classList.toggle('hidden',lines.length>0)
  $('cartCount').textContent=String(lines.reduce((total,line)=>total+line.quantity,0))
  $('submitOrder').disabled=lines.length===0||!sessionStorageAvailable
  $('cartTotalRow').classList.toggle('hidden',lines.length===0)
  $('quoteNote').classList.add('hidden')
  let total=0,currency=null,calculable=lines.length>0
  for(const line of lines){
    const row=document.createElement('article');row.className='menu-cart-line'
    const description=document.createElement('div');description.className='menu-cart-line-info'
    const name=document.createElement('strong');name.textContent=line.item.name;description.appendChild(name)
    const unitPrice=document.createElement('small');unitPrice.textContent=line.item.price===null?'A cotizar':`${line.item.price} ${line.item.currency} c/u`;description.appendChild(unitPrice)
    const controls=document.createElement('div');controls.className='menu-quantity-control'
    const decrease=document.createElement('button');decrease.type='button';decrease.textContent='−';decrease.setAttribute('aria-label',`Quitar una unidad de ${line.item.name}`);decrease.onclick=()=>changeQuantity(line.item.sku,-1)
    const quantity=document.createElement('span');quantity.textContent=String(line.quantity)
    const increase=document.createElement('button');increase.type='button';increase.textContent='+';increase.setAttribute('aria-label',`Agregar una unidad de ${line.item.name}`);increase.onclick=()=>changeQuantity(line.item.sku,1)
    decrease.disabled=checkoutLocked;increase.disabled=checkoutLocked;controls.append(decrease,quantity,increase);row.append(description,controls);root.appendChild(row)
    if(line.item.price===null)calculable=false
    else{total+=Number(line.item.price)*line.quantity;if(currency&&currency!==line.item.currency)calculable=false;currency??=line.item.currency}
  }
  if(calculable){$('cartTotal').textContent=`${total.toFixed(2)} ${currency}`}
  else if(lines.length){$('cartTotal').textContent='Por confirmar';$('quoteNote').classList.remove('hidden')}
}

async function submitOrder(event){
  event.preventDefault()
  if(!sessionStorageAvailable)return
  const items=[...cart.values()].map(line=>({sku:line.item.sku,quantity:line.quantity}))
  const attempt=currentAttempt()
  if(!attempt.submittedPayload){if(!items.length)return;saveDraft();attempt.submittedPayload={customerName:$('customerName').value.trim(),phoneNumber:$('phoneNumber').value.trim(),website:$('website').value,items};writeStorage(attemptStorageKey,attempt)}
  setCheckoutLocked(true)
  await performCheckout(attempt)
}

async function resumeCheckout(){const attempt=readStorage(attemptStorageKey);if(attempt?.submittedPayload){setCheckoutLocked(true);await performCheckout(attempt)}}

function setCheckoutLocked(locked){checkoutLocked=locked;$('customerName').disabled=locked;$('phoneNumber').disabled=locked;renderMenu();renderCart()}

async function performCheckout(attempt){
  const button=$('submitOrder');button.disabled=true;button.textContent='Enviando pedido…';$('checkoutNotice').classList.add('hidden');$('checkoutNotice').textContent=''
  try{
    const result=await api('/api/public/orders',{orderKey:attempt.orderKey,accessToken:attempt.accessToken,...attempt.submittedPayload})
    cart.clear();renderCart();$('checkoutForm').classList.add('hidden')
    const confirmation=$('orderConfirmation');confirmation.classList.remove('hidden');confirmation.innerHTML=''
    const title=document.createElement('strong');title.textContent='¡Pedido reservado!';const reference=document.createElement('p');reference.textContent=`Folio: ${result.publicId}. Te contactaremos por WhatsApp para confirmar${result.total===null?' el total':` el total de ${Number(result.total).toFixed(2)} ${result.currency}`}.`
    const link=document.createElement('a');link.className='menu-submit';link.href=`${result.statusPath}#token=${attempt.accessToken}`;link.textContent='Consultar estado del pedido'
    confirmation.append(title,reference,link);$('menuNotice').textContent='';$('checkoutNotice').classList.add('hidden');writeStorage(`wa-public-order:${result.publicId}`,attempt.accessToken);removeStorage(attemptStorageKey);removeStorage(draftStorageKey)
  }catch(error){
    let message=error.message
    if(error.status===409)message='El pedido no pudo reservarse con el estado actual del inventario. Revisa las cantidades y vuelve a intentarlo.'
    if(error.status===429)message=`Se alcanzó el límite temporal de pedidos. Espera${error.retryAfter?` ${error.retryAfter} segundos`:''} antes de verificar el mismo intento.`
    const definitive=[400,409].includes(error.status)&&error.code!=='IDEMPOTENCY_KEY_REUSED'
    if(definitive){delete attempt.submittedPayload;writeStorage(attemptStorageKey,attempt);setCheckoutLocked(false)}
    else{setCheckoutLocked(true);if(!message.endsWith('.'))message+='.';message+=' Se conservaron los datos originales para verificar el mismo intento sin duplicarlo.'}
    $('checkoutNotice').textContent=error.requestId?`${message} Referencia: ${error.requestId}`:message;$('checkoutNotice').classList.remove('hidden');button.disabled=false;button.textContent=definitive?'Enviar pedido':'Verificar pedido'
  }
}

void initialize()
