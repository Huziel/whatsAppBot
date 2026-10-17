let sessionStatusCheck

async function isDashboardSessionActive(){
  if(!sessionStatusCheck){
    sessionStatusCheck=fetch('/api/auth/status',{credentials:'same-origin',cache:'no-store'})
      .then(response=>response.ok?response.json():null)
      .then(status=>Boolean(status?.authenticated))
      .catch(()=>false)
      .finally(()=>{sessionStatusCheck=undefined})
  }
  return sessionStatusCheck
}

export async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if(response.status===401){
    const authenticated=await isDashboardSessionActive()
    if(!authenticated&&!['/login','/login.html'].includes(location.pathname))location.replace('/login.html?expired=1')
    throw new Error(authenticated?'La solicitud fue rechazada como no autenticada, pero la sesión del panel sigue activa. Recarga la página.':'La sesión expiró. Inicia sesión nuevamente.')
  }
  const payload = await response.json()
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Solicitud fallida (${response.status})`)
  return payload
}

export const $ = id => document.getElementById(id)

export function setNotice(elementId, message, kind = 'info') {
  const element = $(elementId)
  element.textContent = message
  element.dataset.kind = kind
  element.classList.remove('hidden')
}

export function setCell(row, value) {
  const cell = document.createElement('td')
  cell.textContent = value ?? ''
  row.appendChild(cell)
  return cell
}
