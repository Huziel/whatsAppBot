import { extractMessageContent, getContentType } from '@whiskeysockets/baileys'
import { isIndividualJid } from './identity'

export interface NormalizedMessage { type: string; text: string | null; deleted: boolean }

export function isNonContentProtocolType(type: number | null | undefined): boolean {
  return type !== 0 && type !== 14
}

export function normalizeMessage(message: any): NormalizedMessage {
  const outer = message?.message ?? message
  let content = extractMessageContent(outer) as Record<string, any> | undefined
  if (!content) return { type: 'unknown', text: null, deleted: false }
  const type = getContentType(content) ?? 'unknown'
  if (type === 'protocolMessage' && content.protocolMessage?.type === 0) return { type: 'protocolMessage', text: null, deleted: true }
  const item = content[type] as any
  const text = typeof content.conversation === 'string' ? content.conversation
    : typeof item === 'string' ? item
      : typeof item?.text === 'string' ? item.text
        : typeof item?.caption === 'string' ? item.caption : null
  return { type, text, deleted: false }
}

export function timestampDate(timestamp: unknown): Date {
  let seconds: number
  if (typeof timestamp === 'number') seconds = timestamp
  else if (typeof timestamp === 'string') seconds = Number(timestamp)
  else if (timestamp && typeof (timestamp as any).toNumber === 'function') seconds = (timestamp as any).toNumber()
  else seconds = Number(timestamp ?? 0)
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date(0)
  return new Date(seconds * 1000)
}

export function isMessageAtOrAfterStart(timestamp:unknown,startedAtSeconds:number):boolean{
  const seconds=timestampDate(timestamp).getTime()/1000
  return Number.isFinite(startedAtSeconds)&&seconds>=startedAtSeconds
}

export function shouldAutoReply(message: any, upsertType: string, processStartedAtSeconds: number): boolean {
  const jid = message?.key?.remoteJid
  if (!['notify','append'].includes(upsertType) || message?.key?.fromMe || !message?.key?.id || !isIndividualJid(jid) || !message?.message) return false
  const timestampSeconds = timestampDate(message.messageTimestamp).getTime() / 1000
  return timestampSeconds >= processStartedAtSeconds
}
