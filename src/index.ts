import makeWASocket, { Browsers, BufferJSON, DisconnectReason, extractMessageContent, fetchLatestBaileysVersion, useMultiFileAuthState, WAMessage } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import { DateTime } from 'luxon'
import { config } from './config'
import { applyShoppingCartActionVerified, assertConversationEngineSchema, beginConversationTurnSend, cancelAppointmentById, claimConversationTurn, claimRecoverableConversationTurnsPage, cleanupOperationalRecords, clearAllConversationHistory as clearConversationHistoryData, clearPendingIntent, clearPendingIntentBySource, closePool, createAppointment, deferConversationTurnSend, deleteContactData, deleteMessagesOlderThan, getContactIdentifiers, getContactJid, getConversationEffect, getPendingIntent, getRecentConversation, getRecoveryHighWaterMark, getShoppingCart, getUpcomingAppointments, isChatBotPaused, listActiveInventory, listOrdersForContact, markConversationTurnFailed, markConversationTurnSent, markConversationTurnSentByOutboundId, markConversationTurnUncertain, markStaleSendingUncertain, pool, prepareConversationReply, releaseRecoveryClaim, rescheduleAppointmentForContact, resumeConversationTurn, savePendingIntent, StoredMessage } from './db'
import { AppointmentPromptSettings, DeepSeekModel, generateDeepSeekResponse } from './deepseek'
import { ConversationEntry, mergeConversationTurns, RecentConversationMemory } from './conversation'
import { authorizeCartMutation, classifyPendingInput, detectCartAction, formatCatalog, formatVerifiedCart, isAffirmative, isPendingIntentCompatible, KeyedSerialExecutor, PendingIntent, resolveInventorySelection, selectedOption } from './conversation-flow'
import { formatAppointmentLocal, resolveAppointmentStart, resolveRelativeAppointmentText } from './appointment-time'
import { catalogImageUrlForOutcome, catalogOutcome, finalizeProviderConversation, resolveDeterministicOrProvider } from './conversation-reply'
import { isIndividualJid } from './identity'
import { logger } from './logger'
import { isMessageAtOrAfterStart, isNonContentProtocolType, normalizeMessage, shouldAutoReply, timestampDate } from './message'
import { PersistentQueue } from './queue'
import { deliverWithStableId } from './outbound-delivery'
import { PerContactRateLimiter } from './rate-limit'
import { AppSettings, launchConfigUi, loadAppSettings, ManualMessage } from './config-ui'
import { recoverPaginated } from './recovery'

function suppressSignalSessionKeyDumps(): void {
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    const output = console[method].bind(console)
    console[method] = ((...args: any[]) => {
      const containsSessionKeys = args.some(value => value && typeof value === 'object' && 'currentRatchet' in value && 'indexInfo' in value)
      if (!containsSessionKeys) output(...args)
    }) as typeof console[typeof method]
  }
}

suppressSignalSessionKeyDumps()

const queue = new PersistentQueue(path.join(config.dataDir, 'pending-operations.jsonl'))
const conversationMemory = new RecentConversationMemory(30, 1_000)
let socket: ReturnType<typeof makeWASocket> | undefined
let reconnectTimer: NodeJS.Timeout | undefined
let reconnectAttempt = 0
let stopping = false
let loggedOut = false
let serviceEnabled = false
let queueInitialized = false
let databaseEnabled = true
let serviceStatus = 'stopped'
let lastDisconnectCode: number | null = null
const knownNames = new Map<string, string>()
const sharedPhoneJids = new Map<string,string>()
const liveConversationMessageKeys=new Set<string>()
const defaultAppSettings: AppSettings = { botName: 'Asistente de WhatsApp', businessName: 'Mi negocio', autoReply: config.autoReply, responseMode: 'fixed', responseText: 'HOLA SOY EL BOT', replyDelayMs: config.replyDelayMs, saveToDatabase: true, deepseekApiKey: '', deepseekModel: 'deepseek-flash', aiTone: 'professional', aiResponseLength: 'brief', aiSystemInstructions: '', maxRepliesPerHour: 20, messageRetentionDays: 0, productCatalogImageUrl: null, serviceCatalogImageUrl: null, transferEnabled: false, transferBankName: '', transferAccountHolder: '', transferAccountNumber: '', transferClabe: '', transferInstructions: '', appointmentsEnabled: false, appointmentTimeZone: 'America/Mexico_City', appointmentDays: [1, 2, 3, 4, 5], appointmentStartTime: '09:00', appointmentEndTime: '17:00', appointmentDurationMinutes: 60 }
let waVersion: [number, number, number] | undefined
let processStartedAtSeconds = 0
let conversationClearInProgress=false
let activeConversationTasks=0
interface RuntimeSnapshot { version:number; settings:AppSettings }
let runtimeSnapshot: RuntimeSnapshot = { version:0, settings:defaultAppSettings }
let configServer: Awaited<ReturnType<typeof launchConfigUi>> | undefined
let retentionTimer: NodeJS.Timeout | undefined
let socketGeneration=0
let recoveryGeneration=0
let recoveryController:AbortController|undefined
let recoveryBarrier:Promise<void>=Promise.resolve()
let recoveryTimer:NodeJS.Timeout|undefined
let recoveryQueuedSocket:ReturnType<typeof makeWASocket>|undefined
const replyRateLimiter = new PerContactRateLimiter()
const attemptRateLimiter = new PerContactRateLimiter()
const chatExecutor = new KeyedSerialExecutor()

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function personalizeFixedResponse(text: string, settings: AppSettings): string {
  return text.replaceAll('{botName}', settings.botName).replaceAll('{businessName}', settings.businessName)
}

const stableOutboundId = (jid:string,messageId:string):string => `bot-${createHash('sha256').update(`${jid}:${messageId}`).digest('hex').slice(0,32)}`
const settingsVersion = (settings:AppSettings):number => Number.parseInt(createHash('sha256').update(JSON.stringify(settings)).digest('hex').slice(0,12),16)
const pendingExpiry = ():string => new Date(Date.now()+10*60*1000).toISOString()

function rememberLiveMessage(message: WAMessage): void {
  if(conversationClearInProgress)return
  const jid = targetJid(message)
  const id = message.key.id
  if (!jid || !id) return
  const timestampMs = timestampDate(message.messageTimestamp).getTime()
  if (!Number.isFinite(timestampMs) || timestampMs < processStartedAtSeconds * 1000) return
  const text = normalizeMessage(message).text
  if (!text?.trim()) return
  const entry: ConversationEntry = { id, role: message.key.fromMe ? 'assistant' : 'user', content: text, timestampMs }
  conversationMemory.remember(jid, entry)
}

