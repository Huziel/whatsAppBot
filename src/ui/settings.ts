import fs from 'node:fs/promises'
import path from 'node:path'
import { decryptAppSettings, encryptAppSettings } from '../settings-crypto'
import { config } from '../config'
import type { ContactProfileInput, InventoryItemInput } from '../db'
import { ValidationError } from '../errors'

export interface AppSettings {
  botName: string; businessName: string; autoReply: boolean; responseMode: 'fixed' | 'deepseek'
  responseText: string; replyDelayMs: number; saveToDatabase: boolean; deepseekApiKey: string
  deepseekModel: 'deepseek-flash' | 'deepseek-v4-pro'; aiTone: 'friendly' | 'professional' | 'formal'
  aiResponseLength: 'brief' | 'balanced' | 'detailed'; aiSystemInstructions: string
  maxRepliesPerHour: number; messageRetentionDays: number; orderReservationMinutes:number
  productCatalogImageUrl: string | null; serviceCatalogImageUrl: string | null
  transferEnabled: boolean; transferBankName: string; transferAccountHolder: string
  transferAccountNumber: string; transferClabe: string; transferInstructions: string
  appointmentsEnabled: boolean; appointmentTimeZone: string; appointmentDays: number[]
  appointmentStartTime: string; appointmentEndTime: string; appointmentDurationMinutes: number
}

export interface UiCallbacks {
  start: (settings: AppSettings) => Promise<void>
  applySettings?: (settings: AppSettings) => Promise<void>
  logout: () => Promise<void>
  sendManualMessage: (contactId: number, message: ManualMessage) => Promise<void>
  deleteContact: (contactId: number) => Promise<boolean>
  clearConversations: () => Promise<{messages:number;chats:number;turns:number}>
  status: () => { serviceStatus: string; disconnectCode: number | null; pendingWrites: number }
}

export interface ManualMessage { text:string; image:Buffer|null; mimeType:string|null }

const settingsPath = path.join(config.dataDir, 'app-settings.json')
let settingsWrite: Promise<void> = Promise.resolve()

