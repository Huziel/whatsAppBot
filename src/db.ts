import mysql, { Pool, PoolConnection } from 'mysql2/promise'
import { BufferJSON } from '@whiskeysockets/baileys'
import { config } from './config'
import { Identity, resolveIdentity } from './identity'
import { logger } from './logger'
import type { PendingIntentRecord, VerifiedResult } from './conversation-flow'
import { decryptLocalValue, encryptLocalValue } from './settings-crypto'

export const pool: Pool = mysql.createPool({ ...config.db, waitForConnections: true, connectionLimit: 8, queueLimit: 0, charset: 'utf8mb4', timezone: 'Z', dateStrings: false })
pool.on('connection', connection => { connection.query("SET time_zone = '+00:00'") })

export async function assertConversationEngineSchema():Promise<void>{
  const [rows]:any=await pool.query(`SELECT COLUMN_NAME AS columnName,COLUMN_TYPE AS columnType
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='conversation_turns'
      AND COLUMN_NAME IN ('status','recovery_token','recovery_lease_until')`)
  const columns=new Map<string,string>(rows.map((row:any)=>[String(row.columnName),String(row.columnType)] as [string,string]))
  if(!columns.has('recovery_token')||!columns.has('recovery_lease_until')||!columns.get('status')?.includes("'sending'")){
    throw new Error('El esquema conversacional está desactualizado. Ejecuta npm run migrate antes de iniciar WhatsApp.')
  }
}

export interface StoredMessage {
  jid: string; lid?: string | null; phoneJid?: string | null; displayName?: string | null
  waMessageId: string; fromMe: boolean; senderJid?: string | null; messageType: string
  text: string | null; timestamp: Date; status?: string | number | null; deleted: boolean; rawPayload: unknown
}

export interface InventoryItemInput {
  itemType: 'product' | 'service'; sku: string; name: string; description: string | null; imageUrl: string | null
  price: string | null; currency: string; stockQuantity: number | null; isActive: boolean
}

export interface InventoryItem extends InventoryItemInput { id: number }
export interface CartLine { sku: string; itemType: 'product' | 'service'; itemName: string; quantity: number; unitPrice: string | null; currency: string }
export interface CartChange { sku: string; quantity: number; removeAll?: boolean }
export type CartAction = 'add' | 'remove' | 'clear' | 'show' | 'none'
export interface AppointmentRecord { id: number; startsAt: Date; endsAt: Date; serviceRequested: string | null }
export interface StoredConversationEntry { id: string; role: 'user' | 'assistant'; content: string; timestampMs: number }
export type ConversationTurnStatus = 'received'|'processing'|'action_applied'|'send_pending'|'sending'|'sent'|'failed'|'uncertain'
export interface ConversationTurnRecord { id: number; jid: string; waMessageId: string; status: ConversationTurnStatus; settingsVersion: number; outcomeKind: string | null; outboundText: string | null; outboundMessageId: string | null; sendAttempts: number }

const inventoryColumns = 'id,item_type AS itemType,sku,name,description,image_url AS imageUrl,price,currency,stock_quantity AS stockQuantity,is_active AS isActive'

function inventoryRow(row: any): InventoryItem {
  return { ...row, id: Number(row.id), imageUrl: row.imageUrl ?? null, stockQuantity: row.stockQuantity === null ? null : Number(row.stockQuantity), isActive: Boolean(row.isActive) }
}

export async function listInventoryItems(): Promise<InventoryItem[]> {
  const [rows]: any = await pool.query(`SELECT ${inventoryColumns} FROM inventory_items ORDER BY item_type,name`)
  return rows.map(inventoryRow)
}

export async function getDashboardStats(): Promise<{ contacts: number; unresolvedIdentities: number; chats: number; messages: number }> {
  const [[row]]: any = await pool.query(`SELECT
    (SELECT COUNT(*) FROM contacts) AS contacts,
    (SELECT COUNT(*) FROM contacts WHERE identity_status='unresolved') AS unresolvedIdentities,
    (SELECT COUNT(*) FROM chats) AS chats,
    (SELECT COUNT(*) FROM messages) AS messages`)
  return { contacts: Number(row.contacts), unresolvedIdentities: Number(row.unresolvedIdentities), chats: Number(row.chats), messages: Number(row.messages) }
}

export async function listActiveInventory(limit: number | null = 40): Promise<InventoryItem[]> {
  const statement = `SELECT ${inventoryColumns} FROM inventory_items WHERE is_active=1 ORDER BY item_type,name`
  const [rows]: any = limit === null
    ? await pool.query(statement)
    : await pool.execute(`${statement} LIMIT ?`, [Math.max(1, Math.min(500, Math.floor(limit)))])
  return rows.map(inventoryRow)
}

export async function createInventoryItem(item: InventoryItemInput): Promise<InventoryItem> {
  const [result]: any = await pool.execute('INSERT INTO inventory_items (item_type,sku,name,description,image_url,price,currency,stock_quantity,is_active) VALUES (?,?,?,?,?,?,?,?,?)', [item.itemType,item.sku,item.name,item.description,item.imageUrl,item.price,item.currency,item.stockQuantity,item.isActive])
  const [rows]: any = await pool.execute(`SELECT ${inventoryColumns} FROM inventory_items WHERE id=?`, [result.insertId])
  return inventoryRow(rows[0])
}

export async function updateInventoryItem(id: number, item: InventoryItemInput): Promise<InventoryItem | null> {
  await pool.execute('UPDATE inventory_items SET item_type=?,sku=?,name=?,description=?,image_url=?,price=?,currency=?,stock_quantity=?,is_active=? WHERE id=?', [item.itemType,item.sku,item.name,item.description,item.imageUrl,item.price,item.currency,item.stockQuantity,item.isActive,id])
  const [rows]: any = await pool.execute(`SELECT ${inventoryColumns} FROM inventory_items WHERE id=?`, [id])
  return rows[0] ? inventoryRow(rows[0]) : null
}

export async function deleteInventoryItem(id: number): Promise<boolean> {
  const [result]: any = await pool.execute('DELETE FROM inventory_items WHERE id=?', [id])
  return result.affectedRows > 0
}

export async function getShoppingCart(jid: string): Promise<CartLine[]> {
  const [contacts]: any = await pool.execute('SELECT c.id FROM contacts c JOIN contact_identifiers i ON i.contact_id=c.id WHERE i.jid=? LIMIT 1', [jid])
  if (!contacts[0]) return []
  const [rows]: any = await pool.execute(`SELECT ci.sku,ci.item_type AS itemType,ci.item_name AS itemName,ci.quantity,ci.unit_price AS unitPrice,ci.currency
    FROM shopping_carts c JOIN shopping_cart_items ci ON ci.cart_id=c.id WHERE c.contact_id=? ORDER BY ci.item_name`, [contacts[0].id])
  return rows.map((row: any) => ({ ...row, quantity: Number(row.quantity) }))
}

