import { setNotice } from './api.js'
import { initializeNavigation } from './views/navigation.js'
import { initializeDashboard, refreshDashboard } from './views/dashboard.js'
import { initializeService } from './views/service.js'
import { initializeSettings, loadSettings } from './views/settings.js'
import { initializeConversations } from './views/conversations.js'
import { initializeContacts } from './views/contacts.js'
import { initializeCatalog } from './views/catalog.js'
import { initializeSales } from './views/sales.js'
import { initializeAppointments } from './views/appointments.js'

async function boot(){
  try{await loadSettings()}catch(error){setNotice('globalNotice','No se pudo cargar la configuración: '+error.message,'error')}
  initializeNavigation()
  initializeDashboard()
  initializeSettings()
  initializeService()
  initializeConversations()
  initializeContacts()
  initializeCatalog()
  initializeSales()
  initializeAppointments()
  void refreshDashboard()
}

void boot()
