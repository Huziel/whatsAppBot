import { IncomingMessage, ServerResponse } from 'node:http'
import { AppError, ConflictError, ExternalServiceError, InternalError, PayloadTooLargeError, ValidationError } from '../errors'
import { logger } from '../logger'

export interface ApiContext { request: IncomingMessage; response: ServerResponse; url: URL; requestId:string }
const responseRequestIds=new WeakMap<ServerResponse,string>()
const statusCodes:Record<number,string>={400:'VALIDATION_ERROR',401:'AUTHENTICATION_REQUIRED',403:'FORBIDDEN',404:'NOT_FOUND',409:'CONFLICT',413:'PAYLOAD_TOO_LARGE',429:'RATE_LIMITED',500:'INTERNAL_ERROR',503:'EXTERNAL_SERVICE_UNAVAILABLE'}

export function initializeRequest(response:ServerResponse,requestId:string):void{
  responseRequestIds.set(response,requestId)
  response.setHeader('X-Request-Id',requestId)
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  let payload=value
  if(status>=400){
    const source=value as any,message=typeof source?.error==='string'?source.error:source?.error?.message??'La solicitud no pudo completarse.'
    const code=source?.error?.code??statusCodes[status]??'REQUEST_FAILED'
    payload={error:{code,message,requestId:responseRequestIds.get(response)??'unknown'}}
    if(status<500)logger.warn({requestId:responseRequestIds.get(response)??'unknown',status,code},'Solicitud HTTP rechazada')
  }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(payload))
}

export async function readJson(request: IncomingMessage, maxBytes=16_384): Promise<any> {
  const contentType=String(request.headers['content-type']??'').split(';')[0].trim().toLowerCase()
  if(contentType!=='application/json')throw new ValidationError('La solicitud debe usar application/json.','CONTENT_TYPE_REQUIRED')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) throw new PayloadTooLargeError()
    chunks.push(Buffer.from(chunk))
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}
  catch{throw new ValidationError('El cuerpo JSON no es válido.','INVALID_JSON')}
}

const mysqlConnectionErrors=new Set(['ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','PROTOCOL_CONNECTION_LOST','ER_ACCESS_DENIED_ERROR','ER_BAD_DB_ERROR'])

export function sendError(response:ServerResponse,error:unknown):void{
  const requestId=responseRequestIds.get(response)??'unknown'
  let mapped:AppError
  if(error instanceof AppError)mapped=error
  else if(mysqlConnectionErrors.has((error as any)?.code))mapped=new ExternalServiceError('MySQL no está disponible. Inténtalo nuevamente más tarde.','DATABASE_UNAVAILABLE')
  else if(['ER_DUP_ENTRY','ER_ROW_IS_REFERENCED_2','ER_NO_REFERENCED_ROW_2'].includes((error as any)?.code))mapped=new ConflictError('La operación entra en conflicto con un registro existente.','DATABASE_CONFLICT')
  else mapped=new InternalError()
  if(mapped.status>=500)logger.error({err:error,requestId,code:mapped.code},'Solicitud HTTP fallida')
  sendJson(response,mapped.status,{error:{code:mapped.code,message:mapped.expose?mapped.message:'Ocurrió un error interno.',requestId}})
}
