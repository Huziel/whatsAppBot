export interface IdentityInput { jid?: string | null; lid?: string | null; phoneJid?: string | null }
export interface Identity { identifiers: Array<{ jid: string; type: 'pn' | 'lid' }>; phoneNumber: string | null; status: 'resolved' | 'unresolved' }

export function phoneFromJid(jid?: string | null): string | null {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null
  const local = jid.slice(0, -'@s.whatsapp.net'.length)
  return /^\+?\d+$/.test(local) ? local.replace(/^\+/, '') : null
}

export function resolveIdentity(input: IdentityInput): Identity {
  const identifiers = new Map<string, 'pn' | 'lid'>()
  for (const jid of [input.jid, input.phoneJid, input.lid]) {
    if (!jid) continue
    if (jid.endsWith('@s.whatsapp.net')) identifiers.set(jid, 'pn')
    else if (jid.endsWith('@lid')) identifiers.set(jid, 'lid')
  }
  const phoneJid = input.phoneJid?.endsWith('@s.whatsapp.net') ? input.phoneJid : input.jid
  const phoneNumber = phoneFromJid(phoneJid)
  return { identifiers: [...identifiers].map(([jid, type]) => ({ jid, type })), phoneNumber, status: phoneNumber ? 'resolved' : 'unresolved' }
}

export function isIndividualJid(jid?: string | null): boolean {
  return !!jid && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) && !jid.includes('@g.us')
}

export function messageDedupKey(chatId: number, waMessageId: string, fromMe: boolean): string {
  return `${chatId}:${waMessageId}:${Number(fromMe)}`
}