export function validateSettings(input: any, fallbackApiKey = ''): AppSettings {
  const botName = typeof input.botName === 'string' ? input.botName.trim() : 'Asistente de WhatsApp'
  const businessName = typeof input.businessName === 'string' ? input.businessName.trim() : 'Mi negocio'
  if (!botName || botName.length > 100) throw new Error('El nombre del bot es obligatorio y admite hasta 100 caracteres')
  if (!businessName || businessName.length > 160) throw new Error('El nombre del negocio es obligatorio y admite hasta 160 caracteres')
  if (typeof input?.autoReply !== 'boolean' || typeof input?.saveToDatabase !== 'boolean') throw new Error('Las opciones deben ser booleanas')
  if (typeof input?.responseText !== 'string' || input.responseText.length > 1000 || (input.autoReply && !input.responseText.trim())) throw new Error('El texto debe tener entre 1 y 1000 caracteres')
  if (!Number.isInteger(input.replyDelayMs) || input.replyDelayMs < 1500 || input.replyDelayMs > 60_000) throw new Error('La pausa debe ser un entero entre 1500 y 60000 ms')
  const responseMode = input.responseMode ?? 'fixed'
  if (!['fixed', 'deepseek'].includes(responseMode)) throw new Error('Modo de respuesta no válido')
  const deepseekModel = input.deepseekModel ?? 'deepseek-flash'
  if (!['deepseek-flash', 'deepseek-v4-pro'].includes(deepseekModel)) throw new Error('Modelo DeepSeek no válido')
  const aiTone = input.aiTone ?? 'professional'
  if (!['friendly','professional','formal'].includes(aiTone)) throw new Error('Tono de IA no válido')
  const aiResponseLength = input.aiResponseLength ?? 'brief'
  if (!['brief','balanced','detailed'].includes(aiResponseLength)) throw new Error('Longitud de respuesta de IA no válida')
  const aiSystemInstructions = typeof input.aiSystemInstructions === 'string' ? input.aiSystemInstructions.trim() : ''
  if (aiSystemInstructions.length > 2000) throw new Error('Las instrucciones adicionales admiten hasta 2000 caracteres')
  const maxRepliesPerHour = input.maxRepliesPerHour ?? 20
  if (!Number.isInteger(maxRepliesPerHour) || maxRepliesPerHour < 1 || maxRepliesPerHour > 200) throw new Error('El límite debe ser entre 1 y 200 respuestas por contacto/hora')
  const messageRetentionDays = input.messageRetentionDays ?? 0
  if (!Number.isInteger(messageRetentionDays) || messageRetentionDays < 0 || messageRetentionDays > 3650) throw new Error('La retención debe ser entre 0 y 3650 días')
  const orderReservationMinutes=input.orderReservationMinutes??15
  if(!Number.isInteger(orderReservationMinutes)||orderReservationMinutes<5||orderReservationMinutes>1440)throw new Error('La reserva de pedidos debe durar entre 5 y 1440 minutos')
  const enteredApiKey = typeof input.deepseekApiKey === 'string' ? input.deepseekApiKey.trim() : ''
  const deepseekApiKey = input.clearDeepseekApiKey ? '' : enteredApiKey || fallbackApiKey
  if (input.autoReply && responseMode === 'deepseek' && !deepseekApiKey) throw new Error('Configura la API key de DeepSeek antes de iniciar con ese modo')
  const validateCatalogUrl = (value: unknown, label: string): string | null => {
    if (value === undefined || value === null || value === '') return null
    if (typeof value !== 'string' || value.length > 2048) throw new Error(`${label}: URL demasiado larga`)
    let url: URL
    try { url = new URL(value) } catch { throw new Error(`${label}: URL no válida`) }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error(`${label}: se requiere una URL HTTPS pública`)
    return url.toString()
  }
  const transferEnabled = input.transferEnabled ?? false
  if (typeof transferEnabled !== 'boolean') throw new Error('La opción de transferencia debe ser booleana')
  const transferBankName = typeof input.transferBankName === 'string' ? input.transferBankName.trim() : ''
  const transferAccountHolder = typeof input.transferAccountHolder === 'string' ? input.transferAccountHolder.trim() : ''
  const transferAccountNumber = typeof input.transferAccountNumber === 'string' ? input.transferAccountNumber.trim() : ''
  const transferClabe = typeof input.transferClabe === 'string' ? input.transferClabe.trim() : ''
  const transferInstructions = typeof input.transferInstructions === 'string' ? input.transferInstructions.trim() : ''
  if (transferBankName.length > 100 || transferAccountHolder.length > 160 || transferAccountNumber.length > 64 || transferInstructions.length > 1000) throw new Error('Los datos de transferencia exceden el límite de caracteres')
  if (transferClabe && !/^\d{18}$/.test(transferClabe)) throw new Error('La CLABE debe contener exactamente 18 dígitos')
  if (transferEnabled && (!transferBankName || !transferAccountHolder || (!transferClabe && !transferAccountNumber))) throw new Error('Para activar transferencia, indica banco, titular y CLABE o número de cuenta')
  const appointmentsEnabled = input.appointmentsEnabled ?? false
  if (typeof appointmentsEnabled !== 'boolean') throw new Error('La opción de citas debe ser booleana')
  const appointmentTimeZone = typeof input.appointmentTimeZone === 'string' ? input.appointmentTimeZone.trim() : 'America/Mexico_City'
  try { new Intl.DateTimeFormat('en-US', { timeZone: appointmentTimeZone }) } catch { throw new Error('La zona horaria de citas no es válida') }
  const appointmentDays: number[] = Array.isArray(input.appointmentDays) ? [...new Set<number>(input.appointmentDays)] : [1, 2, 3, 4, 5]
  if (appointmentDays.some((day: unknown) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6)) throw new Error('Selecciona días válidos (0=domingo a 6=sábado)')
  const appointmentStartTime = input.appointmentStartTime ?? '09:00'
  const appointmentEndTime = input.appointmentEndTime ?? '17:00'
  if (typeof appointmentStartTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(appointmentStartTime) || typeof appointmentEndTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(appointmentEndTime)) throw new Error('Los horarios deben usar formato HH:mm')
  const appointmentDurationMinutes = input.appointmentDurationMinutes ?? 60
  if (!Number.isInteger(appointmentDurationMinutes) || appointmentDurationMinutes < 15 || appointmentDurationMinutes > 240 || appointmentDurationMinutes % 5 !== 0) throw new Error('La duración debe ser de 15 a 240 minutos en intervalos de 5')
  if (appointmentsEnabled && (!appointmentDays.length || appointmentEndTime <= appointmentStartTime)) throw new Error('Activa al menos un día y configura un horario de cierre posterior a la apertura')
  if (appointmentsEnabled && !input.autoReply) throw new Error('Para gestionar citas, activa las respuestas automáticas')
  if (appointmentsEnabled && responseMode !== 'deepseek') throw new Error('Para gestionar citas, selecciona DeepSeek como modo de respuesta')
  return {
    botName, businessName, autoReply: input.autoReply, responseMode, responseText: input.responseText.trim(), replyDelayMs: input.replyDelayMs,
    saveToDatabase: input.saveToDatabase, deepseekApiKey, deepseekModel, aiTone, aiResponseLength, aiSystemInstructions, maxRepliesPerHour, messageRetentionDays, orderReservationMinutes,
    productCatalogImageUrl: validateCatalogUrl(input.productCatalogImageUrl, 'Imagen general de productos'),
    serviceCatalogImageUrl: validateCatalogUrl(input.serviceCatalogImageUrl, 'Imagen general de servicios'),
    transferEnabled, transferBankName, transferAccountHolder, transferAccountNumber, transferClabe, transferInstructions,
    appointmentsEnabled, appointmentTimeZone, appointmentDays, appointmentStartTime, appointmentEndTime, appointmentDurationMinutes,
  }
}

