import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { config } from './config'

const prefix = 'enc:v1:'
const key = scryptSync(config.db.password, `whatsapp-settings:${config.db.host}:${config.db.database}`, 32)
const encryptedFields = ['deepseekApiKey', 'transferAccountHolder', 'transferAccountNumber', 'transferClabe', 'transferInstructions'] as const

function encrypt(value: unknown): unknown {
  if (typeof value !== 'string' || !value || value.startsWith(prefix)) return value
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${prefix}${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('hex')}`
}

function decrypt(value: unknown): unknown {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return value
  const [ivHex, tagHex, ciphertextHex] = value.slice(prefix.length).split(':')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('No se pudieron descifrar los secretos de configuración; verifica DB_PASSWORD en .env')
  }
}

export function encryptAppSettings<T extends object>(settings: T): T {
  const result = { ...settings } as unknown as Record<string, unknown>
  for (const field of encryptedFields) result[field] = encrypt(result[field])
  return result as T
}

export function decryptAppSettings<T extends object>(settings: T): T {
  const result = { ...settings } as unknown as Record<string, unknown>
  for (const field of encryptedFields) result[field] = decrypt(result[field])
  return result as T
}
