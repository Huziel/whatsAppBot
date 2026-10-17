import { createHash, randomBytes } from 'node:crypto'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { ConflictError, ExternalServiceError, InternalError, NotFoundError } from './errors'

export type OrderStatus = 'pending'|'confirmed'|'preparing'|'ready'|'out_for_delivery'|'completed'|'cancelled'|'expired'
export type PaymentStatus = 'unpaid'|'pending'|'paid'|'failed'|'refunded'
export interface OrderItemInput { sku:string;quantity:number }
export interface CartOrderSnapshotLine { sku:string;itemType:'product'|'service';itemName:string;quantity:number;unitPrice:string|null;currency:string }
export interface PublicOrderInput {
  phoneNumber:string
  customerName:string|null
  items:OrderItemInput[]
  publicOrderKey:string
  accessToken:string
  reservationMinutes:number
}
export interface OrderResult {
  orderId:number
  publicId:string
  status:OrderStatus
  paymentStatus:PaymentStatus
  total:string|null
  currency:string|null
  expiresAt:Date|null
  duplicate:boolean
}

const folioAlphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const transitions:Record<OrderStatus,readonly OrderStatus[]>={
  pending:['confirmed','cancelled'],
  confirmed:['preparing'],
  preparing:['ready'],
  ready:['out_for_delivery','completed'],
  out_for_delivery:['completed'],
  completed:[],cancelled:[],expired:[],
}

function publicFolio():string{
  const bytes=randomBytes(12)
  return `WA-${[...bytes].map(value=>folioAlphabet[value&31]).join('')}`
}

function sha256(value:string):Buffer{return createHash('sha256').update(value).digest()}

function requestHash(input:Pick<PublicOrderInput,'phoneNumber'|'customerName'|'items'>):Buffer{
  const canonical={version:1,phoneNumber:input.phoneNumber,customerName:input.customerName??null,items:[...input.items].sort((a,b)=>a.sku.localeCompare(b.sku)).map(item=>({sku:item.sku,quantity:item.quantity}))}
  return sha256(JSON.stringify(canonical))
}

function equalHash(left:unknown,right:Buffer):boolean{return Buffer.isBuffer(left)&&left.equals(right)}

function cartSnapshot(lines:CartOrderSnapshotLine[]):string{
  return JSON.stringify([...lines].sort((left,right)=>left.sku.localeCompare(right.sku)).map(line=>({sku:line.sku,itemType:line.itemType,itemName:line.itemName,quantity:Number(line.quantity),unitPrice:line.unitPrice===null?null:String(line.unitPrice),currency:String(line.currency)})))
}

function storedOrderResult(value:any):OrderResult{
  return {...value,orderId:Number(value.orderId),expiresAt:value.expiresAt?new Date(value.expiresAt):null,duplicate:true}
}

function centsTotal(lines:any[]):{total:string|null;currency:string|null}{
  const currencies=new Set(lines.map(line=>String(line.currency)))
  if(currencies.size!==1||lines.some(line=>line.unitPrice===null))return {total:null,currency:null}
  const cents=lines.reduce((sum,line)=>{
    const [whole,fraction='']=String(line.unitPrice).split('.')
    return sum+(BigInt(whole)*100n+BigInt((fraction+'00').slice(0,2)))*BigInt(line.quantity)
  },0n)
  if(cents>999_999_999_999n)throw new ConflictError('El total supera el máximo admitido para un pedido.','ORDER_TOTAL_TOO_LARGE')
  return {total:`${cents/100n}.${String(cents%100n).padStart(2,'0')}`,currency:[...currencies][0]}
}

export class OrderService {
  private schemaVerified=false
  constructor(private readonly pool:Pool){}