async function persist(kind: Parameters<PersistentQueue['enqueue']>[0], data: unknown): Promise<void> {
  if (databaseEnabled) await queue.enqueue(kind, data)
}

function serialize(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer)
}

function liveMessageKey(jid:string,id:string,fromMe:boolean):string{return `${jid}:${Number(fromMe)}:${id}`}
function hasLiveMessage(jid:string,id:string,fromMe:boolean):boolean{return liveConversationMessageKeys.has(liveMessageKey(jid,id,fromMe))}
function rememberLiveMessageKey(jid:string,id:string,fromMe:boolean):void{
  const key=liveMessageKey(jid,id,fromMe);liveConversationMessageKeys.delete(key);liveConversationMessageKeys.add(key)
  if(liveConversationMessageKeys.size>20_000)liveConversationMessageKeys.delete(liveConversationMessageKeys.values().next().value!)
}

function targetJid(message: WAMessage): string | null {
  const remote = message.key.remoteJid
  return isIndividualJid(remote) ? remote! : null
}

async function enqueueMessage(message: WAMessage): Promise<void> {
  const jid = targetJid(message)
  const id = message.key.id
  if (!serviceEnabled||conversationClearInProgress||!jid||!id||!message.message||!isMessageAtOrAfterStart(message.messageTimestamp,processStartedAtSeconds)) return
  const unpacked = normalizeMessage(message)
  const content = extractMessageContent(message.message)
  const protocol = content?.protocolMessage
  const protocolKey = protocol?.key
  if (protocol?.type === 0 && protocolKey?.id && protocolKey.remoteJid) {
    const deleteJid = isIndividualJid(protocolKey.remoteJid) ? protocolKey.remoteJid : jid
    if(!hasLiveMessage(deleteJid,protocolKey.id,!!protocolKey.fromMe))return
    conversationMemory.forget(deleteJid, protocolKey.id)
    await persist('delete', { jid: deleteJid, id: protocolKey.id, fromMe: !!protocolKey.fromMe })
    return
  }
  // Keep edits attached to the original message key, replacing the stored content.
  const isEdit = protocol?.type === 14 && !!protocolKey?.id
  if(isEdit&&protocolKey?.id&&!hasLiveMessage(jid,protocolKey.id,!!protocolKey.fromMe))return
  // Baileys also emits protocol-only sync/control events; they are not chat messages.
  if (protocol && (isNonContentProtocolType(protocol.type) || !isEdit)) return
  const body = isEdit ? protocol.editedMessage : message.message
  const normalized = isEdit ? normalizeMessage({ message: body }) : unpacked
  const targetId = isEdit ? protocolKey!.id! : id
  rememberLiveMessageKey(jid,targetId,isEdit?!!protocolKey!.fromMe:!!message.key.fromMe)
  const item = {
    jid, lid: jid.endsWith('@lid') ? jid : null,
    phoneJid:sharedPhoneJids.get(jid)??null,
    waMessageId: targetId, fromMe: isEdit ? !!protocolKey!.fromMe : !!message.key.fromMe,
    displayName: knownNames.get(jid) ?? message.pushName ?? null,
    senderJid: message.key.participant ?? message.participant ?? jid,
    messageType: normalized.type, text: normalized.text,
    timestamp: timestampDate(message.messageTimestamp), status: message.status,
    deleted: normalized.deleted,
    rawPayload: JSON.parse(serialize(body)),
  } satisfies StoredMessage
  await persist('message', item)
}

function appointmentPromptSettings(settings: AppSettings): AppointmentPromptSettings {
  return { enabled:settings.appointmentsEnabled,timeZone:settings.appointmentTimeZone,days:settings.appointmentDays,startTime:settings.appointmentStartTime,endTime:settings.appointmentEndTime,durationMinutes:settings.appointmentDurationMinutes,nowLocal:DateTime.now().setZone(settings.appointmentTimeZone).toFormat("yyyy-MM-dd'T'HH:mm") }
}

function appointmentLabel(item: { startsAt:Date; serviceRequested:string|null }, settings:AppSettings):string {
  return `${formatAppointmentLocal(item.startsAt,settings.appointmentTimeZone)}${item.serviceRequested?` — ${item.serviceRequested}`:''}`
}

function isCommittedOutcome(outcomeKind:string|null|undefined):boolean{return ['action_applied','cart_applied','recovered_action'].includes(outcomeKind??'')}

async function sendPreparedTurn(current:ReturnType<typeof makeWASocket>,turn:{id:number;settingsVersion:number;outcomeKind?:string|null;outboundText:string|null;outboundMessageId:string|null},quoted:WAMessage|undefined,jid:string,options:{recovery?:boolean;signal?:AbortSignal;recoveryToken?:string}={}):Promise<void>{
  if(!turn.outboundText||!turn.outboundMessageId)return
  const active=runtimeSnapshot.settings
  if(turn.settingsVersion!==runtimeSnapshot.version&&!isCommittedOutcome(turn.outcomeKind)){await markConversationTurnFailed(turn.id,'settings_changed',options.recoveryToken);return}
  if(options.signal?.aborted||stopping||socket!==current)return
  if(!active.autoReply||!serviceEnabled){if(!options.recovery)await markConversationTurnFailed(turn.id,'reply_disabled');return}
  try{if(await isChatBotPaused(jid)){if(!options.recovery)await markConversationTurnFailed(turn.id,'chat_paused');return}}catch{if(!options.recovery)await markConversationTurnFailed(turn.id,'pause_check_failed');return}
  if(!replyRateLimiter.allows(jid,active.maxRepliesPerHour)){if(!options.recovery)await markConversationTurnFailed(turn.id,'reply_quota');return}
  if(options.signal?.aborted||socket!==current)return
  if(!(await beginConversationTurnSend(turn.id,options.recoveryToken)))return
  if(options.signal?.aborted||socket!==current){await deferConversationTurnSend(turn.id,options.recoveryToken);return}
  const outboundText=turn.outboundText,outboundMessageId=turn.outboundMessageId
  const catalogImageUrl=catalogImageUrlForOutcome(turn.outcomeKind,active)
  const delivery=await deliverWithStableId(outboundMessageId,async messageId=>{
    const content=catalogImageUrl?{image:{url:catalogImageUrl},caption:outboundText}:{text:outboundText}
    const sent=await current.sendMessage(jid,content,quoted?{quoted,messageId}:{messageId})
    return {id:sent?.key.id??null}
  })
  if(delivery.status==='uncertain'){await markConversationTurnUncertain(turn.id,'send_uncertain',options.recoveryToken);return}
  replyRateLimiter.record(jid)
  await markConversationTurnSent(turn.id,options.recoveryToken)
  conversationMemory.remember(jid,{id:delivery.externalId,role:'assistant',content:outboundText,timestampMs:Date.now()})
}