export async function applyShoppingCartAction(jid: string, action: CartAction, items: CartChange[], effectKey?: string): Promise<CartLine[]> {
  if (action === 'none') return getShoppingCart(jid)
  if (action === 'show') return getShoppingCart(jid)
  await upsertContactChat(jid)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    if (effectKey) {
      const [[stored]]: any = await conn.execute('SELECT result_json AS resultJson FROM conversation_effects WHERE effect_key=? FOR UPDATE', [effectKey])
      if (stored) {
        const result = typeof stored.resultJson === 'string' ? JSON.parse(stored.resultJson) : stored.resultJson
        await conn.commit()
        return result.cart
      }
    }
    const [[contact]]: any = await conn.query('SELECT c.id FROM contacts c JOIN contact_identifiers i ON i.contact_id=c.id WHERE i.jid=? LIMIT 1 FOR UPDATE', [jid])
    if (!contact) throw new Error('No se pudo asociar el carrito al contacto')
    await conn.query('INSERT INTO shopping_carts (contact_id) VALUES (?) ON DUPLICATE KEY UPDATE contact_id=VALUES(contact_id)', [contact.id])
    const [[cart]]: any = await conn.query('SELECT id FROM shopping_carts WHERE contact_id=? FOR UPDATE', [contact.id])
    const [beforeRows]:any=await conn.query(`SELECT sku,item_type AS itemType,item_name AS itemName,quantity,unit_price AS unitPrice,currency
      FROM shopping_cart_items WHERE cart_id=? ORDER BY item_name FOR UPDATE`,[cart.id])
    const beforeCart=beforeRows.map((row:any)=>({...row,quantity:Number(row.quantity)}))
    if (action === 'clear') await conn.query('DELETE FROM shopping_cart_items WHERE cart_id=?', [cart.id])
    if (action === 'remove') {
      for (const item of items) if (typeof item.sku === 'string'&&Number.isInteger(item.quantity)&&item.quantity>0) {
        const [[current]]:any=await conn.query('SELECT quantity FROM shopping_cart_items WHERE cart_id=? AND sku=? FOR UPDATE',[cart.id,item.sku])
        if(!current)continue
        if(item.removeAll||item.quantity>=Number(current.quantity))await conn.query('DELETE FROM shopping_cart_items WHERE cart_id=? AND sku=?',[cart.id,item.sku])
        else await conn.query('UPDATE shopping_cart_items SET quantity=quantity-? WHERE cart_id=? AND sku=?',[item.quantity,cart.id,item.sku])
      }
    }
    if (action === 'add') {
      for (const item of items) {
        if (typeof item.sku !== 'string' || !Number.isInteger(item.quantity) || item.quantity < 1) continue
        const [[product]]: any = await conn.query('SELECT id,item_type,sku,name,price,currency,stock_quantity FROM inventory_items WHERE sku=? AND is_active=1 FOR UPDATE', [item.sku])
        if (!product) continue
        const [[current]]: any = await conn.query('SELECT quantity FROM shopping_cart_items WHERE cart_id=? AND sku=? FOR UPDATE', [cart.id, product.sku])
        const currentQuantity = Number(current?.quantity ?? 0)
        const stockRemaining = product.stock_quantity === null ? 999 : Math.max(0, Number(product.stock_quantity) - currentQuantity)
        const addQuantity = Math.min(item.quantity, 100, stockRemaining, 999 - currentQuantity)
        if (addQuantity < 1) continue
        await conn.query(`INSERT INTO shopping_cart_items (cart_id,inventory_item_id,sku,item_type,item_name,quantity,unit_price,currency)
          VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE inventory_item_id=VALUES(inventory_item_id),item_type=VALUES(item_type),item_name=VALUES(item_name),quantity=VALUES(quantity),unit_price=VALUES(unit_price),currency=VALUES(currency)`,
          [cart.id, product.id, product.sku, product.item_type, product.name, currentQuantity + addQuantity, product.price, product.currency])
      }
    }
    const [rows]: any = await conn.query(`SELECT sku,item_type AS itemType,item_name AS itemName,quantity,unit_price AS unitPrice,currency
      FROM shopping_cart_items WHERE cart_id=? ORDER BY item_name`, [cart.id])
    const resultCart = rows.map((row: any) => ({ ...row, quantity: Number(row.quantity) }))
    const changed=JSON.stringify(beforeCart)!==JSON.stringify(resultCart)
    if (effectKey) await conn.execute('INSERT INTO conversation_effects (effect_key,effect_type,result_json) VALUES (?,?,?)', [effectKey,`cart:${action}`,JSON.stringify({ cart:resultCart,changed })])
    await conn.commit()
    return resultCart
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

export async function applyShoppingCartActionVerified(jid: string, action: CartAction, items: CartChange[], effectKey: string): Promise<VerifiedResult<{ cart: CartLine[]; changed: boolean }>> {
  try {
    const [[stored]]: any = await pool.execute('SELECT result_json AS resultJson FROM conversation_effects WHERE effect_key=?',[effectKey])
    if(stored){const value=typeof stored.resultJson==='string'?JSON.parse(stored.resultJson):stored.resultJson;return value.changed?{status:'success',value:{cart:value.cart,changed:true}}:{status:'rejected',message:'No se pudo aplicar el cambio solicitado al carrito.'}}
    const before = await getShoppingCart(jid)
    const cart = await applyShoppingCartAction(jid,action,items,effectKey)
    const changed = action === 'show' || JSON.stringify(before) !== JSON.stringify(cart)
    if (!changed) return { status:'rejected', message:'No se pudo aplicar el cambio solicitado al carrito.' }
    return { status:'success', value:{ cart, changed } }
  } catch {
    return { status:'infrastructure_error', message:'No pude completar la operación del carrito. Inténtalo nuevamente.' }
  }
}

export async function getUpcomingAppointments(jid: string): Promise<AppointmentRecord[]> {
  const [contacts]: any = await pool.execute('SELECT c.id FROM contacts c JOIN contact_identifiers i ON i.contact_id=c.id WHERE i.jid=? LIMIT 1', [jid])
  if (!contacts[0]) return []
  const [rows]: any = await pool.execute(`SELECT id,starts_at AS startsAt,ends_at AS endsAt,service_requested AS serviceRequested
    FROM appointments WHERE contact_id=? AND status='booked' AND starts_at>=UTC_TIMESTAMP(3) ORDER BY starts_at LIMIT 20`, [contacts[0].id])
  return rows.map((row: any) => ({ ...row, id: Number(row.id) }))
}

export async function createAppointment(jid: string, startsAt: Date, endsAt: Date, serviceRequested: string | null, effectKey?: string): Promise<{ booked: boolean; appointment?: AppointmentRecord }> {
  await upsertContactChat(jid)
  const conn = await pool.getConnection()
  let lockAcquired = false
  try {
    const [[lock]]: any = await conn.query('SELECT GET_LOCK(?,10) AS acquired', [`whatsapp-appointment-booking:${config.db.database}`])
    if (Number(lock.acquired) !== 1) throw new Error('No se pudo bloquear agenda para validar disponibilidad')
    lockAcquired = true
    await conn.beginTransaction()
    if (effectKey) {
      const [[stored]]: any = await conn.execute('SELECT result_json AS resultJson FROM conversation_effects WHERE effect_key=? FOR UPDATE', [effectKey])
      if (stored) {
        const value = typeof stored.resultJson === 'string' ? JSON.parse(stored.resultJson) : stored.resultJson
        if (value.appointment) { value.appointment.startsAt = new Date(value.appointment.startsAt); value.appointment.endsAt = new Date(value.appointment.endsAt) }
        await conn.commit()
        return value
      }
    }
    const [[contact]]: any = await conn.query('SELECT c.id FROM contacts c JOIN contact_identifiers i ON i.contact_id=c.id WHERE i.jid=? LIMIT 1 FOR UPDATE', [jid])
    if (!contact) throw new Error('No se pudo asociar la cita al contacto')
    const [conflicts]: any = await conn.query(`SELECT id FROM appointments WHERE status='booked' AND starts_at < ? AND ends_at > ? LIMIT 1 FOR UPDATE`, [endsAt, startsAt])
    if (conflicts.length) {
      const result = { booked: false }
      if (effectKey) { await conn.execute('INSERT INTO conversation_effects (effect_key,effect_type,result_json) VALUES (?,?,?)', [effectKey,'appointment:book',JSON.stringify(result)]);await conn.commit() }
      else await conn.rollback()
      return result
    }
    const [result]: any = await conn.execute('INSERT INTO appointments (contact_id,starts_at,ends_at,service_requested,status) VALUES (?,?,?,?,\'booked\')', [contact.id, startsAt, endsAt, serviceRequested])
    const booked = { booked: true, appointment: { id: Number(result.insertId), startsAt, endsAt, serviceRequested } }
    if (effectKey) await conn.execute('INSERT INTO conversation_effects (effect_key,effect_type,result_json) VALUES (?,?,?)', [effectKey,'appointment:book',JSON.stringify(booked)])
    await conn.commit()
    return booked
  } catch (error) { await conn.rollback(); throw error }
  finally {
    if (lockAcquired) await conn.query('SELECT RELEASE_LOCK(?)', [`whatsapp-appointment-booking:${config.db.database}`]).catch(() => undefined)
    conn.release()
  }
}

export async function cancelNextAppointment(jid: string): Promise<AppointmentRecord | null> {
  const [contacts]: any = await pool.execute('SELECT c.id FROM contacts c JOIN contact_identifiers i ON i.contact_id=c.id WHERE i.jid=? LIMIT 1', [jid])
  if (!contacts[0]) return null
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows]: any = await conn.execute(`SELECT id,starts_at AS startsAt,ends_at AS endsAt,service_requested AS serviceRequested
      FROM appointments WHERE contact_id=? AND status='booked' AND starts_at>=UTC_TIMESTAMP(3) ORDER BY starts_at LIMIT 1 FOR UPDATE`, [contacts[0].id])
    if (!rows.length) { await conn.commit(); return null }
    const appointment = { ...rows[0], id: Number(rows[0].id) } as AppointmentRecord
    await conn.execute('UPDATE appointments SET status=\'cancelled\' WHERE id=?', [appointment.id])
    await conn.commit()
    return appointment
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

export async function cancelAppointmentById(jid: string, appointmentId: number, effectKey: string): Promise<VerifiedResult<AppointmentRecord>> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [[stored]]: any = await conn.execute('SELECT result_json AS resultJson FROM conversation_effects WHERE effect_key=? FOR UPDATE', [effectKey])
    if (stored) {
      const value = typeof stored.resultJson === 'string' ? JSON.parse(stored.resultJson) : stored.resultJson
      if(value.status==='success'){value.value.startsAt = new Date(value.value.startsAt);value.value.endsAt = new Date(value.value.endsAt)}
      await conn.commit();return value
    }
    const [rows]: any = await conn.execute(`SELECT a.id,a.starts_at AS startsAt,a.ends_at AS endsAt,a.service_requested AS serviceRequested
      FROM appointments a JOIN contact_identifiers i ON i.contact_id=a.contact_id
      WHERE i.jid=? AND a.id=? AND a.status='booked' AND a.starts_at>=UTC_TIMESTAMP(3) LIMIT 1 FOR UPDATE`, [jid,appointmentId])
    let result: VerifiedResult<AppointmentRecord>
    if (!rows.length) result = { status:'rejected', message:'La cita seleccionada ya no está activa o no pertenece a este contacto.' }
    else {
      const appointment = { ...rows[0], id:Number(rows[0].id) } as AppointmentRecord
      await conn.execute("UPDATE appointments SET status='cancelled' WHERE id=?", [appointmentId])
      result = { status:'success', value:appointment }
    }
    await conn.execute('INSERT INTO conversation_effects (effect_key,effect_type,result_json) VALUES (?,?,?)', [effectKey,'appointment:cancel',JSON.stringify(result)])
    await conn.commit();return result
  } catch (error) { await conn.rollback();throw error } finally { conn.release() }
}

