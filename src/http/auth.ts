import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { IncomingMessage, ServerResponse } from 'node:http'

const scrypt=promisify(scryptCallback)
const COOKIE_NAME='wa_dashboard_session'
const SESSION_MS=12*60*60*1000
const PASSWORD_BYTES=64

interface CredentialRecord { username:string; salt:string; hash:string; sessionSecret?:string }
interface Failures { count:number; blockedUntil:number }

export interface AuthStatus { configured:boolean; authenticated:boolean; username?:string }

export class DashboardAuth {
  private record:CredentialRecord|null=null
  private readonly failures=new Map<string,Failures>()

  constructor(private readonly filePath:string,private readonly now:()=>number=Date.now){}

  async initialize():Promise<void>{
    try{
      const parsed=JSON.parse(await readFile(this.filePath,'utf8')) as CredentialRecord
      if(typeof parsed.username==='string'&&typeof parsed.salt==='string'&&typeof parsed.hash==='string'){
        this.record=parsed.sessionSecret?parsed:{...parsed,sessionSecret:randomBytes(32).toString('hex')}
        if(!parsed.sessionSecret)await this.saveRecord(this.record)
      }
    }catch(error:any){if(error?.code!=='ENOENT')throw error}
  }

  status(request:IncomingMessage):AuthStatus{
    const session=this.sessionFor(request)
    return {configured:!!this.record,authenticated:!!session,...session&&this.record?{username:this.record.username}:{}}
  }

  authenticated(request:IncomingMessage):boolean{return !!this.sessionFor(request)}

  async setup(username:string,password:string,response:ServerResponse):Promise<void>{
    if(this.record)throw new Error('El acceso ya está configurado. Inicia sesión.')
    const normalized=validateCredentials(username,password)
    const salt=randomBytes(16)
    const hash=await scrypt(normalized.password,salt,PASSWORD_BYTES) as Buffer
    const record={username:normalized.username,salt:salt.toString('hex'),hash:hash.toString('hex'),sessionSecret:randomBytes(32).toString('hex')}
    await this.saveRecord(record)
    this.record=record
    this.createSession(response)
  }

  async login(username:string,password:string,request:IncomingMessage,response:ServerResponse):Promise<void>{
    const key=request.socket.remoteAddress??'loopback'
    const failures=this.failures.get(key)
    if(failures&&failures.blockedUntil>this.now())throw new Error('Demasiados intentos. Espera un minuto y vuelve a intentar.')
    if(!this.record)throw new Error('El acceso todavía no está configurado. Recarga la página.')
    const inputUsername=String(username??'').trim().toLocaleLowerCase('es')
    const inputPassword=String(password??'')
    const candidate=await scrypt(inputPassword,Buffer.from(this.record.salt,'hex'),PASSWORD_BYTES) as Buffer
    const expected=Buffer.from(this.record.hash,'hex')
    const usernameMatches=inputUsername===this.record.username.toLocaleLowerCase('es')
    const passwordMatches=candidate.length===expected.length&&timingSafeEqual(candidate,expected)
    if(!usernameMatches||!passwordMatches){
      const count=(failures?.count??0)+1
      this.failures.set(key,{count,blockedUntil:count>=5?this.now()+60_000:0})
      throw new Error(count>=5?'Demasiados intentos. Espera un minuto y vuelve a intentar.':'Usuario o contraseña incorrectos.')
    }
    this.failures.delete(key)
    this.createSession(response)
  }

  async logout(_request:IncomingMessage,response:ServerResponse):Promise<void>{
    if(this.record){this.record={...this.record,sessionSecret:randomBytes(32).toString('hex')};await this.saveRecord(this.record)}
    response.setHeader('Set-Cookie',`${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
  }

  private sessionFor(request:IncomingMessage):{expiresAt:number}|null{
    const token=this.cookieToken(request)
    if(!token||!this.record?.sessionSecret)return null
    const [expiresValue,nonce,signature]=token.split('.')
    const expiresAt=Number(expiresValue)
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=this.now()||!nonce||!/^[a-f0-9]{32}$/.test(nonce)||!signature)return null
    const expected=this.signSession(expiresValue,nonce)
    const expectedBuffer=Buffer.from(expected,'hex'),actualBuffer=Buffer.from(signature,'hex')
    if(expectedBuffer.length!==actualBuffer.length||!timingSafeEqual(expectedBuffer,actualBuffer))return null
    return {expiresAt}
  }

  private cookieToken(request:IncomingMessage):string|null{
    const cookies=request.headers.cookie?.split(';')??[]
    const value=cookies.map(cookie=>cookie.trim()).find(cookie=>cookie.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length+1)
    return value&&/^\d+\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(value)?value:null
  }

  private createSession(response:ServerResponse):void{
    const expiresAt=this.now()+SESSION_MS
    const expires=String(expiresAt),nonce=randomBytes(16).toString('hex'),token=`${expires}.${nonce}.${this.signSession(expires,nonce)}`
    response.setHeader('Set-Cookie',`${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS/1000)}`)
  }

  private signSession(expires:string,nonce:string):string{return createHmac('sha256',Buffer.from(this.record!.sessionSecret!,'hex')).update(`${expires}.${nonce}`).digest('hex')}

  private async saveRecord(record:CredentialRecord):Promise<void>{
    await mkdir(path.dirname(this.filePath),{recursive:true})
    const temporary=`${this.filePath}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary,JSON.stringify(record),{encoding:'utf8',mode:0o600,flag:'wx'})
    await rename(temporary,this.filePath)
  }
}

function validateCredentials(username:string,password:string):{username:string;password:string}{
  const normalized=String(username??'').trim()
  const secret=String(password??'')
  if(normalized.length<3||normalized.length>64||!/^[\p{L}\p{N}._@+-]+$/u.test(normalized))throw new Error('El usuario debe tener entre 3 y 64 caracteres válidos.')
  if(secret.length<12||Buffer.byteLength(secret,'utf8')>1024)throw new Error('La contraseña debe tener al menos 12 caracteres.')
  return {username:normalized,password:secret}
}
