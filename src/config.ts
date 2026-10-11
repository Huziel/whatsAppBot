import dotenv from 'dotenv'
import path from 'node:path'

dotenv.config()

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (!value?.trim()) throw new Error(`Falta configurar ${name} en .env`)
  return value.trim()
}

const port = Number(required('DB_PORT', '3306'))
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DB_PORT no es válido')
const autoReplyValue = (process.env.BOT_AUTO_REPLY ?? 'false').trim().toLowerCase()
if (!['true', 'false'].includes(autoReplyValue)) throw new Error('BOT_AUTO_REPLY debe ser true o false')
const replyDelayMs = Number(required('BOT_REPLY_DELAY_MS', '1500'))
if (!Number.isInteger(replyDelayMs) || replyDelayMs < 1500 || replyDelayMs > 60_000) throw new Error('BOT_REPLY_DELAY_MS debe ser un entero entre 1500 y 60000')

export const config = {
  db: {
    host: required('DB_HOST', '127.0.0.1'), port,
    database: required('DB_NAME', 'whatsapp_local'),
    user: required('DB_USER'), password: required('DB_PASSWORD'),
  },
  authDir: path.resolve(required('AUTH_DIR', './auth')),
  logLevel: required('LOG_LEVEL', 'info'),
  autoReply: autoReplyValue === 'true',
  replyDelayMs,
}
