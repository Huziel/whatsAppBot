const $=id=>document.getElementById(id)
let configured=false

async function request(path,body){
  const response=await fetch(path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,credentials:'same-origin',signal:AbortSignal.timeout(20_000),cache:'no-store'})
  const payload=await response.json()
  if(!response.ok)throw new Error(payload.error||'No se pudo completar el acceso.')
  return payload
}

async function initialize(){
  try{
    const status=await request('/api/auth/status')
    configured=status.configured
    if(status.authenticated){location.replace('/');return}
    if(!configured){
      $('loginTitle').textContent='Crear acceso al dashboard'
      $('loginDescription').textContent='Crea el usuario y una contraseña segura para proteger el panel.'
      $('passwordLabel').textContent='Contraseña nueva (mínimo 12 caracteres)'
      $('password').autocomplete='new-password'
      $('confirmWrap').classList.remove('hidden')
      $('loginSubmit').textContent='Crear acceso e ingresar'
    }
  }catch(error){showError(error.name==='TimeoutError'?'El servidor tardó demasiado. Comprueba que la aplicación siga abierta e inténtalo de nuevo.':error.message)}
}

function showError(message){$('loginError').textContent=message;$('loginError').classList.remove('hidden')}

$('loginForm').addEventListener('submit',async event=>{
  event.preventDefault();$('loginError').classList.add('hidden')
  const username=$('username').value,password=$('password').value
  if(!configured&&password!==$('confirmPassword').value){showError('Las contraseñas no coinciden.');return}
  const submit=$('loginSubmit'),originalText=submit.textContent;submit.disabled=true;submit.textContent=configured?'Validando acceso…':'Creando acceso…'
  try{
    await request(configured?'/api/auth/login':'/api/auth/setup',{username,password})
    const session=await request('/api/auth/status')
    if(!session.authenticated)throw new Error('El acceso se validó, pero el navegador no conservó la sesión. Habilita cookies para 127.0.0.1 y vuelve a intentar.')
    submit.textContent='Abriendo dashboard…'
    location.replace('/')
  }
  catch(error){showError(error.name==='TimeoutError'?'El servidor tardó demasiado. Comprueba que la aplicación siga abierta e inténtalo de nuevo.':error.message);submit.disabled=false;submit.textContent=originalText}
})

void initialize()