  async assertSchema():Promise<void>{
    if(this.schemaVerified)return
    const [rows]:any=await this.pool.query(`SELECT COLUMN_NAME AS columnName,COLUMN_TYPE AS columnType FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='orders' AND COLUMN_NAME IN ('public_id','payment_status','reservation_status','expires_at'))
      OR (TABLE_NAME='inventory_items' AND COLUMN_NAME='reserved_quantity'))`)
    const columns=new Set(rows.map((row:any)=>String(row.columnName)))
    const statusType=String((await this.pool.query("SELECT COLUMN_TYPE AS columnType FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='status'") as any)[0]?.[0]?.columnType??'')
    const [tables]:any=await this.pool.query("SELECT TABLE_NAME AS tableName FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('inventory_reservations','inventory_movements')")
    const [indexes]:any=await this.pool.query("SELECT DISTINCT INDEX_NAME AS indexName FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND INDEX_NAME IN ('uq_orders_public_order_key','uq_orders_public_id','idx_orders_expiration')")
    const requiredTables=new Set(tables.map((row:any)=>String(row.tableName))),requiredIndexes=new Set(indexes.map((row:any)=>String(row.indexName)))
    if(!['public_id','payment_status','reservation_status','expires_at','reserved_quantity'].every(column=>columns.has(column))
      ||!['inventory_reservations','inventory_movements'].every(table=>requiredTables.has(table))
      ||!['uq_orders_public_order_key','uq_orders_public_id','idx_orders_expiration'].every(index=>requiredIndexes.has(index))
      ||!statusType.includes("'expired'")){
      throw new ExternalServiceError('La base MySQL no tiene las migraciones de ventas requeridas. Ejecuta npm run migrate y vuelve a iniciar WhatsApp.','SALES_SCHEMA_OUTDATED')
    }
    this.schemaVerified=true
  }

  async hasPublicOrderKey(key:string):Promise<boolean>{
    const [[row]]:any=await this.pool.execute('SELECT 1 FROM orders WHERE public_order_key=? LIMIT 1',[key])
    return Boolean(row)
  }

