import fs from 'node:fs/promises'
import { pool } from './db'

async function main(): Promise<void> {
  try {
    const [[contacts]]: any = await pool.query('SELECT COUNT(*) total FROM contacts')
    const [[unresolved]]: any = await pool.query("SELECT COUNT(*) total FROM contacts WHERE identity_status='unresolved'")
    const [[chats]]: any = await pool.query('SELECT COUNT(*) total FROM chats')
    const [[messages]]: any = await pool.query('SELECT COUNT(*) total FROM messages')
    let pending = 0
    try { pending = (await fs.readFile('./data/pending-operations.jsonl', 'utf8')).split(/\r?\n/).filter(Boolean).length } catch (error: any) { if (error.code !== 'ENOENT') throw error }
    console.table({ contacts: contacts.total, unresolved_identities: unresolved.total, chats: chats.total, messages: messages.total, pending_writes: pending })
  } finally { await pool.end() }
}
main().catch(error => { console.error('No se pudieron consultar conteos:', error.message); process.exitCode = 1 })