async function recoverConversationTurns(current:ReturnType<typeof makeWASocket>,signal:AbortSignal):Promise<void>{
  await markStaleSendingUncertain()
  const throughId=await getRecoveryHighWaterMark()
  const recoveryToken=randomUUID()
  await recoverPaginated({throughId,pageSize:100,concurrency:4,signal,loadPage:(after,through,limit)=>claimRecoverableConversationTurnsPage(after,through,limit,recoveryToken),releaseSkipped:turn=>releaseRecoveryClaim(turn.id,recoveryToken),process:turn=>chatExecutor.run(turn.jid,async()=>{
    try{
      if(signal.aborted||socket!==current)return
      let currentTurn=turn
      if(['received','processing','action_applied'].includes(turn.status)){
        const recovered=await recoverVerifiedEffect(turn.id,turn.jid,runtimeSnapshot.settings)
        const text=recovered??'La operación se interrumpió antes de poder completarse. No confirmé ningún cambio; envía nuevamente tu solicitud.'
        const outboundMessageId=stableOutboundId(turn.jid,turn.waMessageId)
        if(!recovered){
          if(!(await resumeConversationTurn(turn.id,runtimeSnapshot.version,recoveryToken)))return
          await clearPendingIntentBySource(turn.jid,turn.waMessageId)
        }
        if(!(await prepareConversationReply(turn.id,recovered?'recovered_action':'interrupted_before_action',text,outboundMessageId,!!recovered,recoveryToken)))return
        currentTurn={...turn,status:'send_pending',settingsVersion:recovered?turn.settingsVersion:runtimeSnapshot.version,outcomeKind:recovered?'recovered_action':'interrupted_before_action',outboundText:text,outboundMessageId}
      }
      await sendPreparedTurn(current,currentTurn,undefined,turn.jid,{recovery:true,signal,recoveryToken})
    }finally{await releaseRecoveryClaim(turn.id,recoveryToken)}
  })})
}

async function clearConversationHistory():Promise<{messages:number;chats:number;turns:number}>{
  if(conversationClearInProgress)throw new Error('Ya se está vaciando el historial.')
  conversationClearInProgress=true
  try{
    await recoveryBarrier.catch(()=>undefined)
    while(activeConversationTasks>0)await wait(25)
    if(!queueInitialized){await queue.initialize();queueInitialized=true}
    await queue.discardConversationHistory()
    const removed=await clearConversationHistoryData()
    conversationMemory.clearAll()
    liveConversationMessageKeys.clear()
    return {messages:removed.messages,chats:removed.chats,turns:removed.turns}
  }finally{
    if(queueInitialized)queue.resumeConversationWrites()
    conversationClearInProgress=false
    if(databaseEnabled)void queue.drain()
  }
}

function queueRecovery(current:ReturnType<typeof makeWASocket>,controller:AbortController):void{
  if(recoveryQueuedSocket===current||conversationClearInProgress)return
  recoveryQueuedSocket=current
  const previous=recoveryBarrier
  recoveryBarrier=(async()=>{
    await previous.catch(()=>undefined)
    if(!controller.signal.aborted&&socket===current&&!conversationClearInProgress)await recoverConversationTurns(current,controller.signal)
  })().finally(()=>{if(recoveryQueuedSocket===current)recoveryQueuedSocket=undefined})
  void recoveryBarrier.catch(()=>logger.error('No se pudieron recuperar respuestas pendientes'))
}

async function isTurnAuthorized(jid:string,settingsVersion:number):Promise<boolean>{
  if(runtimeSnapshot.version!==settingsVersion||!runtimeSnapshot.settings.autoReply)return false
  try{return !(await isChatBotPaused(jid))}catch{return false}
}