export async function rescheduleAppointmentForContact(jid: string, appointmentId: number, startsAt: Date, endsAt: Date, effectKey: string): Promise<VerifiedResult<AppointmentRecord>> {
  const conn = await pool.getConnection()
  let lockAcquired = false
  try {
    const [[lock]]: any = await conn.query('SELECT GET_LOCK(?,10) AS acquired', [`whatsapp-appointment-booking:${config.db.database}`])
    if (Number(lock.acquired)!==1) throw new Error('appointment_lock_unavailable')
    lockAcquired = true
    await conn.beginTransaction()
    const [[stored]]: any = await conn.execute('SELECT result_json AS resultJson FROM conversation_effects WHERE effect_key=? FOR UPDATE', [effectKey])
    if (stored) {
      const value = typeof stored.resultJson === 'string' ? JSON.parse(stored.resultJson) : stored.resultJson
      if (value.value) { value.value.startsAt=new Date(value.value.startsAt);value.value.endsAt=new Date(value.value.endsAt) }
      await conn.commit();return value
    }
    const [rows]: any = await conn.execute(`SELECT a.id,a.service_requested AS serviceRequested FROM appointments a JOIN contact_identifiers i ON i.contact_id=a.contact_id
      WHERE i.jid=? AND a.id=? AND a.status='booked' LIMIT 1 FOR UPDATE`, [jid,appointmentId])
    let result: VerifiedResult<AppointmentRecord>
    if (!rows.length) result={status:'rejected',message:'La cita seleccionada ya no está activa o no pertenece a este contacto.'}
    else {
      const [conflicts]: any = await conn.execute("SELECT id FROM appointments WHERE status='booked' AND id<>? AND starts_at<? AND ends_at>? LIMIT 1 FOR UPDATE", [appointmentId,endsAt,startsAt])
      if (conflicts.length) result={status:'rejected',message:'Ese horario ya está ocupado. Elige otra fecha y hora.'}
      else {
        await conn.execute('UPDATE appointments SET starts_at=?,ends_at=? WHERE id=?',[startsAt,endsAt,appointmentId])
        result={status:'success',value:{id:appointmentId,startsAt,endsAt,serviceRequested:rows[0].serviceRequested??null}}
      }
    }
    await conn.execute('INSERT INTO conversation_effects (effect_key,effect_type,result_json) VALUES (?,?,?)',[effectKey,'appointment:reschedule',JSON.stringify(result)])
    await conn.commit();return result
  } catch(error){await conn.rollback();throw error}
  finally{if(lockAcquired)await conn.query('SELECT RELEASE_LOCK(?)',[`whatsapp-appointment-booking:${config.db.database}`]).catch(()=>undefined);conn.release()}
}

export interface AppointmentListRow extends AppointmentRecord {
  contactId: number
  displayName: string | null
  phoneNumber: string | null
  status: 'booked' | 'cancelled'
}

export interface InboxChat {
  contactId: number; displayName: string | null; phoneNumber: string | null; identityStatus: string
  lastMessageAt: Date | null; lastMessageText: string | null; lastMessageType: string | null; lastMessageFromMe: boolean | null; botPaused: boolean
}

export interface ContactListRow {
  contactId: number; displayName: string | null; customName: string | null; phoneNumber: string | null
  identityStatus: string; hasLid: boolean; tags: string | null; notes: string | null; chatCount: number; messageCount: number
}

export interface ChatMessageRow {
  id: number; waMessageId: string; fromMe: boolean; messageType: string; text: string | null
  messageTimestamp: Date; status: string | null; isDeleted: boolean
}

export async function listInboxChats(page = 1, pageSize = 20, search = ''): Promise<{ rows: InboxChat[]; total: number; page: number; pageSize: number }> {
  const safePageSize = Number.isFinite(pageSize) ? Math.max(1, Math.min(100, Math.floor(pageSize))) : 20
  const requestedPage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1
  const query = search.trim()
  const where = query ? 'WHERE COALESCE(cp.custom_name,c.display_name) LIKE ? OR c.phone_number LIKE ?' : ''
  const searchParams = query ? [`%${query}%`,`%${query}%`] : []
  const [[count]]: any = await pool.execute(`SELECT COUNT(*) AS total FROM chats ch JOIN contacts c ON c.id=ch.contact_id ${where}`, searchParams)
  const total = Number(count.total)
  const pageCount = Math.max(1, Math.ceil(total / safePageSize))
  const safePage = Math.min(requestedPage, pageCount)
  const offset = (safePage - 1) * safePageSize
  const [rows]: any = await pool.execute(`SELECT c.id AS contactId,COALESCE(cp.custom_name,c.display_name,CONCAT('Contacto #',c.id)) AS displayName,c.phone_number AS phoneNumber,c.identity_status AS identityStatus,
      ch.id AS chatId,ch.last_message_at AS lastMessageAt,COALESCE(cs.bot_paused,0) AS botPaused
    FROM chats ch JOIN contacts c ON c.id=ch.contact_id
    LEFT JOIN contact_profiles cp ON cp.contact_id=c.id
    LEFT JOIN chat_settings cs ON cs.contact_id=c.id
    ${where} ORDER BY ch.last_message_at DESC,c.id DESC LIMIT ? OFFSET ?`, [...searchParams,safePageSize,offset])
  return {
    rows: await Promise.all(rows.map(async (row: any) => {
      const [latestRows]: any = await pool.execute('SELECT text,message_type AS messageType,from_me AS fromMe FROM messages WHERE chat_id=? ORDER BY message_timestamp DESC,id DESC LIMIT 1', [row.chatId])
      const latest = latestRows[0]
      return { ...row, contactId: Number(row.contactId), botPaused: Boolean(row.botPaused), lastMessageText: latest?.text ?? null, lastMessageType: latest?.messageType ?? null, lastMessageFromMe: latest ? Boolean(latest.fromMe) : null }
    })),
    total, page: safePage, pageSize: safePageSize,
  }
}

export async function listContactMessages(contactId: number, limit = 100): Promise<ChatMessageRow[]> {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)))
  const [rows]: any = await pool.execute(`SELECT m.id,m.wa_message_id AS waMessageId,m.from_me AS fromMe,m.message_type AS messageType,m.text,m.message_timestamp AS messageTimestamp,m.status,m.is_deleted AS isDeleted
    FROM messages m JOIN chats ch ON ch.id=m.chat_id WHERE ch.contact_id=? ORDER BY m.message_timestamp DESC,m.id DESC LIMIT ?`, [contactId,boundedLimit])
  return rows.reverse().map((row: any) => ({ ...row, id: Number(row.id), fromMe: Boolean(row.fromMe), isDeleted: Boolean(row.isDeleted) }))
}

