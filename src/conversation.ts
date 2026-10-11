export interface ConversationEntry {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestampMs: number
}

export interface ConversationTurn { role: 'user' | 'assistant'; content: string }

export class RecentConversationMemory {
  private readonly chats = new Map<string, ConversationEntry[]>()
  constructor(private readonly perChatLimit = 30, private readonly chatLimit = 1_000) {}

  remember(jid: string, entry: ConversationEntry): void {
    if (!entry.content.trim()) return
    let entries = this.chats.get(jid)
    if (!entries) {
      entries = []
      this.chats.set(jid, entries)
    }
    const existing = entries.findIndex(item => item.id === entry.id)
    if (existing >= 0) entries.splice(existing, 1)
    entries.push({ ...entry, content: entry.content.slice(0, 4_000) })
    entries.sort((a, b) => a.timestampMs - b.timestampMs)
    if (entries.length > this.perChatLimit) entries.splice(0, entries.length - this.perChatLimit)
    if (this.chats.size > this.chatLimit) this.chats.delete(this.chats.keys().next().value!)
  }

  get(jid: string): ConversationEntry[] { return [...(this.chats.get(jid) ?? [])] }

  forget(jid: string, id: string): void {
    const entries = this.chats.get(jid)
    if (!entries) return
    const index = entries.findIndex(item => item.id === id)
    if (index >= 0) entries.splice(index, 1)
    if (!entries.length) this.chats.delete(jid)
  }

  clear(jid: string): void { this.chats.delete(jid) }

  pruneOlderThan(timestampMs: number): void {
    for (const [jid, entries] of this.chats) {
      const recent = entries.filter(entry => entry.timestampMs >= timestampMs)
      if (recent.length) this.chats.set(jid, recent)
      else this.chats.delete(jid)
    }
  }
}

export function mergeConversationTurns(
  database: ConversationEntry[],
  memory: ConversationEntry[],
  currentMessageId: string,
  limit = 12,
): ConversationTurn[] {
  const byId = new Map<string, ConversationEntry>()
  for (const entry of [...database, ...memory]) if (entry.id !== currentMessageId) byId.set(entry.id, entry)
  return [...byId.values()]
    .sort((a, b) => a.timestampMs - b.timestampMs)
    .slice(-limit)
    .map(({ role, content }) => ({ role, content: content.slice(0, 1_500) }))
}
