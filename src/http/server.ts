import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { AppSettings, UiCallbacks } from '../ui/settings'
import { config } from '../config'
import { handleApiRequest } from './api'
import { readJson, sendJson } from './shared'
import { DashboardAuth } from './auth'

const mimeTypes: Record<string,string> = {
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon',
}

function isLoopback(address: string | undefined): boolean {
  return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address ?? '')
}

function isTrustedDashboardRequest(request:IncomingMessage,port:number):boolean{
  const allowedHosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`])
  if(!allowedHosts.has(request.headers.host??''))return false
  if(!['POST','PUT','PATCH','DELETE'].includes(request.method??''))return true
  if(request.headers['sec-fetch-site']==='cross-site')return false
  const origin=request.headers.origin
  if(!origin)return true
  try{return allowedHosts.has(new URL(origin).host)&&new URL(origin).protocol==='http:'}catch{return false}
}

async function serveStatic(response: ServerResponse, pathname: string, root: string, headOnly: boolean): Promise<void> {
  let decoded: string
  try { decoded = decodeURIComponent(pathname) } catch { sendJson(response,400,{error:'Ruta inválida'});return }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const target = path.resolve(root, relative)
  if (target !== root && !target.startsWith(root + path.sep)) { sendJson(response,403,{error:'Ruta fuera del panel'});return }
  try {
    const content = await fs.readFile(target)
    response.writeHead(200,{
      'content-type':mimeTypes[path.extname(target).toLowerCase()]??'application/octet-stream',
      'cache-control':path.basename(target)==='index.html'?'no-cache':'public, max-age=300',
      'x-content-type-options':'nosniff',
      'content-security-policy':"default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    })
    response.end(headOnly?undefined:content)
  } catch { sendJson(response,404,{error:'Recurso no encontrado'}) }
}

export async function launchDashboardServer(fallback: AppSettings, callbacks: UiCallbacks, port = 3000): Promise<ReturnType<typeof createServer>> {
  const compiled = __dirname.split(path.sep).includes('dist')
  const staticRoot = compiled ? path.resolve(__dirname,'../../public') : path.resolve(process.cwd(),'web')
  const auth=new DashboardAuth(path.join(config.dataDir,'dashboard-auth.json'))
  await auth.initialize()
  const server = createServer(async (request,response) => {
    if (!isLoopback(request.socket.remoteAddress)) { sendJson(response,403,{error:'Acceso solo desde localhost'});return }
    if(!isTrustedDashboardRequest(request,port)){sendJson(response,403,{error:'Solicitud de otro origen rechazada'});return}
    const url = new URL(request.url??'/',`http://${request.headers.host??'127.0.0.1'}`)
    if(url.pathname.startsWith('/api/auth/')){
      try{
        if(url.pathname==='/api/auth/status'&&request.method==='GET'){sendJson(response,200,auth.status(request));return}
        if(url.pathname==='/api/auth/setup'&&request.method==='POST'){
          const body=await readJson(request)
          await auth.setup(body.username,body.password,response)
          sendJson(response,200,{configured:true,authenticated:true});return
        }
        if(url.pathname==='/api/auth/login'&&request.method==='POST'){
          const body=await readJson(request)
          await auth.login(body.username,body.password,request,response)
          sendJson(response,200,{authenticated:true});return
        }
        if(url.pathname==='/api/auth/logout'&&request.method==='POST'){
          await auth.logout(request,response);sendJson(response,200,{authenticated:false});return
        }
        sendJson(response,404,{error:'Ruta de acceso no encontrada'});return
      }catch(error:any){sendJson(response,400,{error:error.message||'No se pudo validar el acceso'});return}
    }
    const loggedIn=auth.authenticated(request)
    if(url.pathname.startsWith('/api/')){
      if(!loggedIn){sendJson(response,401,{error:'Inicia sesión para continuar.'});return}
      await handleApiRequest({request,response,url},fallback,callbacks);return
    }
    if(request.method==='GET'||request.method==='HEAD'){
      if(!loggedIn){
        const publicLoginAsset=url.pathname==='/assets/dashboard.css'||url.pathname==='/js/login.js'
        if(publicLoginAsset){await serveStatic(response,url.pathname,staticRoot,request.method==='HEAD');return}
        if(url.pathname==='/login'||url.pathname==='/login.html'||url.pathname==='/'){
          await serveStatic(response,'/login.html',staticRoot,request.method==='HEAD');return
        }
        response.writeHead(302,{location:'/','cache-control':'no-store'});response.end();return
      }
      if(url.pathname==='/login'||url.pathname==='/login.html'){response.writeHead(302,{location:'/','cache-control':'no-store'});response.end();return}
      await serveStatic(response,url.pathname,staticRoot,request.method==='HEAD');return
    }
    sendJson(response,405,{error:'Método no permitido'})
  })
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)})
  return server
}