export async function listContacts(page = 1, pageSize = 20, search = ''): Promise<{ rows: ContactListRow[]; total: number; page: number; pageSize: number }> {
  const safePageSize = Number.isFinite(pageSize) ? Math.max(1, Math.min(100, Math.floor(pageSize))) : 20
  const requestedPage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1
  const query = search.trim()
  const where = query ? 'WHERE COALESCE(cp.custom_name,c.display_name) LIKE ? OR c.phone_number LIKE ? OR cp.tags LIKE ?' : ''
  const params = query ? [`%${query}%`,`%${query}%`,`%${query}%`] : []
  const [[count]]: any = await pool.execute(`SELECT COUNT(*) AS total FROM contacts c LEFT JOIN contact_profiles cp ON cp.contact_id=c.id ${where}`, params)
  const total = Number(count.total)
  const pageCount = Math.max(1, Math.ceil(total / safePageSize))
  const safePage = Math.min(requestedPage, pageCount)
  const [rows]: any = await pool.execute(`SELECT c.id AS contactId,COALESCE(cp.custom_name,c.display_name,CONCAT('Contacto #',c.id)) AS displayName,cp.custom_name AS customName,
      c.phone_number AS phoneNumber,c.identity_status AS identityStatus,EXISTS(SELECT 1 FROM contact_identifiers ci WHERE ci.contact_id=c.id AND ci.identifier_type='lid') AS hasLid,cp.tags,cp.notes,
      (SELECT COUNT(*) FROM chats ch WHERE ch.contact_id=c.id) AS chatCount,
      (SELECT COUNT(*) FROM messages m JOIN chats ch ON ch.id=m.chat_id WHERE ch.contact_id=c.id) AS messageCount
    FROM contacts c LEFT JOIN contact_profiles cp ON cp.contact_id=c.id ${where}
    ORDER BY (cp.custom_name IS NULL AND c.display_name IS NULL),COALESCE(cp.custom_name,c.display_name),c.id LIMIT ? OFFSET ?`, [...params,safePageSize,(safePage-1)*safePageSize])
  return { rows: rows.map((row: any) => ({ ...row, contactId: Number(row.contactId), hasLid: Boolean(row.hasLid), chatCount: Number(row.chatCount), messageCount: Number(row.messageCount) })), total, page: safePage, pageSize: safePageSize }
}

export interface ContactProfileInput { customName: string | null; tags: string | null; notes: string | null }

export async function createManualContact(phoneNumber: string, profile: ContactProfileInput): Promise<number> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const jid = `${phoneNumber}@s.whatsapp.net`
    const [result]: any = await conn.execute('INSERT INTO contacts (phone_number,display_name,identity_status) VALUES (?,NULL,\'resolved\')', [phoneNumber])
    await conn.execute('INSERT INTO contact_identifiers (contact_id,jid,identifier_type) VALUES (?, ?, \'pn\')', [result.insertId,jid])
    await conn.execute('INSERT INTO contact_profiles (contact_id,custom_name,tags,notes) VALUES (?,?,?,?)', [result.insertId,profile.customName,profile.tags,profile.notes])
    await conn.commit()
    return Number(result.insertId)
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

export async function updateContactProfile(contactId: number, profile: ContactProfileInput): Promise<boolean> {
  const [[contact]]: any = await pool.execute('SELECT id FROM contacts WHERE id=?', [contactId])
  if (!contact) return false
  await pool.execute(`INSERT INTO contact_profiles (contact_id,custom_name,tags,notes) VALUES (?,?,?,?)
    ON DUPLICATE KEY UPDATE custom_name=VALUES(custom_name),tags=VALUES(tags),notes=VALUES(notes)`, [contactId,profile.customName,profile.tags,profile.notes])
  return true
}

export async function setChatBotPaused(contactId: number, paused: boolean): Promise<boolean> {
  const [[contact]]: any = await pool.execute('SELECT id FROM contacts WHERE id=?', [contactId])
  if (!contact) return false
  await pool.execute('INSERT INTO chat_settings (contact_id,bot_paused) VALUES (?,?) ON DUPLICATE KEY UPDATE bot_paused=VALUES(bot_paused)', [contactId,paused])
  return true
}

export async function isChatBotPaused(jid: string): Promise<boolean> {
  const [[row]]: any = await pool.execute('SELECT cs.bot_paused FROM chat_settings cs JOIN contact_identifiers i ON i.contact_id=cs.contact_id WHERE i.jid=? LIMIT 1', [jid])
  return Boolean(row?.bot_paused)
}

export async function getContactJid(contactId: number): Promise<string | null> {
  const [rows]: any = await pool.execute(`SELECT jid FROM contact_identifiers WHERE contact_id=? ORDER BY CASE identifier_type WHEN 'pn' THEN 0 ELSE 1 END LIMIT 1`, [contactId])
  return rows[0]?.jid ?? null
}

export interface ShoppingCartSummary { contactId: number; displayName: string | null; phoneNumber: string | null; items: CartLine[] }

export async function listShoppingCarts(): Promise<ShoppingCartSummary[]> {
  const [rows]: any = await pool.query(`SELECT c.id AS contactId,COALESCE(cp.custom_name,c.display_name,CONCAT('Contacto #',c.id)) AS displayName,c.phone_number AS phoneNumber,
      ci.sku,ci.item_type AS itemType,ci.item_name AS itemName,ci.quantity,ci.unit_price AS unitPrice,ci.currency
    FROM shopping_carts sc JOIN contacts c ON c.id=sc.contact_id LEFT JOIN contact_profiles cp ON cp.contact_id=c.id JOIN shopping_cart_items ci ON ci.cart_id=sc.id
    ORDER BY c.id,ci.item_name`)
  const carts = new Map<number, ShoppingCartSummary>()
  for (const row of rows) {
    const contactId = Number(row.contactId)
    let cart = carts.get(contactId)
    if (!cart) { cart = { contactId, displayName: row.displayName, phoneNumber: row.phoneNumber, items: [] }; carts.set(contactId, cart) }
    cart.items.push({ sku: row.sku, itemType: row.itemType, itemName: row.itemName, quantity: Number(row.quantity), unitPrice: row.unitPrice, currency: row.currency })
  }
  return [...carts.values()]
}

export async function createOrderFromCart(contactId: number): Promise<number> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [[cart]]: any = await conn.query('SELECT id FROM shopping_carts WHERE contact_id=? FOR UPDATE', [contactId])
    if (!cart) throw new Error('Este contacto no tiene carrito')
    const [rows]: any = await conn.query('SELECT inventory_item_id,sku,item_type,item_name,quantity,unit_price,currency FROM shopping_cart_items WHERE cart_id=? FOR UPDATE', [cart.id])
    if (!rows.length) throw new Error('El carrito está vacío')
    const currencies = new Set(rows.map((row: any) => row.currency))
    const allPriced = rows.every((row: any) => row.unit_price !== null)
    const currency = currencies.size === 1 ? rows[0].currency : null
    const total = allPriced && currency ? rows.reduce((sum: number, row: any) => sum + Number(row.unit_price) * Number(row.quantity), 0).toFixed(2) : null
    const [orderResult]: any = await conn.execute('INSERT INTO orders (contact_id,status,total,currency) VALUES (?,\'pending\',?,?)', [contactId,total,currency])
    for (const row of rows) await conn.execute('INSERT INTO order_items (order_id,inventory_item_id,sku,item_type,item_name,quantity,unit_price,currency) VALUES (?,?,?,?,?,?,?,?)', [orderResult.insertId,row.inventory_item_id,row.sku,row.item_type,row.item_name,row.quantity,row.unit_price,row.currency])
    await conn.query('DELETE FROM shopping_cart_items WHERE cart_id=?', [cart.id])
    await conn.commit()
    return Number(orderResult.insertId)
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

export async function listOrders(): Promise<any[]> {
  const [rows]: any = await pool.query(`SELECT o.id AS orderId,o.contact_id AS contactId,o.status,o.total,o.currency,o.created_at AS createdAt,
      COALESCE(cp.custom_name,c.display_name,CONCAT('Contacto #',c.id)) AS displayName,c.phone_number AS phoneNumber,oi.sku,oi.item_type AS itemType,oi.item_name AS itemName,oi.quantity,oi.unit_price AS unitPrice,oi.currency AS itemCurrency
    FROM orders o JOIN contacts c ON c.id=o.contact_id LEFT JOIN contact_profiles cp ON cp.contact_id=c.id LEFT JOIN order_items oi ON oi.order_id=o.id
    ORDER BY o.created_at DESC,oi.id LIMIT 1000`)
  const orders = new Map<number, any>()
  for (const row of rows) {
    const id = Number(row.orderId)
    let order = orders.get(id)
    if (!order) { order = { id, contactId: Number(row.contactId), status: row.status, total: row.total, currency: row.currency, createdAt: row.createdAt, displayName: row.displayName, phoneNumber: row.phoneNumber, items: [] }; orders.set(id, order) }
    if (row.sku) order.items.push({ sku: row.sku, itemType: row.itemType, itemName: row.itemName, quantity: Number(row.quantity), unitPrice: row.unitPrice, currency: row.itemCurrency })
  }
  return [...orders.values()]
}

