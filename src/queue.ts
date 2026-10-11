import fs from 'node:fs/promises'
import path from 'node:path'
import { BufferJSON } from '@whiskeysockets/baileys'
import { logger } from './logger'

type Operation = { id: string; kind: 'message' | 'delete' | 'status' | 'chat' | 'contact'; data: any }
export class PersistentQueue {
  private readonly file: string
  private running = false
  private pending: Operation[] = []
  private closed = false
  private fileOperations: Promise<void> = Promise.resolve()
  private retryTimer: NodeJS.Timeout | undefined
  constructor(file = './data/pending-operations.jsonl') { this.file = path.resolve(file) }

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    try {
      const content = await fs.readFile(this.file, 'utf8')
      this.pending = content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line, BufferJSON.reviver))
    } catch (error: any) { if (error.code !== 'ENOENT') throw error }
  }
  async enqueue(kind: Operation['kind'], data: any): Promise<void> {
    const op = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, kind, data }
    await this.withFileLock(() => fs.appendFile(this.file, `${JSON.stringify(op, BufferJSON.replacer)}\n`, 'utf8'))
    this.pending.push(op)
    void this.drain()
  }
  async drain(): Promise<void> {
    if (this.running || this.closed) return
    this.running = true
    try {
      while (this.pending.length && !this.closed) {
        const op = this.pending[0]
        let success = false
        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            const db = await import('./db')
            if (op.kind === 'message') await db.persistMessage(op.data)
            else if (op.kind === 'delete') await db.persistDeletion(op.data.jid, op.data.id, op.data.fromMe)
            else if (op.kind === 'status') await db.updateStatus(op.data.jid, op.data.id, op.data.fromMe, op.data.status)
            else if (op.kind === 'contact') await db.enrichContact(op.data.jid, op.data.name)
            else await db.upsertContactChat(op.data.jid, op.data.name, op.data.phoneJid)
            success = true; break
          } catch (error) {
            logger.warn({ attempt, kind: op.kind, err: error }, 'Escritura pendiente; se reintentará')
            if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 500 * 2 ** (attempt - 1)))
          }
        }
        if (!success) {
          this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.drain() }, 30_000)
          this.retryTimer.unref()
          break
        }
        this.pending.shift()
        await this.withFileLock(() => this.rewrite())
      }
    } finally { this.running = false }
  }
  async close(): Promise<void> { this.closed = true; if (this.retryTimer) clearTimeout(this.retryTimer); if (!this.running) return; while (this.running) await new Promise(resolve => setTimeout(resolve, 50)) }
  count(): number { return this.pending.length }
  private async rewrite(): Promise<void> {
    const temp = `${this.file}.tmp`
    await fs.writeFile(temp, this.pending.map(op => JSON.stringify(op, BufferJSON.replacer)).join('\n') + (this.pending.length ? '\n' : ''), 'utf8')
    await fs.rename(temp, this.file)
  }
  private withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.fileOperations.then(operation)
    this.fileOperations = result.then(() => undefined, () => undefined)
    return result
  }
}