async function resolvePendingIntent(jid:string,messageId:string,input:string,settings:AppSettings,settingsVersion:number,turnId:number):Promise<{handled:boolean;text?:string;actionApplied?:boolean}>{
  const record=await getPendingIntent(jid)
  if(!record)return {handled:false}
  const pending=record.intent
  const route=classifyPendingInput(pending,input)
  if(!isPendingIntentCompatible(pending,settings.appointmentsEnabled,settingsVersion,settings.appointmentTimeZone)){
    await clearPendingIntent(jid)
    return route==='new_request'?{handled:false}:{handled:true,text:'La configuración de agenda cambió. No realicé la operación; inicia nuevamente la solicitud.'}
  }
  if(route==='new_request'){await clearPendingIntent(jid);return {handled:false}}
  if(route==='cancel'){await clearPendingIntent(jid);return {handled:true,text:'Entendido. Abandoné la operación pendiente y no realicé cambios.'}}
  if(pending.kind==='inventory_selection'){
    const result=resolveInventorySelection(pending,input,await listActiveInventory(null))
    if(result.status==='success'||result.status==='not_found')await clearPendingIntent(jid)
    return {handled:true,text:result.text}
  }
  if(pending.kind==='cart_selection'){
    const choice=selectedOption(input,pending.candidates.length)
    if(choice===null)return {handled:true,text:`Elige una opción:\n${pending.candidates.map((item,index)=>`${index+1}. ${item.name} (${item.sku})`).join('\n')}`}
    const selected=pending.candidates[choice]
    if(!(await isTurnAuthorized(jid,settingsVersion)))return {handled:true,text:'La atención automática fue pausada. No realicé cambios.'}
    const result=await applyShoppingCartActionVerified(jid,pending.action,[{sku:selected.sku,quantity:pending.quantity,...pending.removeAll?{removeAll:true}:{}}],`turn:${turnId}:pending-cart`)
    await clearPendingIntent(jid)
    return {handled:true,text:formatVerifiedCart(result,pending.action),actionApplied:result.status==='success'}
  }
  if(pending.kind==='appointment_book_confirmation'){
    if(route==='correction'){
      const schedule={timeZone:settings.appointmentTimeZone,days:settings.appointmentDays,startTime:settings.appointmentStartTime,endTime:settings.appointmentEndTime,durationMinutes:settings.appointmentDurationMinutes}
      const corrected=resolveRelativeAppointmentText(input,schedule)
      if(corrected.status!=='resolved')return {handled:true,text:corrected.status==='none'?'Indica la nueva fecha y hora completas.':corrected.message}
      try{resolveAppointmentStart(corrected.localStart,schedule)}catch(error:any){return {handled:true,text:`${error.message}. Indica otra fecha y hora.`}}
      await savePendingIntent(jid,{intent:{...pending,localStart:corrected.localStart,expiresAt:pendingExpiry()},sourceMessageId:messageId})
      return {handled:true,text:`Actualicé la propuesta. ¿Confirmas la cita para ${corrected.localStart} (${settings.appointmentTimeZone})? Responde “sí” o “no”.`}
    }
    if(!isAffirmative(input))return {handled:true,text:`Confirma con “sí” para agendar ${pending.localStart}${pending.service?` — ${pending.service}`:''}, o responde “no”.`}
    try{
      if(!(await isTurnAuthorized(jid,settingsVersion)))return {handled:true,text:'La atención automática fue pausada. No realicé cambios.'}
      const local=resolveAppointmentStart(pending.localStart,{timeZone:settings.appointmentTimeZone,days:settings.appointmentDays,startTime:settings.appointmentStartTime,endTime:settings.appointmentEndTime,durationMinutes:settings.appointmentDurationMinutes})
      const result=await createAppointment(jid,local.toUTC().toJSDate(),local.plus({minutes:settings.appointmentDurationMinutes}).toUTC().toJSDate(),pending.service,`turn:${turnId}:pending-appointment-book`)
      await clearPendingIntent(jid)
      return result.booked
        ? {handled:true,text:`Cita agendada para ${local.setLocale('es').toFormat('cccc dd LLL yyyy, HH:mm')} (${settings.appointmentTimeZone}), duración ${settings.appointmentDurationMinutes} minutos${pending.service?`, servicio: ${pending.service}`:''}. No se realizó ningún cobro.`,actionApplied:true}
        : {handled:true,text:'Ese horario ya está ocupado. Indica otra fecha y hora para revisar disponibilidad.'}
    }catch{return {handled:true,text:'No pude comprobar o completar la reserva. Indica otra fecha y hora o inténtalo nuevamente.'}}
  }
  if(pending.kind==='appointment_cancel_selection'||pending.kind==='appointment_reschedule_selection'){
    const choice=selectedOption(input,pending.appointments.length)
    if(choice===null)return {handled:true,text:`Elige una cita:\n${pending.appointments.map((item,index)=>`${index+1}. ${item.label}`).join('\n')}`}
    const selected=pending.appointments[choice]
    if(pending.kind==='appointment_cancel_selection'){
      const next:PendingIntent={kind:'appointment_cancel_confirmation',appointmentId:selected.id,label:selected.label,settingsVersion,timeZone:settings.appointmentTimeZone,expiresAt:pendingExpiry()}
      await savePendingIntent(jid,{intent:next,sourceMessageId:messageId})
      return {handled:true,text:`¿Confirmas que deseas cancelar esta cita? ${selected.label}. Responde “sí” o “no”.`}
    }
    const next:PendingIntent={kind:'appointment_details',operation:'reschedule',appointmentId:selected.id,settingsVersion,timeZone:settings.appointmentTimeZone,expiresAt:pendingExpiry()}
    await savePendingIntent(jid,{intent:next,sourceMessageId:messageId})
    return {handled:true,text:`Indica la nueva fecha y hora para reprogramar: ${selected.label}.`}
  }
  if(pending.kind==='appointment_cancel_confirmation'){
    if(!isAffirmative(input))return {handled:true,text:`Confirma con “sí” para cancelar ${pending.label}, o responde “no”.`}
    try{
      if(!(await isTurnAuthorized(jid,settingsVersion)))return {handled:true,text:'La atención automática fue pausada. No realicé cambios.'}
      const result=await cancelAppointmentById(jid,pending.appointmentId,`turn:${turnId}:pending-appointment-cancel`)
      await clearPendingIntent(jid)
      return result.status==='success'?{handled:true,text:`Cita cancelada: ${appointmentLabel(result.value,settings)}.`,actionApplied:true}:{handled:true,text:result.message}
    }catch{return {handled:true,text:'No pude comprobar ni completar la cancelación. La cita no se confirmó como cancelada.'}}
  }
  if(pending.kind==='appointment_reschedule_confirmation'){
    if(route==='correction'){
      const schedule={timeZone:settings.appointmentTimeZone,days:settings.appointmentDays,startTime:settings.appointmentStartTime,endTime:settings.appointmentEndTime,durationMinutes:settings.appointmentDurationMinutes}
      const corrected=resolveRelativeAppointmentText(input,schedule)
      if(corrected.status!=='resolved')return {handled:true,text:corrected.status==='none'?'Indica la nueva fecha y hora completas.':corrected.message}
      try{resolveAppointmentStart(corrected.localStart,schedule)}catch(error:any){return {handled:true,text:`${error.message}. Indica otra fecha y hora.`}}
      await savePendingIntent(jid,{intent:{...pending,localStart:corrected.localStart,expiresAt:pendingExpiry()},sourceMessageId:messageId})
      return {handled:true,text:`Actualicé la propuesta. ¿Confirmas reprogramar ${pending.label} a ${corrected.localStart}? Responde “sí” o “no”.`}
    }
    if(!isAffirmative(input))return {handled:true,text:`Confirma con “sí” para reprogramar ${pending.label} a ${pending.localStart}, o responde “no”.`}
    try{
      if(!(await isTurnAuthorized(jid,settingsVersion)))return {handled:true,text:'La atención automática fue pausada. No realicé cambios.'}
      const local=resolveAppointmentStart(pending.localStart,{timeZone:settings.appointmentTimeZone,days:settings.appointmentDays,startTime:settings.appointmentStartTime,endTime:settings.appointmentEndTime,durationMinutes:settings.appointmentDurationMinutes})
      const result=await rescheduleAppointmentForContact(jid,pending.appointmentId,local.toUTC().toJSDate(),local.plus({minutes:settings.appointmentDurationMinutes}).toUTC().toJSDate(),`turn:${turnId}:pending-appointment-reschedule`)
      await clearPendingIntent(jid)
      return result.status==='success'?{handled:true,text:`Cita reprogramada para ${appointmentLabel(result.value,settings)}.`,actionApplied:true}:{handled:true,text:result.message}
    }catch{return {handled:true,text:'No pude comprobar ni completar la reprogramación. La cita conserva su horario anterior.'}}
  }
  return {handled:false}
}

async function recoverVerifiedEffect(turnId:number,jid:string,settings:AppSettings):Promise<string|null>{
  const effect=await getConversationEffect(turnId)
  if(!effect)return null
  if(effect.effectKey.includes(':pending-'))await clearPendingIntent(jid)
  if(effect.effectType.startsWith('cart:')){
    const action=effect.effectType.slice(5) as 'add'|'remove'|'clear'|'show'
    return formatVerifiedCart(effect.result.changed?{status:'success',value:{cart:effect.result.cart,changed:true}}:{status:'rejected',message:'No se pudo aplicar el cambio solicitado al carrito.'},action)
  }
  if(effect.effectType==='appointment:book'){
    if(!effect.result.booked)return 'Ese horario ya está ocupado. Indica otra fecha y hora.'
    const appointment=effect.result.appointment
    return `Cita agendada para ${appointmentLabel({startsAt:new Date(appointment.startsAt),serviceRequested:appointment.serviceRequested??null},settings)}. No se realizó ningún cobro.`
  }
  if(effect.effectType==='appointment:cancel'){
    return effect.result.status==='success'?`Cita cancelada: ${appointmentLabel({...effect.result.value,startsAt:new Date(effect.result.value.startsAt)},settings)}.`:effect.result.message
  }
  if(effect.effectType==='appointment:reschedule'){
    return effect.result.status==='success'?`Cita reprogramada para ${appointmentLabel({...effect.result.value,startsAt:new Date(effect.result.value.startsAt)},settings)}.`:effect.result.message
  }
  return null
}

