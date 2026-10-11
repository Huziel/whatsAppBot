import pino from 'pino'
import { config } from './config'

export const logger = pino({ level: config.logLevel, redact: { paths: ['*.phone_number', '*.jid', '*.text', '*.raw_payload', '*.message', '*.password'], censor: '[REDACTED]' } })
