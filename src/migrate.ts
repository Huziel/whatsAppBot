import fs from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
import { createHash } from 'node:crypto'

dotenv.config()
const host = process.env.DB_HOST ?? '127.0.0.1'
const port = Number(process.env.DB_PORT ?? 3306)
const user = process.env.DB_USER
const password = process.env.DB_PASSWORD
const database = process.env.DB_NAME ?? 'whatsapp_local'
if (!user || !password) throw new Error('Configura DB_USER y DB_PASSWORD en .env antes de migrar')

async function reconcileInterruptedMigration(connection:any,file:string):Promise<boolean>{
  if(file!=='012_public_order_idempotency.sql')return false
  const [columns]:any=await connection.query(`SELECT COLUMN_TYPE AS columnType,IS_NULLABLE AS isNullable FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='public_order_key'`)
  if(!columns.length)return false
  if(String(columns[0].columnType).toLowerCase()!=='char(36)'||columns[0].isNullable!=='YES')throw new Error('La columna orders.public_order_key no coincide con la migración 012')
  const [indexes]:any=await connection.query(`SELECT NON_UNIQUE AS nonUnique,COLUMN_NAME AS columnName,SEQ_IN_INDEX AS sequence
    FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND INDEX_NAME='uq_orders_public_order_key'`)
  if(indexes.length&&!indexes.every((index:any)=>Number(index.nonUnique)===0&&index.columnName==='public_order_key'&&Number(index.sequence)===1))throw new Error('El índice uq_orders_public_order_key no coincide con la migración 012')
  if(!indexes.length)await connection.query('ALTER TABLE orders ADD UNIQUE KEY uq_orders_public_order_key (public_order_key)')
  await connection.query('INSERT IGNORE INTO schema_migrations (version) VALUES (?)',[file])
  console.info(`Migración reconciliada: ${file}`)
  return true
}

async function main(): Promise<void> {
  const connection = await mysql.createConnection({ host, port, user, password, charset: 'utf8mb4', multipleStatements: true, timezone: 'Z' })
  const migrationLock=`wa-migrate:${createHash('sha256').update(database).digest('hex').slice(0,32)}`
  let lockAcquired=false
  try {
    await connection.query("SET time_zone = '+00:00'")
    const escapedDatabase = `\`${database.replace(/`/g, '``')}\``
    await connection.query(`CREATE DATABASE IF NOT EXISTS ${escapedDatabase} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    await connection.query(`USE ${escapedDatabase}`)
    const [[lock]]:any=await connection.query('SELECT GET_LOCK(?,30) AS acquired',[migrationLock])
    if(Number(lock.acquired)!==1)throw new Error('No se pudo obtener el lock exclusivo de migraciones')
    lockAcquired=true
    const migrationDir = path.resolve('migrations')
    const files = (await fs.readdir(migrationDir)).filter(file => /^\d+.*\.sql$/.test(file)).sort()
    for (const file of files) {
      const [migrationTable]: any = await connection.query("SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME='schema_migrations'", [database])
      if (migrationTable.length) {
        const [[applied]]: any = await connection.query('SELECT version FROM schema_migrations WHERE version=?', [file])
        if (applied) continue
      }
      if(await reconcileInterruptedMigration(connection,file))continue
      await connection.query(await fs.readFile(path.join(migrationDir, file), 'utf8'))
      await connection.query('INSERT IGNORE INTO schema_migrations (version) VALUES (?)', [file])
      console.info(`Migración aplicada: ${file}`)
    }
  } finally {
    if(lockAcquired)await connection.query('SELECT RELEASE_LOCK(?)',[migrationLock]).catch(()=>undefined)
    await connection.end()
  }
}
main().catch(error => { console.error('Falló migración:', error.message); process.exitCode = 1 })