async function processAutoReply(current:ReturnType<typeof makeWASocket>,message:WAMessage):Promise<void>{
  const jid=message.key.remoteJid!
  const messageId=message.key.id!
  const snapshot=runtimeSnapshot
  const claimed=await claimConversationTurn(jid,messageId,snapshot.version)
  if(!claimed.claimed){
    if(claimed.turn.status==='send_pending'){await sendPreparedTurn(current,claimed.turn,message,jid);return}
    if(claimed.turn.status==='uncertain')return
    else if(['received','processing','action_applied'].includes(claimed.turn.status)){
      const recovered=await recoverVerifiedEffect(claimed.turn.id,jid,snapshot.settings)
      if(recovered){const outboundMessageId=stableOutboundId(jid,messageId);await prepareConversationReply(claimed.turn.id,'recovered_action',recovered,outboundMessageId,true);await sendPreparedTurn(current,{id:claimed.turn.id,settingsVersion:claimed.turn.settingsVersion,outcomeKind:'recovered_action',outboundText:recovered,outboundMessageId},message,jid);return}
      if(claimed.turn.status==='action_applied')return
       if(!(await resumeConversationTurn(claimed.turn.id,snapshot.version)))return
       await clearPendingIntentBySource(jid,messageId)
      claimed.turn.settingsVersion=snapshot.version
    }else{
      return
    }
  }
  const turn=claimed.turn
  if(!attemptRateLimiter.consume(jid,Math.max(10,snapshot.settings.maxRepliesPerHour*3))){await markConversationTurnFailed(turn.id,'attempt_limit');return}
  try{if(await isChatBotPaused(jid)){await markConversationTurnFailed(turn.id,'chat_paused');return}}catch{await markConversationTurnFailed(turn.id,'pause_check_failed');return}
  await wait(snapshot.settings.replyDelayMs)
  if(stopping||!serviceEnabled||socket!==current){await markConversationTurnFailed(turn.id,'service_stopped');return}
  const input=normalizeMessage(message).text?.trim()
  let answer=personalizeFixedResponse(snapshot.settings.responseText,snapshot.settings)
  let outcome='fixed_reply'
  let actionApplied=false
  if(snapshot.settings.responseMode==='deepseek'){
    if(!input){answer='No pude interpretar contenido de texto en ese mensaje.';outcome='missing_information'}
    else{
      const pending=await resolvePendingIntent(jid,messageId,input,snapshot.settings,snapshot.version,turn.id)
      if(pending.handled){answer=pending.text!;actionApplied=!!pending.actionApplied;outcome=actionApplied?'action_applied':'pending_intent'}
      else{
        try{
          const routed=await resolveDeterministicOrProvider(input,snapshot.settings,{
            listInventory:()=>listActiveInventory(null),
            listOrders:()=>listOrdersForContact(jid),
          },async()=>{
            const inventory=await listActiveInventory()
            const cart=await getShoppingCart(jid)
            let databaseHistory:Awaited<ReturnType<typeof getRecentConversation>>=[]
            if(databaseEnabled)try{databaseHistory=await getRecentConversation(jid,messageId,12)}catch{databaseHistory=[]}
            const history=mergeConversationTurns(databaseHistory,conversationMemory.get(jid),messageId,12)
            const tone={friendly:'amable y cercano',professional:'profesional y claro',formal:'formal y respetuoso'}[snapshot.settings.aiTone]
            const length={brief:'contesta en 1-2 frases',balanced:'contesta con el detalle necesario',detailed:'ofrece detalle cuando sea útil'}[snapshot.settings.aiResponseLength]
            const instructions=`El bot se llama ${snapshot.settings.botName} y representa a ${snapshot.settings.businessName}. Tono ${tone}; ${length}. Políticas explícitas del negocio: ${snapshot.settings.aiSystemInstructions}`
            const generated=await generateDeepSeekResponse(snapshot.settings.deepseekApiKey,snapshot.settings.deepseekModel,input,inventory,cart,snapshot.settings.transferEnabled,appointmentPromptSettings(snapshot.settings),history,instructions)
            return {generated,inventory,cart}
          })
          if(routed.kind==='deterministic'){
            answer=routed.reply.text;outcome=routed.reply.outcome
            if(routed.reply.inventoryCandidates?.length){
              await savePendingIntent(jid,{intent:{kind:'inventory_selection',candidates:routed.reply.inventoryCandidates,expiresAt:pendingExpiry()},sourceMessageId:messageId})
            }
          }else{
          const {generated,inventory,cart}=routed.value
          if(!(await isTurnAuthorized(jid,snapshot.version))){await markConversationTurnFailed(turn.id,'authorization_changed');return}
          const catalogRequest=generated.catalogRequest
          const existingPending=await getPendingIntent(jid)
          const schedule={timeZone:snapshot.settings.appointmentTimeZone,days:snapshot.settings.appointmentDays,startTime:snapshot.settings.appointmentStartTime,endTime:snapshot.settings.appointmentEndTime,durationMinutes:snapshot.settings.appointmentDurationMinutes}
          const relativeAppointment=resolveRelativeAppointmentText(input,schedule)
          const proposedAppointmentStart=relativeAppointment.status==='resolved'?relativeAppointment.localStart:relativeAppointment.status==='none'?generated.appointmentStart:null
          const appointmentIssue=relativeAppointment.status==='missing_time'||relativeAppointment.status==='ambiguous_time'?relativeAppointment.message:null

          const cartAction=detectCartAction(input)!=='none'?detectCartAction(input):generated.cartAction
          if(catalogRequest){
            const all=await listActiveInventory(null)
            answer=formatCatalog(all,catalogRequest)
            outcome=catalogOutcome(catalogRequest)
          }else if(cartAction!=='none'){
            const authorization=authorizeCartMutation(input,cartAction,generated.cartItems,inventory,cart)
            if(authorization.result.status==='success'){
              if(!(await isTurnAuthorized(jid,snapshot.version))){await markConversationTurnFailed(turn.id,'authorization_changed_before_action');return}
              const verified=await applyShoppingCartActionVerified(jid,authorization.result.value.action,authorization.result.value.items,`turn:${turn.id}:cart`)
              answer=formatVerifiedCart(verified,authorization.result.value.action);actionApplied=verified.status==='success';outcome=actionApplied?'cart_applied':verified.status
            }else{
              answer=authorization.result.message
              if(authorization.result.status==='ambiguous'&&authorization.candidates?.length){
                const intent:PendingIntent={kind:'cart_selection',action:cartAction==='remove'?'remove':'add',candidates:authorization.candidates,quantity:authorization.quantity??1,removeAll:authorization.removeAll,expiresAt:pendingExpiry()}
                await savePendingIntent(jid,{intent,sourceMessageId:messageId})
                answer+=`\n${authorization.result.options.join('\n')}`
              }
              outcome=authorization.result.status
            }
          }else if(generated.appointmentAction==='list'){
            const upcoming=await getUpcomingAppointments(jid)
            answer=upcoming.length?`Tus próximas citas:\n${upcoming.map(item=>`• ${appointmentLabel(item,snapshot.settings)}`).join('\n')}`:'No tienes citas futuras registradas.'
            outcome='appointment_list'
          }else if(generated.appointmentAction==='cancel'||generated.appointmentAction==='reschedule'){
            const upcoming=await getUpcomingAppointments(jid)
            if(!upcoming.length){answer='No tienes citas futuras activas para modificar.';outcome='rejected'}
            else if(upcoming.length>1){
              const appointments=upcoming.slice(0,5).map(item=>({id:item.id,label:appointmentLabel(item,snapshot.settings)}))
              const intent:PendingIntent=generated.appointmentAction==='cancel'
                ?{kind:'appointment_cancel_selection',appointments,settingsVersion:snapshot.version,timeZone:snapshot.settings.appointmentTimeZone,expiresAt:pendingExpiry()}
                :{kind:'appointment_reschedule_selection',appointments,settingsVersion:snapshot.version,timeZone:snapshot.settings.appointmentTimeZone,expiresAt:pendingExpiry()}
              await savePendingIntent(jid,{intent,sourceMessageId:messageId})
              answer=`Elige una cita:\n${appointments.map((item,index)=>`${index+1}. ${item.label}`).join('\n')}`;outcome='ambiguous'
            }else if(generated.appointmentAction==='cancel'){
              const selected=upcoming[0],label=appointmentLabel(selected,snapshot.settings)
              await savePendingIntent(jid,{intent:{kind:'appointment_cancel_confirmation',appointmentId:selected.id,label,settingsVersion:snapshot.version,timeZone:snapshot.settings.appointmentTimeZone,expiresAt:pendingExpiry()},sourceMessageId:messageId})
              answer=`¿Confirmas que deseas cancelar esta cita? ${label}. Responde “sí” o “no”.`;outcome='confirmation_required'
            }else{
              const selected=upcoming[0],label=appointmentLabel(selected,snapshot.settings)
              if(!proposedAppointmentStart){await savePendingIntent(jid,{intent:{kind:'appointment_details',operation:'reschedule',appointmentId:selected.id,settingsVersion:snapshot.version,timeZone:snapshot.settings.appointmentTimeZone,expiresAt:pendingExpiry()},sourceMessageId:messageId});answer=appointmentIssue??`Indica la nueva fecha y hora para reprogramar: ${label}.`;outcome='missing_information'}
              else{
                try{resolveAppointmentStart(proposedAppointmentStart,schedule)
                  await savePendingIntent(jid,{intent:{kind:'appointment_reschedule_confirmation',appointmentId:selected.id,localStart:proposedAppointmentStart,label,settingsVersion:snapshot.version,timeZone:snapshot.settings.appointmentTimeZone,expiresAt:pendingExpiry()},sourceMessageId:messageId});answer=`¿Confirmas reprogramar ${label} a ${proposedAppointmentStart} (${snapshot.settings.appointmentTimeZone})? Responde “sí” o “no”.`;outcome='confirmation_required'
                }catch(error:any){answer=`${error.message}. Indica otra fecha y hora.`;outcome='rejected'}
              }
            }
          }else if(generated.appointmentAction==='book'||existingPending?.intent.kind==='appointment_details'&&existingPending.intent.operation==='book'){
            if(!proposedAppointmentStart){await savePendingIntent(jid,{intent:{kind:'appointment_details',operation:'book',settingsVersion:snapshot.version,timeZone:snapshot.settings.appointmentTimeZone,expiresAt:pendingExpiry()},sourceMessageId:messageId});answer=appointmentIssue??`Indica fecha y hora completas. Horario: ${snapshot.settings.appointmentStartTime}–${snapshot.settings.appointmentEndTime} (${snapshot.settings.appointmentTimeZone}).`;outcome='missing_information'}
            else{
              try{resolveAppointmentStart(proposedAppointmentStart,schedule)
                await savePendingIntent(jid,{intent:{kind:'appointment_book_confirmation',localStart:proposedAppointmentStart,service:generated.appointmentService,settingsVersion:snapshot.version,timeZone:snapshot.settings.appointmentTimeZone,expiresAt:pendingExpiry()},sourceMessageId:messageId});answer=`¿Confirmas la cita para ${proposedAppointmentStart} (${snapshot.settings.appointmentTimeZone})${generated.appointmentService?` — ${generated.appointmentService}`:''}? Responde “sí” o “no”.`;outcome='confirmation_required'
              }catch(error:any){answer=`${error.message}. Indica otra fecha y hora.`;outcome='rejected'}
            }
          }else if(existingPending?.intent.kind==='appointment_details'&&existingPending.intent.operation==='reschedule'){
            if(!proposedAppointmentStart){answer=appointmentIssue??'Indica una fecha y una hora completas para reprogramar.';outcome='missing_information'}
            else{
              const appointmentId=existingPending.intent.appointmentId!
              await savePendingIntent(jid,{intent:{kind:'appointment_reschedule_confirmation',appointmentId,localStart:proposedAppointmentStart,label:'la cita seleccionada',settingsVersion:snapshot.version,timeZone:snapshot.settings.appointmentTimeZone,expiresAt:pendingExpiry()},sourceMessageId:messageId})
              answer=`¿Confirmas reprogramar la cita seleccionada a ${proposedAppointmentStart} (${snapshot.settings.appointmentTimeZone})? Responde “sí” o “no”.`;outcome='confirmation_required'
            }
          }else{
            const conversational=finalizeProviderConversation(generated.text);answer=conversational.text;outcome=conversational.outcome
          }
          }
        }catch{answer='No pude comprobar la información ni completar operaciones en este momento. Inténtalo nuevamente.';outcome='infrastructure_error'}
      }
    }
  }
  const outboundMessageId=stableOutboundId(jid,messageId)
  await prepareConversationReply(turn.id,outcome,answer,outboundMessageId,actionApplied)
  await sendPreparedTurn(current,{id:turn.id,settingsVersion:snapshot.version,outcomeKind:outcome,outboundText:answer,outboundMessageId},message,jid)
}

