import { setNotice } from './api.js'
import { initializeNavigation } from './views/navigation.js'
import { initializeDashboard, refreshDashboard } from './views/dashboard.js'
import { initializeService } from './views/service.js'
import { initializeSettings, loadSettings } from './views/settings.js?v=dialogs-1'
import { initializeConversations } from './views/conversations.js?v=dialogs-1'
import { initializeContacts } from './views/contacts.js?v=dialogs-1'
import { initializeCatalog } from './views/catalog.js?v=dialogs-1'
import { initializeSales } from './views/sales.js?v=dialogs-1'
import { initializeAppointments } from './views/appointments.js?v=dialogs-1'
import { confirmAction } from './ui/dialogs.js'

document.getElementById('logoutDashboard').addEventListener('click',async()=>{
  if(!await confirmAction({title:'Cerrar sesión del panel',message:'Tendrás que volver a iniciar sesión para abrir el centro de control.',confirmText:'Cerrar sesión',danger:true}))return
  try{await fetch('/api/auth/logout',{method:'POST',headers:{'content-type':'application/json'},body:'{}',credentials:'same-origin'})}
  finally{location.replace('/')}
})

async function boot(){
  initializeSales()
  try{await loadSettings()}catch(error){setNotice('globalNotice','No se pudo cargar la configuración: '+error.message,'error')}
  initializeNavigation()
  initializeDashboard()
  initializeSettings()
  initializeService()
  initializeConversations()
  initializeContacts()
  initializeCatalog()
  initializeAppointments()
  void refreshDashboard()
}

void boot()