export async function listOrdersForContact(jid:string):Promise<Array<{id:number;status:string;total:string|null;currency:string|null}>>{
  const [rows]:any=await pool.execute(`SELECT o.id,o.status,o.total,o.currency FROM orders o
    JOIN contact_identifiers i ON i.contact_id=o.contact_id WHERE i.jid=? ORDER BY o.created_at DESC LIMIT 10`,[jid])
  return rows.map((row:any)=>({...row,id:Number(row.id),total:row.total===null?null:String(row.total),currency:row.currency??null}))
}

export async function setOrderStatus(orderId: number, status: 'confirmed' | 'cancelled'): Promise<boolean> {
  const [result]: any = await pool.execute('UPDATE orders SET status=? WHERE id=? AND status=\'pending\'', [status,orderId])
  return result.affectedRows > 0
}

export async function setAppointmentStatus(appointmentId: number, status: 'booked' | 'cancelled'): Promise<boolean> {
  const [result]: any = await pool.execute('UPDATE appointments SET status=? WHERE id=?', [status,appointmentId])
  return result.affectedRows > 0
}

export async function rescheduleAppointment(appointmentId: number, startsAt: Date, endsAt: Date): Promise<boolean> {
  const conn = await pool.getConnection()
  let lockAcquired = false
  try {
    await conn.beginTransaction()
    const [[lock]]: any = await conn.query('SELECT GET_LOCK(?,10) AS acquired', [`whatsapp-appointment-booking:${config.db.database}`])
    if (Number(lock.acquired) !== 1) throw new Error('No se pudo bloquear agenda para validar disponibilidad')
    lockAcquired = true
    const [[appointment]]: any = await conn.query('SELECT id FROM appointments WHERE id=? AND status=\'booked\' FOR UPDATE', [appointmentId])
    if (!appointment) { await conn.commit(); return false }
    const [conflicts]: any = await conn.execute(`SELECT id FROM appointments WHERE status='booked' AND id<>? AND starts_at < ? AND ends_at > ? LIMIT 1 FOR UPDATE`, [appointmentId,endsAt,startsAt])
    if (conflicts.length) { await conn.rollback(); return false }
    await conn.execute('UPDATE appointments SET starts_at=?,ends_at=? WHERE id=?', [startsAt,endsAt,appointmentId])
    await conn.commit()
    return true
  } catch (error) { await conn.rollback(); throw error }
  finally {
    if (lockAcquired) await conn.query('SELECT RELEASE_LOCK(?)', [`whatsapp-appointment-booking:${config.db.database}`]).catch(() => undefined)
    conn.release()
  }
}

function conversationTurnRow(row: any): ConversationTurnRecord {
  return { id:Number(row.id),jid:row.jid,waMessageId:row.waMessageId,status:row.status,settingsVersion:Number(row.settingsVersion),outcomeKind:row.outcomeKind??null,outboundText:row.outboundText?decryptLocalValue(row.outboundText):null,outboundMessageId:row.outboundMessageId??null,sendAttempts:Number(row.sendAttempts) }
}

export async function claimConversationTurn(jid: string, waMessageId: string, settingsVersion: number): Promise<{ claimed: boolean; turn: ConversationTurnRecord }> {
  const [insert]: any = await pool.execute(`INSERT IGNORE INTO conversation_turns (jid,wa_message_id,status,settings_version) VALUES (?,?,'processing',?)`,[jid,waMessageId,settingsVersion])
  const claimed=insert.affectedRows>0
  const [[row]]: any = await pool.execute(`SELECT id,jid,wa_message_id AS waMessageId,status,settings_version AS settingsVersion,outcome_kind AS outcomeKind,
    outbound_text AS outboundText,outbound_message_id AS outboundMessageId,send_attempts AS sendAttempts FROM conversation_turns WHERE jid=? AND wa_message_id=?`,[jid,waMessageId])
  return {claimed,turn:conversationTurnRow(row)}
}

export async function prepareConversationReply(turnId: number, outcomeKind: string, text: string, outboundMessageId: string, actionApplied=false, recoveryToken?:string): Promise<boolean> {
  const ownership=recoveryToken?' AND recovery_token=? AND recovery_lease_until>=UTC_TIMESTAMP(3)':' AND recovery_token IS NULL'
  const allowed=actionApplied?"('processing','action_applied')":"('received','processing','action_applied')"
  const [result]:any=await pool.execute(`UPDATE conversation_turns SET status='send_pending',outcome_kind=?,outbound_text=?,outbound_message_id=?,last_error_code=NULL WHERE id=? AND status IN ${allowed}${ownership}`,
    recoveryToken?[outcomeKind,encryptLocalValue(text),outboundMessageId,turnId,recoveryToken]:[outcomeKind,encryptLocalValue(text),outboundMessageId,turnId])
  return result.affectedRows===1
}

export async function markConversationTurnSent(turnId: number,recoveryToken?:string): Promise<void> {
  await pool.execute(`UPDATE conversation_turns SET status='sent',send_attempts=send_attempts+1,last_error_code=NULL,recovery_token=NULL,recovery_lease_until=NULL WHERE id=? AND status='sending'${recoveryToken?' AND recovery_token=?':' AND recovery_token IS NULL'}`,recoveryToken?[turnId,recoveryToken]:[turnId])
}

export async function markConversationTurnUncertain(turnId: number, code='send_uncertain',recoveryToken?:string): Promise<void> {
  await pool.execute(`UPDATE conversation_turns SET status='uncertain',send_attempts=send_attempts+1,last_error_code=?,recovery_token=NULL,recovery_lease_until=NULL WHERE id=? AND status='sending'${recoveryToken?' AND recovery_token=?':' AND recovery_token IS NULL'}`,recoveryToken?[code.slice(0,80),turnId,recoveryToken]:[code.slice(0,80),turnId])
}

export async function markConversationTurnSentByOutboundId(outboundMessageId:string):Promise<boolean>{
  const [result]:any=await pool.execute("UPDATE conversation_turns SET status='sent',last_error_code=NULL,recovery_token=NULL,recovery_lease_until=NULL WHERE outbound_message_id=? AND status IN ('send_pending','sending','uncertain')",[outboundMessageId])
  return result.affectedRows>0
}

export async function markConversationTurnFailed(turnId: number, code: string,recoveryToken?:string): Promise<void> {
  await pool.execute(`UPDATE conversation_turns SET status='failed',last_error_code=?,recovery_token=NULL,recovery_lease_until=NULL WHERE id=?${recoveryToken?' AND recovery_token=? AND recovery_lease_until>=UTC_TIMESTAMP(3)':' AND recovery_token IS NULL'}`,recoveryToken?[code.slice(0,80),turnId,recoveryToken]:[code.slice(0,80),turnId])
}

export async function beginConversationTurnSend(turnId:number,recoveryToken?:string):Promise<boolean>{
  const sql=recoveryToken
    ?"UPDATE conversation_turns SET status='sending',updated_at=UTC_TIMESTAMP(3) WHERE id=? AND status='send_pending' AND recovery_token=? AND recovery_lease_until>=UTC_TIMESTAMP(3)"
    :"UPDATE conversation_turns SET status='sending',updated_at=UTC_TIMESTAMP(3) WHERE id=? AND status='send_pending' AND recovery_token IS NULL"
  const [result]:any=await pool.execute(sql,recoveryToken?[turnId,recoveryToken]:[turnId])
  return result.affectedRows===1
}

export async function deferConversationTurnSend(turnId:number,recoveryToken?:string):Promise<void>{
  await pool.execute(`UPDATE conversation_turns SET status='send_pending',recovery_token=NULL,recovery_lease_until=NULL WHERE id=? AND status='sending'${recoveryToken?' AND recovery_token=?':' AND recovery_token IS NULL'}`,recoveryToken?[turnId,recoveryToken]:[turnId])
}

export async function releaseRecoveryClaim(turnId:number,recoveryToken:string):Promise<void>{
  await pool.execute('UPDATE conversation_turns SET recovery_token=NULL,recovery_lease_until=NULL WHERE id=? AND recovery_token=?',[turnId,recoveryToken])
}