async function startSocket(): Promise<void> {
  if (stopping || !serviceEnabled || loggedOut || socket) return
  const generation=++socketGeneration
  recoveryController?.abort()
  const controller=new AbortController()
  recoveryController=controller
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir)
  if(generation!==socketGeneration||stopping||!serviceEnabled||loggedOut)return
  const current = makeWASocket({
    auth: state,
    version: waVersion,
    // With syncFullHistory=true, Windows/MacOS are advertised as WIN32/DARWIN.
    // Ubuntu intentionally maps to WEB_BROWSER, avoiding the recent 428 rejection.
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: true,
    emitOwnEvents: true,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    logger: pino({ level: 'silent' }),
  })
  socket = current
  current.ev.on('creds.update', saveCreds)
  current.ev.on('connection.update', update => {
    if(generation!==socketGeneration||socket!==current)return
    if (update.qr) {
      serviceStatus = 'waiting-qr'
      logger.info('Escanea el QR desde WhatsApp > Dispositivos vinculados')
      qrcode.generate(update.qr, { small: true })
    }
    if (update.connection === 'open') {
      reconnectAttempt = 0; serviceStatus = 'connected'; lastDisconnectCode = null; logger.info('WhatsApp conectado')
      if(recoveryGeneration!==generation){
        recoveryGeneration=generation
        queueRecovery(current,controller)
        if(recoveryTimer)clearInterval(recoveryTimer)
        recoveryTimer=setInterval(()=>queueRecovery(current,controller),60_000)
        recoveryTimer.unref()
      }
    }
    if (update.connection === 'close') {
      const disconnectError = update.lastDisconnect?.error as (Boom & Error) | undefined
      const reason = disconnectError?.output?.statusCode
      lastDisconnectCode = reason ?? null
      controller.abort()
      if(recoveryTimer){clearInterval(recoveryTimer);recoveryTimer=undefined}
      socket = undefined
      if (reason === DisconnectReason.loggedOut) {
        loggedOut = true
        serviceEnabled = false
        serviceStatus = 'logged-out'
        logger.error('La sesión fue cerrada desde WhatsApp; elimina AUTH_DIR y vuelve a vincular mediante QR')
        return
      }
      if (!stopping && serviceEnabled) {
        serviceStatus = 'reconnecting'
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt++, 5))
        logger.warn({ delayMs: delay, disconnectCode: reason ?? null, disconnectMessage: disconnectError?.message ?? 'desconexión sin detalle' }, 'Conexión cerrada; reconexión programada')
        reconnectTimer = setTimeout(() => { void startSocket().catch(error => logger.error({ err: error }, 'No se pudo reconectar')) }, delay)
      }
    }
  })
  current.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
    try {
      for (const contact of contacts) if (isIndividualJid(contact.id)) {
        const name = contact.name ?? contact.notify ?? contact.verifiedName
        if (name) knownNames.set(contact.id, name)
      }
      logger.info({ ignoredHistoricalMessages:messages.length, historicalChats:chats.filter(c=>isIndividualJid(c.id)).length },'Se omitió importar conversaciones anteriores al inicio del servicio')
    } catch (error) { logger.error({ err: error }, 'Error procesando metadatos de historial') }
  })
  current.ev.on('contacts.upsert', async contacts => {
    try { for (const contact of contacts) if (isIndividualJid(contact.id)) {
      const name = contact.name ?? contact.notify ?? contact.verifiedName
      if (name) { knownNames.set(contact.id, name); await persist('contact', { jid: contact.id, name }) }
    } }
    catch (error) { logger.error({ err: error }, 'Error procesando contacts.upsert') }
  })
  current.ev.on('contacts.update', async updates => {
    try { for (const contact of updates) if (contact.id && isIndividualJid(contact.id) && contact.name) {
      knownNames.set(contact.id, contact.name)
      await persist('contact', { jid: contact.id, name: contact.name })
    } }
    catch (error) { logger.error({ err: error }, 'Error procesando contacts.update') }
  })
  current.ev.on('chats.phoneNumberShare', event => { if(isIndividualJid(event.lid)&&isIndividualJid(event.jid))sharedPhoneJids.set(event.lid,event.jid) })
  current.ev.on('messages.upsert', async ({ messages, type }) => {
    const tasks=messages.map(async message=>{
      try{
        if(generation!==socketGeneration||socket!==current)return
        if(message.key.fromMe&&message.key.id)await markConversationTurnSentByOutboundId(message.key.id).catch(()=>false)
        if(type==='notify'||message.key.fromMe)rememberLiveMessage(message)
        await enqueueMessage(message)
        if(conversationClearInProgress)return
        if(!runtimeSnapshot.settings.autoReply||!shouldAutoReply(message,type,processStartedAtSeconds))return
        const normalized=normalizeMessage(message)
        if(normalized.deleted||normalized.type==='protocolMessage')return
        const jid=message.key.remoteJid!
        await recoveryBarrier.catch(()=>undefined)
        if(controller.signal.aborted||generation!==socketGeneration||socket!==current||conversationClearInProgress)return
        activeConversationTasks++
        try{await chatExecutor.run(jid,()=>processAutoReply(current,message))}finally{activeConversationTasks--}
      }catch(error){logger.error({err:error},'Error procesando un mensaje entrante; se continuará con los demás')}
    })
    await Promise.allSettled(tasks)
  })
  current.ev.on('messages.update', async updates => {
    try {
      for (const { key, update } of updates) {
        const jid = key.remoteJid
        if (!jid || !key.id || !isIndividualJid(jid)) continue
        if (update.status !== undefined&&hasLiveMessage(jid,key.id,!!key.fromMe)) await persist('status', { jid, id: key.id, fromMe: !!key.fromMe, status: update.status })
        if (update.message) {
          if(!hasLiveMessage(jid,key.id,!!key.fromMe))continue
          const edited = { key, message: update.message, messageTimestamp: Math.floor(Date.now() / 1000) } as WAMessage
          rememberLiveMessage(edited)
          await enqueueMessage(edited)
        }
      }
    } catch (error) { logger.error({ err: error }, 'Error procesando messages.update') }
  })
  current.ev.on('messages.delete', async event => {
    try {
      if ('keys' in event) for (const key of event.keys) if (key.remoteJid && isIndividualJid(key.remoteJid) && key.id&&hasLiveMessage(key.remoteJid,key.id,!!key.fromMe)) {
        conversationMemory.forget(key.remoteJid, key.id)
        await persist('delete', { jid: key.remoteJid, id: key.id, fromMe: !!key.fromMe })
      }
    } catch (error) { logger.error({ err: error }, 'Error procesando messages.delete') }
  })
}