export async function loadAppSettings(fallback: AppSettings): Promise<AppSettings> {
  try {
    const stored = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    const legacySecrets = ['deepseekApiKey','transferAccountHolder','transferAccountNumber','transferClabe','transferInstructions'].some(key => typeof stored[key] === 'string' && stored[key] && !stored[key].startsWith('enc:v1:'))
    const decrypted = decryptAppSettings(stored)
    if (legacySecrets) {
      const temp = `${settingsPath}.tmp`
      await fs.writeFile(temp, JSON.stringify(encryptAppSettings(decrypted), null, 2), 'utf8')
      await fs.rename(temp, settingsPath)
    }
    return validateSettings({ ...fallback, ...decrypted }, fallback.deepseekApiKey)
  } catch (error: any) { if (error.code === 'ENOENT') return fallback; throw error }
}

export async function saveAppSettings(input: any, fallback: AppSettings): Promise<AppSettings> {
  let saved!: AppSettings
  const operation = settingsWrite.then(async () => {
    const current = await loadAppSettings(fallback)
    try{saved = validateSettings(input, current.deepseekApiKey)}
    catch(error:any){throw new ValidationError(error?.message||'Configuración no válida.','INVALID_SETTINGS')}
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    const temp = `${settingsPath}.tmp`
    await fs.writeFile(temp, JSON.stringify(encryptAppSettings(saved), null, 2), 'utf8')
    await fs.rename(temp, settingsPath)
  })
  settingsWrite = operation.then(() => undefined, () => undefined)
  await operation
  return saved
}

export function validateInventoryItem(input: any): InventoryItemInput {
  if (!['product', 'service'].includes(input?.itemType)) throw new Error('Tipo debe ser producto o servicio')
  const sku = typeof input.sku === 'string' ? input.sku.trim() : ''
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(sku)) throw new Error('El código debe tener 1-64 caracteres alfanuméricos, punto, guion o guion bajo')
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 200) throw new Error('El nombre es obligatorio y admite hasta 200 caracteres')
  if (typeof input.description !== 'string' || input.description.length > 2000) throw new Error('La descripción admite hasta 2000 caracteres')
  let imageUrl: string | null = null
  if (input.imageUrl !== null && input.imageUrl !== undefined && input.imageUrl !== '') {
    if (typeof input.imageUrl !== 'string' || input.imageUrl.length > 2048) throw new Error('La URL de imagen es demasiado larga')
    let parsed: URL
    try { parsed = new URL(input.imageUrl) } catch { throw new Error('La URL de imagen no es válida') }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) throw new Error('La imagen debe tener una URL HTTPS pública')
    imageUrl = parsed.toString()
  }
  const rawPrice = input.price === '' || input.price === null || input.price === undefined ? null : Number(input.price)
  if (rawPrice !== null && (!Number.isFinite(rawPrice) || rawPrice < 0 || rawPrice > 9_999_999_999.99)) throw new Error('El precio debe ser un número positivo válido')
  const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : ''
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('La moneda debe ser un código de 3 letras, por ejemplo MXN')
  let stockQuantity: number | null = null
  if (input.itemType === 'product' && input.stockQuantity !== null && input.stockQuantity !== '') {
    stockQuantity = Number(input.stockQuantity)
    if (!Number.isInteger(stockQuantity) || stockQuantity < 0 || stockQuantity > 4_294_967_295) throw new Error('Las existencias deben ser un entero igual o mayor que cero')
  }
  if (typeof input.isActive !== 'boolean') throw new Error('El estado activo debe ser booleano')
  return { itemType: input.itemType, sku, name, description: input.description.trim() || null, imageUrl, price: rawPrice === null ? null : rawPrice.toFixed(2), currency, stockQuantity, isActive: input.isActive }
}

export function validateContactProfile(input: any): ContactProfileInput {
  const customName=typeof input?.customName==='string'?input.customName.trim():''
  const tags=typeof input?.tags==='string'?input.tags.trim():''
  const notes=typeof input?.notes==='string'?input.notes.trim():''
  if(customName.length>160||tags.length>500||notes.length>4000)throw new Error('Nombre, etiquetas o notas exceden el límite permitido')
  return { customName:customName||null,tags:tags||null,notes:notes||null }
}