export async function markStaleSendingUncertain():Promise<number>{
  const [result]:any=await pool.execute("UPDATE conversation_turns SET status='uncertain',last_error_code='send_interrupted',recovery_token=NULL,recovery_lease_until=NULL WHERE status='sending' AND updated_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE)")
  return Number(result.affectedRows)
}

export async function resumeConversationTurn(turnId:number,settingsVersion:number,recoveryToken?:string):Promise<boolean>{
  const [result]:any=await pool.execute(`UPDATE conversation_turns SET status='processing',settings_version=?,last_error_code=NULL WHERE id=? AND status IN ('received','processing')${recoveryToken?' AND recovery_token=? AND recovery_lease_until>=UTC_TIMESTAMP(3)':' AND recovery_token IS NULL'}`,recoveryToken?[settingsVersion,turnId,recoveryToken]:[settingsVersion,turnId])
  return result.affectedRows===1
}

export async function getRecoveryHighWaterMark():Promise<number>{
  const [[row]]:any=await pool.query('SELECT COALESCE(MAX(id),0) AS throughId FROM conversation_turns')
  return Number(row.throughId)
}

export async function claimRecoverableConversationTurnsPage(afterId:number,throughId:number,limit:number,recoveryToken:string,leaseSeconds=120,minimumAgeSeconds=300):Promise<{items:ConversationTurnRecord[];nextCursor:number;done:boolean}>{
  const bounded=Math.max(1,Math.min(500,Math.floor(limit)))
  const lease=Math.max(30,Math.min(600,Math.floor(leaseSeconds)))
  const minimumAge=Math.max(0,Math.min(3600,Math.floor(minimumAgeSeconds)))
  const conn=await pool.getConnection()
  try{
    await conn.beginTransaction()
    const [scanned]:any=await conn.execute(`SELECT id,status FROM conversation_turns WHERE id>? AND id<=? AND updated_at<=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL ? SECOND) ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED`,[afterId,throughId,minimumAge,bounded])
    if(!scanned.length){await conn.commit();return {items:[],nextCursor:throughId,done:true}}
    const nextCursor=Number(scanned.at(-1).id)
    const eligibleIds=scanned.filter((row:any)=>['received','processing','action_applied','send_pending'].includes(row.status)).map((row:any)=>Number(row.id))
    if(eligibleIds.length){await conn.query(`UPDATE conversation_turns SET recovery_token=?,recovery_lease_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? SECOND)
      WHERE id IN (${eligibleIds.map(()=>'?').join(',')}) AND status IN ('received','processing','action_applied','send_pending')
      AND (recovery_token IS NULL OR recovery_lease_until<UTC_TIMESTAMP(3))`,[recoveryToken,lease,...eligibleIds])}
    const [rows]:any=eligibleIds.length?await conn.query(`SELECT id,jid,wa_message_id AS waMessageId,status,settings_version AS settingsVersion,outcome_kind AS outcomeKind,
      outbound_text AS outboundText,outbound_message_id AS outboundMessageId,send_attempts AS sendAttempts FROM conversation_turns
      WHERE recovery_token=? AND id IN (${eligibleIds.map(()=>'?').join(',')}) ORDER BY id`,[recoveryToken,...eligibleIds]):[[]]
    await conn.commit()
    return {items:rows.map(conversationTurnRow),nextCursor,done:nextCursor>=throughId}
  }catch(error){await conn.rollback();throw error}finally{conn.release()}
}

export async function getPendingIntent(jid: string): Promise<PendingIntentRecord | null> {
  const [[row]]: any = await pool.execute('SELECT intent_kind AS intentKind,payload,source_message_id AS sourceMessageId FROM pending_intents WHERE jid=? AND expires_at>UTC_TIMESTAMP(3)',[jid])
  if(!row){await pool.execute('DELETE FROM pending_intents WHERE jid=?',[jid]);return null}
  const payload=typeof row.payload==='string'?JSON.parse(row.payload):row.payload
  return {intent:{...payload,kind:row.intentKind},sourceMessageId:row.sourceMessageId}
}

export async function savePendingIntent(jid: string, record: PendingIntentRecord): Promise<void> {
  await pool.execute(`INSERT INTO pending_intents (jid,intent_kind,payload,expires_at,source_message_id) VALUES (?,?,?,?,?)
    ON DUPLICATE KEY UPDATE intent_kind=VALUES(intent_kind),payload=VALUES(payload),expires_at=VALUES(expires_at),source_message_id=VALUES(source_message_id)`,
  [jid,record.intent.kind,JSON.stringify(record.intent),new Date(record.intent.expiresAt),record.sourceMessageId])
}

export async function clearPendingIntent(jid: string): Promise<void> { await pool.execute('DELETE FROM pending_intents WHERE jid=?',[jid]) }

export async function clearPendingIntentBySource(jid:string,sourceMessageId:string):Promise<void>{
  await pool.execute('DELETE FROM pending_intents WHERE jid=? AND source_message_id=?',[jid,sourceMessageId])
}

export async function getConversationEffect(turnId:number):Promise<{effectKey:string;effectType:string;result:any}|null>{
  const [rows]:any=await pool.execute('SELECT effect_key AS effectKey,effect_type AS effectType,result_json AS resultJson FROM conversation_effects WHERE effect_key LIKE ? ORDER BY created_at LIMIT 1',[`turn:${turnId}:%`])
  if(!rows.length)return null
  return {effectKey:rows[0].effectKey,effectType:rows[0].effectType,result:typeof rows[0].resultJson==='string'?JSON.parse(rows[0].resultJson):rows[0].resultJson}
}

export async function exportContactData(contactId: number): Promise<Record<string, unknown> | null> {
  const [[contact]]: any = await pool.execute('SELECT c.id,c.phone_number AS phoneNumber,c.display_name AS displayName,c.identity_status AS identityStatus,c.created_at AS createdAt,cp.custom_name AS customName,cp.tags,cp.notes FROM contacts c LEFT JOIN contact_profiles cp ON cp.contact_id=c.id WHERE c.id=?', [contactId])
  if (!contact) return null
  const [identifiers]: any = await pool.execute('SELECT jid,identifier_type AS identifierType,created_at AS createdAt FROM contact_identifiers WHERE contact_id=?', [contactId])
  const [messages]: any = await pool.execute(`SELECT m.wa_message_id AS waMessageId,m.from_me AS fromMe,m.sender_jid AS senderJid,m.message_type AS messageType,m.text,m.message_timestamp AS messageTimestamp,m.status,m.is_deleted AS isDeleted,m.created_at AS importedAt
    FROM messages m JOIN chats ch ON ch.id=m.chat_id WHERE ch.contact_id=? ORDER BY m.message_timestamp`, [contactId])
  const [appointments]: any = await pool.execute('SELECT starts_at AS startsAt,ends_at AS endsAt,service_requested AS serviceRequested,status,created_at AS createdAt FROM appointments WHERE contact_id=? ORDER BY starts_at', [contactId])
  const [orders]: any = await pool.execute('SELECT id,status,total,currency,created_at AS createdAt FROM orders WHERE contact_id=? ORDER BY created_at', [contactId])
  const [orderItems]: any = await pool.execute('SELECT oi.order_id AS orderId,oi.sku,oi.item_type AS itemType,oi.item_name AS itemName,oi.quantity,oi.unit_price AS unitPrice,oi.currency FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.contact_id=? ORDER BY oi.order_id,oi.id', [contactId])
  const [cartItems]: any = await pool.execute('SELECT ci.sku,ci.item_name AS itemName,ci.item_type AS itemType,ci.quantity,ci.unit_price AS unitPrice,ci.currency FROM shopping_carts sc JOIN shopping_cart_items ci ON ci.cart_id=sc.id WHERE sc.contact_id=?', [contactId])
  const jids=identifiers.map((item:any)=>item.jid)
  const conversationTurns:any[]=[]
  const pendingIntents:any[]=[]
  const conversationEffects:any[]=[]
  for(const jid of jids){
    const [turns]:any=await pool.execute(`SELECT id,jid,wa_message_id AS waMessageId,status,settings_version AS settingsVersion,outcome_kind AS outcomeKind,outbound_text AS outboundText,outbound_message_id AS outboundMessageId,send_attempts AS sendAttempts,created_at AS createdAt FROM conversation_turns WHERE jid=? ORDER BY id`,[jid])
    for(const turn of turns){
      conversationTurns.push({...turn,outboundText:turn.outboundText?decryptLocalValue(turn.outboundText):null})
      const [effects]:any=await pool.execute('SELECT effect_key AS effectKey,effect_type AS effectType,result_json AS result,created_at AS createdAt FROM conversation_effects WHERE effect_key LIKE ? ORDER BY created_at',[`turn:${turn.id}:%`])
      conversationEffects.push(...effects)
    }
    const [pending]:any=await pool.execute('SELECT intent_kind AS intentKind,payload,expires_at AS expiresAt,source_message_id AS sourceMessageId,created_at AS createdAt FROM pending_intents WHERE jid=?',[jid])
    pendingIntents.push(...pending)
  }
  return { contact, identifiers, messages, appointments, orders, orderItems, cartItems, conversationTurns, conversationEffects, pendingIntents }
}

