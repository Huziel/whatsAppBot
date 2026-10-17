import pino from 'pino'
import { config } from './config'

export const logger = pino({ level: config.logLevel, redact: { paths: ['*.phone_number','*.phoneNumber','*.customer_phone','*.customerPhone','*.jid','*.text','*.raw_payload','*.rawPayload','*.message','*.password','*.accessToken','*.public_access_token_hash'], censor: '[REDACTED]' } })