async function applyRuntimeSettings(settings:AppSettings):Promise<void>{
  runtimeSnapshot={version:settingsVersion(settings),settings:structuredClone(settings)}
  databaseEnabled = settings.saveToDatabase
  if(retentionTimer){clearInterval(retentionTimer);retentionTimer=undefined}
  if(serviceEnabled&&(databaseEnabled||settings.autoReply)){
    if(databaseEnabled){
      if(!queueInitialized){await queue.initialize();queueInitialized=true}
      void queue.drain()
    }
    const revision=runtimeSnapshot.version
    const cleanup=async()=>{if(runtimeSnapshot.version!==revision)return;try{
      const removedMessages=settings.messageRetentionDays>0?await deleteMessagesOlderThan(settings.messageRetentionDays):0
      const operational=await cleanupOperationalRecords()
      if(settings.messageRetentionDays>0)conversationMemory.pruneOlderThan(Date.now()-settings.messageRetentionDays*86400000)
      logger.info({removedMessages,operational},'Limpieza de retención completada')
    }catch{logger.error('Falló la limpieza de retención')}}
    await cleanup();retentionTimer=setInterval(()=>{void cleanup()},86400000);retentionTimer.unref()
  }
}

async function startConfiguredService(settings: AppSettings): Promise<void> {
  if (serviceEnabled || socket) throw new Error('El servicio de WhatsApp ya está iniciado')
  stopping = false
  loggedOut = false
  serviceEnabled = true
  serviceStatus = 'connecting'
  await applyRuntimeSettings(settings)
  processStartedAtSeconds = Math.floor(Date.now() / 1000)
  replyRateLimiter.clear()
  attemptRateLimiter.clear()
  try {
    const needsDatabase = databaseEnabled || settings.autoReply
    if (needsDatabase) {
      await pool.query('SELECT 1')
      if(settings.autoReply)await assertConversationEngineSchema()
      logger.info('Conexión MySQL verificada')
    }
    try {
      const latest = await fetchLatestBaileysVersion()
      waVersion = latest.version
      logger.info({ waVersion: waVersion.join('.'), isLatest: latest.isLatest }, 'Versión de WhatsApp Web seleccionada')
    } catch (error: any) {
      logger.warn({ error: error?.message }, 'No se pudo consultar la versión remota; se usará la versión incluida en Baileys')
    }
    await startSocket()
  } catch (error) {
    serviceEnabled = false
    serviceStatus = 'error'
    throw error
  }
}