export async function getContactIdentifiers(contactId:number):Promise<Array<{jid:string}>>{
  const [rows]:any=await pool.execute('SELECT jid FROM contact_identifiers WHERE contact_id=? ORDER BY jid',[contactId])
  return rows
}

export async function deleteContactData(contactId: number): Promise<boolean> {
  const conn=await pool.getConnection()
  try{
    await conn.beginTransaction()
    const [identifiers]:any=await conn.execute('SELECT jid FROM contact_identifiers WHERE contact_id=? FOR UPDATE',[contactId])
    for(const {jid} of identifiers){
      const [turns]:any=await conn.execute('SELECT id FROM conversation_turns WHERE jid=? FOR UPDATE',[jid])
      for(const turn of turns)await conn.execute('DELETE FROM conversation_effects WHERE effect_key LIKE ?',[`turn:${turn.id}:%`])
      await conn.execute('DELETE FROM pending_intents WHERE jid=?',[jid])
      await conn.execute('DELETE FROM conversation_turns WHERE jid=?',[jid])
    }
    const [result]:any=await conn.execute('DELETE FROM contacts WHERE id=?',[contactId])
    await conn.commit()
    return result.affectedRows>0
  }catch(error){await conn.rollback();throw error}finally{conn.release()}
}

export const TERMINAL_TURN_RETENTION_DAYS=90

export async function deleteMessagesOlderThan(days: number,batchSize=500,maxBatches=20): Promise<number> {
  if(!Number.isInteger(days)||days<1||days>3650)throw new Error('message_retention_days_invalid')
  const boundedBatch=Math.max(1,Math.min(1000,Math.floor(batchSize))),boundedBatches=Math.max(1,Math.min(100,Math.floor(maxBatches)))
  let total=0
  for(let batch=0;batch<boundedBatches;batch++){
    const conn=await pool.getConnection()
    try{
      await conn.beginTransaction()
      const [rows]:any=await conn.execute('SELECT id FROM messages WHERE message_timestamp<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL ? DAY) ORDER BY id LIMIT ? FOR UPDATE',[days,boundedBatch])
      if(!rows.length){await conn.commit();break}
      const ids=rows.map((row:any)=>Number(row.id))
      const [result]:any=await conn.query(`DELETE FROM messages WHERE id IN (${ids.map(()=>'?').join(',')})`,ids)
      total+=Number(result.affectedRows);await conn.commit()
      if(rows.length<boundedBatch)break
    }catch(error){await conn.rollback();throw error}finally{conn.release()}
  }
  return total
}

export async function cleanupOperationalRecords(retentionDays=TERMINAL_TURN_RETENTION_DAYS,batchSize=500,maxBatches=20):Promise<{turns:number;effects:number;pendingIntents:number}>{
  if(!Number.isInteger(retentionDays)||retentionDays<1||retentionDays>3650)throw new Error('operational_retention_days_invalid')
  const boundedBatch=Math.max(1,Math.min(1000,Math.floor(batchSize)))
  const boundedBatches=Math.max(1,Math.min(100,Math.floor(maxBatches)))
  let turns=0,effects=0,pendingIntents=0
  for(let batch=0;batch<boundedBatches;batch++){
    const conn=await pool.getConnection()
    try{
      await conn.beginTransaction()
      if(batch===0){const [expired]:any=await conn.execute('DELETE FROM pending_intents WHERE expires_at<UTC_TIMESTAMP(3)');pendingIntents=Number(expired.affectedRows)}
      const [rows]:any=await conn.execute(`SELECT id FROM conversation_turns
        WHERE status IN ('sent','failed') AND updated_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL ? DAY)
        ORDER BY id LIMIT ? FOR UPDATE`,[retentionDays,boundedBatch])
      if(!rows.length){await conn.commit();break}
      for(const row of rows){const [removed]:any=await conn.execute('DELETE FROM conversation_effects WHERE effect_key LIKE ?',[`turn:${row.id}:%`]);effects+=Number(removed.affectedRows)}
      const ids=rows.map((row:any)=>Number(row.id))
      const [removedTurns]:any=await conn.query(`DELETE FROM conversation_turns WHERE id IN (${ids.map(()=>'?').join(',')})`,ids)
      turns+=Number(removedTurns.affectedRows)
      await conn.commit()
      if(rows.length<boundedBatch)break
    }catch(error){await conn.rollback();throw error}finally{conn.release()}
  }
  return {turns,effects,pendingIntents}
}

export async function clearAllConversationHistory():Promise<{messages:number;chats:number;turns:number;effects:number;pendingIntents:number}>{
  const conn=await pool.getConnection()
  try{
    await conn.beginTransaction()
    const [[counts]]:any=await conn.query(`SELECT
      (SELECT COUNT(*) FROM messages) AS messages,
      (SELECT COUNT(*) FROM chats) AS chats,
      (SELECT COUNT(*) FROM conversation_turns) AS turns,
      (SELECT COUNT(*) FROM conversation_effects) AS effects,
      (SELECT COUNT(*) FROM pending_intents) AS pendingIntents`)
    await conn.query('DELETE FROM conversation_effects')
    await conn.query('DELETE FROM pending_intents')
    await conn.query('DELETE FROM conversation_turns')
    await conn.query('DELETE FROM messages')
    await conn.query('DELETE FROM chats')
    await conn.commit()
    return {messages:Number(counts.messages),chats:Number(counts.chats),turns:Number(counts.turns),effects:Number(counts.effects),pendingIntents:Number(counts.pendingIntents)}
  }catch(error){await conn.rollback();throw error}finally{conn.release()}
}

export async function listAppointments(): Promise<AppointmentListRow[]> {
  const [rows]: any = await pool.query(`SELECT a.id,a.contact_id AS contactId,COALESCE(cp.custom_name,c.display_name,CONCAT('Contacto #',c.id)) AS displayName,c.phone_number AS phoneNumber,
    a.starts_at AS startsAt,a.ends_at AS endsAt,a.service_requested AS serviceRequested,a.status
    FROM appointments a JOIN contacts c ON c.id=a.contact_id LEFT JOIN contact_profiles cp ON cp.contact_id=c.id ORDER BY a.starts_at DESC`)
  return rows.map((row: any) => ({ ...row, id: Number(row.id), contactId: Number(row.contactId) }))
}

export async function getRecentConversation(jid: string, currentMessageId: string, limit = 12): Promise<StoredConversationEntry[]> {
  const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit)))
  const [rows]: any = await pool.execute(`SELECT m.wa_message_id AS id,m.from_me,m.text,m.message_timestamp AS messageTimestamp
    FROM messages m JOIN chats ch ON ch.id=m.chat_id JOIN contact_identifiers i ON i.contact_id=ch.contact_id
    WHERE i.jid=? AND m.wa_message_id<>? AND m.is_deleted=0 AND m.text IS NOT NULL
    ORDER BY m.message_timestamp DESC LIMIT ?`, [jid,currentMessageId,boundedLimit])
  return rows.reverse().map((row: any) => ({
    id: String(row.id), role: row.from_me ? 'assistant' : 'user', content: String(row.text),
    timestampMs: new Date(row.messageTimestamp).getTime(),
  }))
}