  async createPublicOrder(input:PublicOrderInput):Promise<OrderResult>{
    for(let attempt=0;;attempt++){
      try{return await this.createPublicOrderOnce(input)}
      catch(error:any){
        if(!['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes(error?.code)||attempt>=2)throw error
        await new Promise(resolve=>setTimeout(resolve,20+Math.floor(Math.random()*30)))
      }
    }
  }

  private async createPublicOrderOnce(input:PublicOrderInput):Promise<OrderResult>{
    const hash=requestHash(input),tokenHash=sha256(input.accessToken)
    const conn=await this.pool.getConnection()
    try{
      await conn.beginTransaction()
      const existing=await this.findExistingByKey(conn,input.publicOrderKey,hash,tokenHash,true)
      if(existing){await conn.commit();return existing}

      const contactId=await this.findOrCreateUnverifiedContact(conn,input.phoneNumber)
      const lines=await this.lockInventory(conn,input.items)
      const result=await this.insertOrder(conn,{contactId,source:'public_menu',customerName:input.customerName,customerPhone:input.phoneNumber,publicOrderKey:input.publicOrderKey,accessTokenHash:tokenHash,requestHash:hash,lines,reservationMinutes:input.reservationMinutes})
      await conn.commit()
      return {...result,duplicate:false}
    }catch(error:any){
      await conn.rollback()
      if(error?.code==='ER_DUP_ENTRY'){
        const duplicate=await this.findExistingByKey(this.pool,input.publicOrderKey,hash,tokenHash,false)
        if(duplicate)return duplicate
      }
      throw error
    }finally{conn.release()}
  }

  async createOrderFromCart(contactId:number,reservationMinutes:number):Promise<OrderResult>{
    const conn=await this.pool.getConnection()
    try{
      await conn.beginTransaction()
      const [[lockedContact]]:any=await conn.query('SELECT id FROM contacts WHERE id=? FOR UPDATE',[contactId])
      if(!lockedContact)throw new NotFoundError('Contacto no encontrado.','CONTACT_NOT_FOUND')
      const [[cart]]:any=await conn.query('SELECT id FROM shopping_carts WHERE contact_id=? FOR UPDATE',[contactId])
      if(!cart)throw new NotFoundError('Este contacto no tiene carrito.','CART_NOT_FOUND')
      const [cartRows]:any=await conn.query('SELECT sku,quantity FROM shopping_cart_items WHERE cart_id=? ORDER BY sku FOR UPDATE',[cart.id])
      if(!cartRows.length)throw new ConflictError('El carrito está vacío.','CART_EMPTY')
      const [[contact]]:any=await conn.execute('SELECT COALESCE(cp.custom_name,c.display_name) AS customerName,c.phone_number AS customerPhone FROM contacts c LEFT JOIN contact_profiles cp ON cp.contact_id=c.id WHERE c.id=?',[contactId])
      const lines=await this.lockInventory(conn,cartRows.map((row:any)=>({sku:String(row.sku),quantity:Number(row.quantity)})))
      const result=await this.insertOrder(conn,{contactId,source:'dashboard',customerName:contact.customerName??null,customerPhone:contact.customerPhone??null,publicOrderKey:null,accessTokenHash:null,requestHash:null,lines,reservationMinutes})
      await conn.query('DELETE FROM shopping_cart_items WHERE cart_id=?',[cart.id])
      await conn.commit()
      return {...result,duplicate:false}
    }catch(error){await conn.rollback();throw error}finally{conn.release()}
  }

  async createWhatsAppOrderFromCart(jid:string,reservationMinutes:number,expectedCart:CartOrderSnapshotLine[],effectKey:string,pendingSourceMessageId?:string):Promise<OrderResult>{
    for(let attempt=0;;attempt++){
      try{return await this.createWhatsAppOrderFromCartOnce(jid,reservationMinutes,expectedCart,effectKey,pendingSourceMessageId)}
      catch(error:any){
        if(!['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes(error?.code)||attempt>=2)throw error
        await new Promise(resolve=>setTimeout(resolve,20+Math.floor(Math.random()*30)))
      }
    }
  }

  private async createWhatsAppOrderFromCartOnce(jid:string,reservationMinutes:number,expectedCart:CartOrderSnapshotLine[],effectKey:string,pendingSourceMessageId?:string):Promise<OrderResult>{
    const conn=await this.pool.getConnection()
    try{
      await conn.beginTransaction()
      const [[stored]]:any=await conn.execute('SELECT effect_type AS effectType,result_json AS resultJson FROM conversation_effects WHERE effect_key=? FOR UPDATE',[effectKey])
      if(stored){
        if(stored.effectType!=='order:create')throw new ConflictError('La operación ya fue utilizada para otro efecto.','CONVERSATION_EFFECT_CONFLICT')
        const value=typeof stored.resultJson==='string'?JSON.parse(stored.resultJson):stored.resultJson
        if(pendingSourceMessageId)await conn.execute('DELETE FROM pending_intents WHERE jid=? AND source_message_id=?',[jid,pendingSourceMessageId])
        await conn.commit();return storedOrderResult(value)
      }
      const [[contact]]:any=await conn.query(`SELECT c.id,COALESCE(cp.custom_name,c.display_name) AS customerName,c.phone_number AS customerPhone
        FROM contacts c JOIN contact_identifiers i ON i.contact_id=c.id LEFT JOIN contact_profiles cp ON cp.contact_id=c.id
        WHERE i.jid=? LIMIT 1 FOR UPDATE`,[jid])
      if(!contact)throw new NotFoundError('Contacto no encontrado.','CONTACT_NOT_FOUND')
      const [[cart]]:any=await conn.query('SELECT id FROM shopping_carts WHERE contact_id=? FOR UPDATE',[contact.id])
      if(!cart)throw new ConflictError('El carrito está vacío.','CART_EMPTY')
      const [cartRows]:any=await conn.query(`SELECT sku,item_type AS itemType,item_name AS itemName,quantity,unit_price AS unitPrice,currency
        FROM shopping_cart_items WHERE cart_id=? ORDER BY sku FOR UPDATE`,[cart.id])
      const currentCart:CartOrderSnapshotLine[]=cartRows.map((row:any)=>({...row,quantity:Number(row.quantity),unitPrice:row.unitPrice===null?null:String(row.unitPrice),currency:String(row.currency)}))
      if(!currentCart.length)throw new ConflictError('El carrito está vacío.','CART_EMPTY')
      if(cartSnapshot(currentCart)!==cartSnapshot(expectedCart))throw new ConflictError('El carrito cambió desde que mostré el resumen. Revísalo y vuelve a finalizar el pedido.','CART_CHANGED')
      const lines=await this.lockInventory(conn,currentCart.map(row=>({sku:row.sku,quantity:row.quantity})))
      for(const line of lines){
        const expected=currentCart.find(row=>row.sku.toLocaleLowerCase('en-US')===String(line.sku).toLocaleLowerCase('en-US'))!
        if(expected.unitPrice!==line.unitPrice||expected.currency!==line.currency||expected.itemName!==String(line.name)||expected.itemType!==line.itemType)throw new ConflictError('Los datos del carrito cambiaron. Revisa el resumen antes de confirmar.','CART_CHANGED')
      }
      const result=await this.insertOrder(conn,{contactId:Number(contact.id),source:'whatsapp',customerName:contact.customerName??null,customerPhone:contact.customerPhone??null,publicOrderKey:null,accessTokenHash:null,requestHash:null,lines,reservationMinutes})
      await conn.query('DELETE FROM shopping_cart_items WHERE cart_id=?',[cart.id])
      const value={...result,duplicate:false}
      await conn.execute('INSERT INTO conversation_effects (effect_key,effect_type,result_json) VALUES (?,?,?)',[effectKey,'order:create',JSON.stringify(value)])
      if(pendingSourceMessageId)await conn.execute('DELETE FROM pending_intents WHERE jid=? AND source_message_id=?',[jid,pendingSourceMessageId])
      await conn.commit()
      return value
    }catch(error:any){
      await conn.rollback()
      if(error?.code==='ER_DUP_ENTRY'){
        const [[stored]]:any=await this.pool.execute("SELECT result_json AS resultJson FROM conversation_effects WHERE effect_key=? AND effect_type='order:create'",[effectKey])
        if(stored){const value=typeof stored.resultJson==='string'?JSON.parse(stored.resultJson):stored.resultJson;if(pendingSourceMessageId)await this.pool.execute('DELETE FROM pending_intents WHERE jid=? AND source_message_id=?',[jid,pendingSourceMessageId]);return storedOrderResult(value)}
      }
      throw error
    }finally{conn.release()}
  }

  async transition(orderId:number,target:OrderStatus):Promise<{status:OrderStatus;duplicate:boolean}>{
    const conn=await this.pool.getConnection()
    let committed=false
    try{
      await conn.beginTransaction()
      const [[order]]:any=await conn.query('SELECT id,status,reservation_status AS reservationStatus,(expires_at IS NOT NULL AND expires_at<=UTC_TIMESTAMP(3)) AS isExpired FROM orders WHERE id=? FOR UPDATE',[orderId])
      if(!order)throw new NotFoundError('Pedido no encontrado.','ORDER_NOT_FOUND')
      const current=order.status as OrderStatus
      if(current===target){await conn.commit();return {status:current,duplicate:true}}
      if(!transitions[current]?.includes(target))throw new ConflictError(`No se puede cambiar un pedido ${current} a ${target}.`,'INVALID_ORDER_TRANSITION')
      if(current==='pending'&&Boolean(order.isExpired)){
        if(order.reservationStatus==='active')await this.finalizeReservations(conn,orderId,'release','expired')
        await conn.query("UPDATE orders SET status='expired',reservation_status=IF(reservation_status='active','expired',reservation_status),expired_at=UTC_TIMESTAMP(3) WHERE id=? AND status='pending'",[orderId])
        await conn.commit();committed=true
        throw new ConflictError('La reserva del pedido ya expiró.','ORDER_EXPIRED')
      }
      if(current==='pending'&&target==='confirmed'&&order.reservationStatus==='active')await this.finalizeReservations(conn,orderId,'sale')
      if(current==='pending'&&target==='cancelled'&&order.reservationStatus==='active')await this.finalizeReservations(conn,orderId,'release')
      const timestamps=target==='confirmed'?'confirmed_at=UTC_TIMESTAMP(3),':target==='cancelled'?'cancelled_at=UTC_TIMESTAMP(3),':''
      const reservationStatus=order.reservationStatus==='active'?(target==='confirmed'?'sold':target==='cancelled'?'released':order.reservationStatus):order.reservationStatus
      await conn.query(`UPDATE orders SET ${timestamps}status=?,reservation_status=? WHERE id=?`,[target,reservationStatus,orderId])
      await conn.commit();committed=true
      return {status:target,duplicate:false}
    }catch(error){if(!committed)await conn.rollback();throw error}finally{conn.release()}
  }

  async expireReservations(batchSize=100,maxBatches=10):Promise<number>{
    const boundedBatch=Math.max(1,Math.min(500,Math.floor(batchSize))),boundedBatches=Math.max(1,Math.min(100,Math.floor(maxBatches)))
    let expired=0
    for(let batch=0;batch<boundedBatches;batch++){
      const conn=await this.pool.getConnection()
      try{
        await conn.beginTransaction()
        const [orders]:any=await conn.query(`SELECT id FROM orders WHERE status='pending' AND reservation_status='active' AND expires_at<=UTC_TIMESTAMP(3)
          ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED`,[boundedBatch])
        for(const order of orders){
          await this.finalizeReservations(conn,Number(order.id),'release','expired')
          await conn.query("UPDATE orders SET status='expired',reservation_status='expired',expired_at=UTC_TIMESTAMP(3) WHERE id=? AND status='pending'",[order.id])
          expired++
        }
        await conn.commit()
        if(orders.length<boundedBatch)break
      }catch(error){await conn.rollback();throw error}finally{conn.release()}
    }
    return expired
  }

  async getPublicOrder(publicId:string,accessToken:string):Promise<any|null>{
    const [[order]]:any=await this.pool.execute(`SELECT id,public_id AS publicId,status,payment_status AS paymentStatus,total,currency,created_at AS createdAt,
      expires_at AS expiresAt,confirmed_at AS confirmedAt,cancelled_at AS cancelledAt,expired_at AS expiredAt,public_access_token_hash AS tokenHash
      FROM orders WHERE public_id=? AND source='public_menu' LIMIT 1`,[publicId])
    if(!order||!equalHash(order.tokenHash,sha256(accessToken)))return null
    const [items]:any=await this.pool.execute('SELECT sku,item_type AS itemType,item_name AS itemName,quantity,unit_price AS unitPrice,currency FROM order_items WHERE order_id=? ORDER BY id',[order.id])
    return {publicId:order.publicId,status:order.status,paymentStatus:order.paymentStatus,total:order.total===null?null:String(order.total),currency:order.currency??null,createdAt:order.createdAt,expiresAt:order.expiresAt??null,confirmedAt:order.confirmedAt??null,cancelledAt:order.cancelledAt??null,expiredAt:order.expiredAt??null,items:items.map((item:any)=>({...item,quantity:Number(item.quantity),unitPrice:item.unitPrice===null?null:String(item.unitPrice)}))}
  }

  async releasePendingOrdersForContact(conn:PoolConnection,contactId:number):Promise<void>{
    const [orders]:any=await conn.query("SELECT id FROM orders WHERE contact_id=? AND status='pending' AND reservation_status='active' ORDER BY id FOR UPDATE",[contactId])
    for(const order of orders){
      await this.finalizeReservations(conn,Number(order.id),'release')
      await conn.query("UPDATE orders SET status='cancelled',reservation_status='released',cancelled_at=UTC_TIMESTAMP(3) WHERE id=? AND status='pending'",[order.id])
    }
  }

  private async findExistingByKey(executor:any,key:string,hash:Buffer,tokenHash:Buffer,lock:boolean):Promise<OrderResult|null>{
    const [[row]]:any=await executor.execute(`SELECT id,public_id AS publicId,status,payment_status AS paymentStatus,total,currency,expires_at AS expiresAt,
      public_request_hash AS requestHash,public_access_token_hash AS tokenHash FROM orders WHERE public_order_key=?${lock?' FOR UPDATE':''}`,[key])
    if(!row)return null
    if(!equalHash(row.requestHash,hash)||!equalHash(row.tokenHash,tokenHash))throw new ConflictError('Esta clave de checkout ya pertenece a otro intento de pedido.','IDEMPOTENCY_KEY_REUSED')
    return {orderId:Number(row.id),publicId:String(row.publicId),status:row.status,paymentStatus:row.paymentStatus,total:row.total===null?null:String(row.total),currency:row.currency??null,expiresAt:row.expiresAt??null,duplicate:true}
  }

  private async findOrCreateUnverifiedContact(conn:PoolConnection,phone:string):Promise<number>{
    const [result]:any=await conn.execute(`INSERT INTO contacts (phone_number,display_name,identity_status) VALUES (?,NULL,'unresolved')
      ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,[phone])
    return Number(result.insertId)
  }

  private async lockInventory(conn:PoolConnection,items:OrderItemInput[]):Promise<any[]>{
    const skus=items.map(item=>item.sku)
    const [products]:any=await conn.query(`SELECT id,item_type AS itemType,sku,name,price,currency,stock_quantity AS stockQuantity,reserved_quantity AS reservedQuantity
      FROM inventory_items WHERE is_active=1 AND sku IN (${skus.map(()=>'?').join(',')}) ORDER BY id FOR UPDATE`,skus)
    const bySku=new Map<string,any>(products.map((item:any)=>[String(item.sku).toLocaleLowerCase('en-US'),item]))
    if(bySku.size!==items.length)throw new ConflictError('Uno o más artículos ya no están disponibles. Actualiza el menú e inténtalo otra vez.','ITEM_UNAVAILABLE')
    return items.map(input=>{
      const product=bySku.get(input.sku.toLocaleLowerCase('en-US'))!
      const stock=product.stockQuantity===null?null:Number(product.stockQuantity)
      const reserved=Number(product.reservedQuantity)
      if(stock!==null&&input.quantity>stock-reserved)throw new ConflictError(`No hay suficientes unidades disponibles de ${product.name}.`,'INSUFFICIENT_STOCK')
      return {...product,quantity:input.quantity,unitPrice:product.price===null?null:String(product.price),currency:String(product.currency),controlledStock:stock!==null}
    })
  }

  private async insertOrder(conn:PoolConnection,input:{contactId:number;source:'dashboard'|'public_menu'|'whatsapp';customerName:string|null;customerPhone:string|null;publicOrderKey:string|null;accessTokenHash:Buffer|null;requestHash:Buffer|null;lines:any[];reservationMinutes:number}):Promise<Omit<OrderResult,'duplicate'>>{
    const {total,currency}=centsTotal(input.lines)
    let orderInsert:any,folio=''
    for(let attempt=0;attempt<3;attempt++){
      folio=publicFolio()
      try{
        ;[orderInsert]=await conn.execute(`INSERT INTO orders (contact_id,status,total,currency,public_order_key,public_id,public_access_token_hash,public_request_hash,source,customer_name,customer_phone,payment_status,reservation_status,expires_at)
          VALUES (?,'pending',?,?,?,?,?,?,?, ?,?,'unpaid','active',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? MINUTE))`,[input.contactId,total,currency,input.publicOrderKey,folio,input.accessTokenHash,input.requestHash,input.source,input.customerName,input.customerPhone,input.reservationMinutes])
        break
      }catch(error:any){if(error?.code!=='ER_DUP_ENTRY'||String(error?.message).includes('public_order_key')||attempt===2)throw error}
    }
    const orderId=Number(orderInsert.insertId)
    const [[createdOrder]]:any=await conn.execute('SELECT expires_at AS expiresAt FROM orders WHERE id=?',[orderId])
    const expiresAt=createdOrder.expiresAt as Date
    for(const line of input.lines){
      const [itemInsert]:any=await conn.execute(`INSERT INTO order_items (order_id,inventory_item_id,sku,item_type,item_name,quantity,unit_price,currency)
        VALUES (?,?,?,?,?,?,?,?)`,[orderId,line.id,line.sku,line.itemType,line.name,line.quantity,line.unitPrice,line.currency])
      if(!line.controlledStock)continue
      const [reservationInsert]:any=await conn.execute(`INSERT INTO inventory_reservations (order_id,order_item_id,inventory_item_id,sku,quantity,status,expires_at)
        VALUES (?,?,?,?,?,'reserved',?)`,[orderId,itemInsert.insertId,line.id,line.sku,line.quantity,expiresAt])
      const [updated]:any=await conn.execute('UPDATE inventory_items SET reserved_quantity=reserved_quantity+? WHERE id=? AND stock_quantity-reserved_quantity>=?',[line.quantity,line.id,line.quantity])
      if(updated.affectedRows!==1)throw new ConflictError(`No hay suficientes unidades disponibles de ${line.name}.`,'INSUFFICIENT_STOCK')
      await conn.execute(`INSERT INTO inventory_movements (inventory_item_id,order_id,order_item_id,sku,movement_type,quantity,event_key,metadata)
        VALUES (?,?,?,?, 'reserve',?,?,?)`,[line.id,orderId,itemInsert.insertId,line.sku,line.quantity,`reservation:${reservationInsert.insertId}:reserve`,JSON.stringify({source:input.source,folio})])
    }
    return {orderId,publicId:folio,status:'pending',paymentStatus:'unpaid',total,currency,expiresAt}
  }

  private async finalizeReservations(conn:PoolConnection,orderId:number,action:'sale'|'release',reason?:'expired'):Promise<void>{
    const [reservations]:any=await conn.query(`SELECT r.id,r.order_item_id AS orderItemId,r.inventory_item_id AS inventoryItemId,r.sku,r.quantity
      FROM inventory_reservations r WHERE r.order_id=? AND r.status='reserved' ORDER BY r.inventory_item_id,r.id FOR UPDATE`,[orderId])
    const inventoryIds=[...new Set<number>(reservations.map((row:any)=>Number(row.inventoryItemId)).filter(Number.isFinite))].sort((a,b)=>a-b)
    if(inventoryIds.length)await conn.query(`SELECT id FROM inventory_items WHERE id IN (${inventoryIds.map(()=>'?').join(',')}) ORDER BY id FOR UPDATE`,inventoryIds)
    for(const reservation of reservations){
      if(reservation.inventoryItemId===null)throw new InternalError('Una reserva activa perdió su artículo de inventario.','RESERVATION_INTEGRITY_ERROR')
      const quantity=Number(reservation.quantity)
      const sql=action==='sale'
        ?'UPDATE inventory_items SET stock_quantity=stock_quantity-?,reserved_quantity=reserved_quantity-? WHERE id=? AND stock_quantity>=? AND reserved_quantity>=?'
        :'UPDATE inventory_items SET reserved_quantity=reserved_quantity-? WHERE id=? AND reserved_quantity>=?'
      const params=action==='sale'?[quantity,quantity,reservation.inventoryItemId,quantity,quantity]:[quantity,reservation.inventoryItemId,quantity]
      const [updated]:any=await conn.execute(sql,params)
      if(updated.affectedRows!==1)throw new InternalError('El inventario reservado es inconsistente.','RESERVATION_INTEGRITY_ERROR')
      await conn.execute("UPDATE inventory_reservations SET status=?,finalized_at=UTC_TIMESTAMP(3) WHERE id=? AND status='reserved'",[action==='sale'?'sold':'released',reservation.id])
      await conn.execute(`INSERT INTO inventory_movements (inventory_item_id,order_id,order_item_id,sku,movement_type,quantity,event_key,metadata)
        VALUES (?,?,?,?,?,?,?,?)`,[reservation.inventoryItemId,orderId,reservation.orderItemId,reservation.sku,action,quantity,`reservation:${reservation.id}:${action}`,reason?JSON.stringify({reason}):null])
    }
  }
}