async function logoutWhatsApp(): Promise<void> {
  serviceEnabled = false
  serviceStatus = 'stopped'
  loggedOut = false
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined }
  if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = undefined }
  if (recoveryTimer) { clearInterval(recoveryTimer); recoveryTimer = undefined }
  recoveryController?.abort();socketGeneration++
  const current = socket
  socket = undefined
  if (current) {
    try { await current.logout() } catch { /* puede estar desconectado; de todos modos se borran las credenciales locales */ }
  }
  await fs.rm(config.authDir, { recursive: true, force: true })
  serviceStatus = 'logged-out'
}

async function sendManualMessage(contactId: number, payload:ManualMessage): Promise<void> {
  if (!socket || serviceStatus !== 'connected') throw new Error('WhatsApp no está conectado')
  const jid = await getContactJid(contactId)
  if (!jid||!isIndividualJid(jid)) throw new Error('El contacto no tiene un chat individual de WhatsApp disponible')
  const content=payload.image
    ?{image:payload.image,mimetype:payload.mimeType??'image/jpeg',...(payload.text?{caption:payload.text}:{})}
    :{text:payload.text}
  const message = await socket.sendMessage(jid,content)
  if (message?.key.id) conversationMemory.remember(jid, { id: message.key.id, role: 'assistant', content: payload.text||'[Imagen enviada]', timestampMs: Date.now() })
}

async function deleteContact(contactId: number): Promise<boolean> {
  const identifiers=await getContactIdentifiers(contactId)
  if(!identifiers.length)return false
  const jids=[...new Set(identifiers.map(item=>item.jid))].sort()
  await queue.suppressAndDiscard(jids)
  const runLocked=async(index:number):Promise<boolean>=>index===jids.length
    ?deleteContactData(contactId)
    :chatExecutor.run(jids[index],()=>runLocked(index+1))
  try{
    const deleted=await runLocked(0)
    if(deleted)for(const jid of jids){conversationMemory.clear(jid);knownNames.delete(jid);replyRateLimiter.forget(jid);attemptRateLimiter.forget(jid)}
    return deleted
  }finally{queue.releaseJids(jids)}
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  serviceEnabled = false
  logger.info({ signal }, 'Cerrando proceso')
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (retentionTimer) clearInterval(retentionTimer)
  if (recoveryTimer) clearInterval(recoveryTimer)
  recoveryController?.abort();socketGeneration++
  try { socket?.end(undefined) } catch {}
  configServer?.close()
  await queue.close()
  await closePool()
  process.exit(0)
}

async function main(): Promise<void> {
  const initialSettings = await loadAppSettings(defaultAppSettings)
  await applyRuntimeSettings(initialSettings)
  configServer = await launchConfigUi(initialSettings, {
    start: startConfiguredService,
    applySettings: applyRuntimeSettings,
    logout: logoutWhatsApp,
    sendManualMessage,
    deleteContact,
    clearConversations:clearConversationHistory,
    status: () => ({ serviceStatus, disconnectCode: lastDisconnectCode, pendingWrites: queue.count(), saveToDatabase: databaseEnabled }),
  })
  logger.info('Panel de configuración listo en http://127.0.0.1:3000. Configura opciones y pulsa "Iniciar servicio WhatsApp".')
  const browserCommand = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const browserArgs = process.platform === 'win32' ? ['/c', 'start', '', 'http://127.0.0.1:3000'] : ['http://127.0.0.1:3000']
  const browser = spawn(browserCommand, browserArgs, { detached: true, stdio: 'ignore', windowsHide: true })
  browser.on('error', error => logger.warn({ err: error }, 'No se pudo abrir el navegador automáticamente; abre http://127.0.0.1:3000'))
  browser.unref()
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}

main().catch(async error => {
  logger.fatal({ err: error }, 'No se pudo iniciar. Verifica .env, migraciones y conexión MySQL')
  await closePool().catch(() => undefined)
  process.exitCode = 1
})