async function mergeContacts(conn: PoolConnection, keep: number, remove: number): Promise<void> {
  if (keep === remove) return
  const [[keepChat]]: any = await conn.query('SELECT id FROM chats WHERE contact_id=?', [keep])
  const [[removeChat]]: any = await conn.query('SELECT id FROM chats WHERE contact_id=?', [remove])
  if (keepChat && removeChat) {
    await conn.query(`INSERT IGNORE INTO messages (chat_id,wa_message_id,from_me,sender_jid,message_type,text,message_timestamp,status,is_deleted,deleted_at,raw_payload,created_at,updated_at)
      SELECT ?,wa_message_id,from_me,sender_jid,message_type,text,message_timestamp,status,is_deleted,deleted_at,raw_payload,created_at,updated_at FROM messages WHERE chat_id=?`, [keepChat.id, removeChat.id])
    await conn.query('DELETE FROM chats WHERE id=?', [removeChat.id])
  } else if (removeChat) await conn.query('UPDATE chats SET contact_id=? WHERE id=?', [keep, removeChat.id])
  const [[keepCart]]: any = await conn.query('SELECT id FROM shopping_carts WHERE contact_id=?',[keep])
  const [[removeCart]]: any = await conn.query('SELECT id FROM shopping_carts WHERE contact_id=?',[remove])
  if(keepCart&&removeCart){
    await conn.query(`INSERT INTO shopping_cart_items (cart_id,inventory_item_id,sku,item_type,item_name,quantity,unit_price,currency)
      SELECT ?,inventory_item_id,sku,item_type,item_name,quantity,unit_price,currency FROM shopping_cart_items WHERE cart_id=?
      ON DUPLICATE KEY UPDATE quantity=LEAST(999,shopping_cart_items.quantity+VALUES(quantity)),inventory_item_id=VALUES(inventory_item_id),item_name=VALUES(item_name),unit_price=VALUES(unit_price),currency=VALUES(currency)`,[keepCart.id,removeCart.id])
    await conn.query('DELETE FROM shopping_carts WHERE id=?',[removeCart.id])
  }else if(removeCart)await conn.query('UPDATE shopping_carts SET contact_id=? WHERE id=?',[keep,removeCart.id])
  await conn.query(`INSERT INTO contact_profiles (contact_id,custom_name,tags,notes)
    SELECT ?,custom_name,tags,notes FROM contact_profiles WHERE contact_id=?
    ON DUPLICATE KEY UPDATE custom_name=COALESCE(contact_profiles.custom_name,VALUES(custom_name)),tags=COALESCE(contact_profiles.tags,VALUES(tags)),notes=COALESCE(contact_profiles.notes,VALUES(notes))`,[keep,remove])
  await conn.query(`INSERT INTO chat_settings (contact_id,bot_paused) SELECT ?,bot_paused FROM chat_settings WHERE contact_id=?
    ON DUPLICATE KEY UPDATE bot_paused=GREATEST(chat_settings.bot_paused,VALUES(bot_paused))`,[keep,remove])
  await conn.query('UPDATE appointments SET contact_id=? WHERE contact_id=?',[keep,remove])
  await conn.query('UPDATE orders SET contact_id=? WHERE contact_id=?',[keep,remove])
  await conn.query('UPDATE contact_identifiers SET contact_id=? WHERE contact_id=?', [keep, remove])
  await conn.query('DELETE FROM contacts WHERE id=?', [remove])
}

async function identify(conn: PoolConnection, input: StoredMessage): Promise<{ contactId: number; identity: Identity }> {
  const identity = resolveIdentity({ jid: input.jid, lid: input.lid, phoneJid: input.phoneJid })
  const identifierJids = identity.identifiers.map(i => i.jid)
  const [found]: any = identifierJids.length ? await conn.query(
    `SELECT DISTINCT c.id, c.phone_number FROM contacts c JOIN contact_identifiers i ON i.contact_id=c.id WHERE i.jid IN (${identifierJids.map(() => '?').join(',')})`, identifierJids,
  ) : [[], []]
  let contactId: number | undefined
  if (identity.phoneNumber) {
    const [[byPhone]]: any = await conn.query('SELECT id FROM contacts WHERE phone_number=?', [identity.phoneNumber])
    contactId = byPhone?.id
  }
  contactId ??= found[0]?.id
  if (!contactId) {
    const [result]: any = await conn.query('INSERT INTO contacts (phone_number, display_name, identity_status) VALUES (?, ?, ?)', [identity.phoneNumber, input.displayName ?? null, identity.status])
    contactId = result.insertId
  } else {
    await conn.query('UPDATE contacts SET phone_number=COALESCE(?, phone_number), display_name=COALESCE(?, display_name), identity_status=IF(COALESCE(?, phone_number) IS NULL, "unresolved", "resolved") WHERE id=?', [identity.phoneNumber, input.displayName ?? null, identity.phoneNumber, contactId])
  }
  for (const row of found) if (Number(row.id) !== Number(contactId)) await mergeContacts(conn, Number(contactId), Number(row.id))
  for (const identifier of identity.identifiers) {
    const [[existing]]: any = await conn.query('SELECT contact_id FROM contact_identifiers WHERE jid=?', [identifier.jid])
    if (existing && Number(existing.contact_id) !== Number(contactId)) await mergeContacts(conn, Number(contactId), Number(existing.contact_id))
    await conn.query('INSERT INTO contact_identifiers (contact_id,jid,identifier_type) VALUES (?,?,?) ON DUPLICATE KEY UPDATE contact_id=VALUES(contact_id), identifier_type=VALUES(identifier_type)', [contactId, identifier.jid, identifier.type])
  }
  return { contactId: Number(contactId), identity }
}

export async function persistMessage(message: StoredMessage): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const { contactId } = await identify(conn, message)
    await conn.query('INSERT INTO chats (contact_id,last_message_at) VALUES (?,?) ON DUPLICATE KEY UPDATE last_message_at=GREATEST(COALESCE(last_message_at, VALUES(last_message_at)), VALUES(last_message_at))', [contactId, message.timestamp])
    const [[chat]]: any = await conn.query('SELECT id FROM chats WHERE contact_id=?', [contactId])
    const deleted = message.deleted
    const status = message.status === undefined || message.status === null ? null : String(message.status)
    await conn.query(`INSERT INTO messages (chat_id,wa_message_id,from_me,sender_jid,message_type,text,message_timestamp,status,is_deleted,deleted_at,raw_payload)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE sender_jid=VALUES(sender_jid),message_type=VALUES(message_type),text=IF(VALUES(is_deleted),NULL,VALUES(text)),status=COALESCE(VALUES(status),status),is_deleted=GREATEST(is_deleted,VALUES(is_deleted)),deleted_at=IF(VALUES(is_deleted),UTC_TIMESTAMP(3),deleted_at),raw_payload=IF(VALUES(is_deleted),NULL,VALUES(raw_payload))`,
      [chat.id, message.waMessageId, message.fromMe, message.senderJid ?? null, message.messageType, deleted ? null : message.text, message.timestamp, status, deleted, deleted ? new Date() : null, deleted ? null : JSON.stringify(message.rawPayload, BufferJSON.replacer)])
    await conn.commit()
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

export async function persistDeletion(jid: string, id: string, fromMe: boolean): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows]: any = await conn.query('SELECT ch.id FROM chats ch JOIN contact_identifiers ci ON ci.contact_id=ch.contact_id WHERE ci.jid=?', [jid])
    for (const row of rows) await conn.query('UPDATE messages SET is_deleted=1,deleted_at=UTC_TIMESTAMP(3),text=NULL,raw_payload=NULL WHERE chat_id=? AND wa_message_id=? AND from_me=?', [row.id, id, fromMe])
    await conn.commit()
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

export async function updateStatus(jid: string, id: string, fromMe: boolean, status: string | number): Promise<void> {
  await pool.execute('UPDATE messages m JOIN chats ch ON ch.id=m.chat_id JOIN contact_identifiers ci ON ci.contact_id=ch.contact_id SET m.status=? WHERE ci.jid=? AND m.wa_message_id=? AND m.from_me=?', [String(status), jid, id, fromMe])
}

export async function upsertContactChat(jid: string, name?: string | null, phoneJid?: string | null): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const data = { jid, lid: jid.endsWith('@lid') ? jid : null, phoneJid: phoneJid ?? null, displayName: name, waMessageId: `chat:${jid}`, fromMe: false, senderJid: null, messageType: 'chat', text: null, timestamp: new Date(0), status: null, deleted: false, rawPayload: {} }
    const { contactId } = await identify(conn, data)
    await conn.query('INSERT INTO chats (contact_id) VALUES (?) ON DUPLICATE KEY UPDATE contact_id=VALUES(contact_id)', [contactId])
    await conn.commit()
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

export async function enrichContact(jid: string, name: string): Promise<void> {
  await pool.execute('UPDATE contacts c JOIN contact_identifiers i ON i.contact_id=c.id SET c.display_name=? WHERE i.jid=?', [name, jid])
}

export async function closePool(): Promise<void> { await pool.end() }
export function logDbError(error: unknown): void { logger.error({ err: error }, 'Falló persistencia MySQL') }
