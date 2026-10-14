export async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if(response.status===401){location.replace('/');throw new Error('La sesión expiró. Inicia sesión nuevamente.')}
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error || `Solicitud fallida (${response.status})`)
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
