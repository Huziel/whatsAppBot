import { $ } from '../api.js'

const titles={dashboard:'Resumen',conversations:'Conversaciones',contacts:'Contactos',catalog:'Catálogo',sales:'Ventas',appointments:'Agenda',settings:'Configuración',ai:'Inteligencia artificial',privacy:'Privacidad'}

function setDrawer(open){const mobile=window.innerWidth<1024;const sidebar=$('sidebar');sidebar.classList.toggle('-translate-x-full',mobile&&!open);sidebar.inert=mobile&&!open;sidebar.setAttribute('aria-hidden',String(mobile&&!open));$('sidebarBackdrop').classList.toggle('hidden',!mobile||!open);$('mobileMenu').setAttribute('aria-expanded',String(mobile&&open));if(open&&mobile)sidebar.querySelector('a[data-route]')?.focus();else if(mobile)$('mobileMenu').focus()}
function closeDrawer(){setDrawer(false)}

export function navigate(route){
  const current=titles[route]?route:'dashboard'
  document.querySelectorAll('[data-view]').forEach(view=>view.classList.toggle('hidden',view.dataset.view!==current))
  document.querySelectorAll('[data-route]').forEach(link=>{if(link.dataset.route===current)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current')})
  $('pageTitle').textContent=titles[current]
  closeDrawer()
}

export function initializeNavigation(){
  document.querySelectorAll('[data-route]').forEach(link=>link.addEventListener('click',event=>{event.preventDefault();const route=link.dataset.route;history.replaceState(null,'','#'+route);navigate(route)}))
  setDrawer(false)
  $('mobileMenu').addEventListener('click',()=>setDrawer($('sidebar').classList.contains('-translate-x-full')))
  $('sidebarBackdrop').addEventListener('click',closeDrawer)
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closeDrawer()})
  window.addEventListener('resize',closeDrawer)
  window.addEventListener('hashchange',()=>navigate(location.hash.slice(1)))
  navigate(location.hash.slice(1)||'dashboard')
}
