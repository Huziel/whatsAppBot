import fs from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'

dotenv.config()
const host = process.env.DB_HOST ?? '127.0.0.1'
const port = Number(process.env.DB_PORT ?? 3306)
const user = process.env.DB_USER
const password = process.env.DB_PASSWORD
const database = process.env.DB_NAME ?? 'whatsapp_local'
if (!user || !password) throw new Error('Configura DB_USER y DB_PASSWORD en .env antes de migrar')

async function main(): Promise<void> {
  const connection = await mysql.createConnection({ host, port, user, password, charset: 'utf8mb4', multipleStatements: true, timezone: 'Z' })
  try {
    await connection.query("SET time_zone = '+00:00'")
    const escapedDatabase = `\`${database.replace(/`/g, '``')}\``
    await connection.query(`CREATE DATABASE IF NOT EXISTS ${escapedDatabase} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    await connection.query(`USE ${escapedDatabase}`)
    const migrationDir = path.resolve('migrations')
    const files = (await fs.readdir(migrationDir)).filter(file => /^\d+.*\.sql$/.test(file)).sort()
    for (const file of files) {
      const [migrationTable]: any = await connection.query("SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME='schema_migrations'", [database])
      if (migrationTable.length) {
        const [[applied]]: any = await connection.query('SELECT version FROM schema_migrations WHERE version=?', [file])
        if (applied) continue
      }
      await connection.query(await fs.readFile(path.join(migrationDir, file), 'utf8'))
      await connection.query('INSERT IGNORE INTO schema_migrations (version) VALUES (?)', [file])
      console.info(`Migración aplicada: ${file}`)
    }
  } finally { await connection.end() }
}
main().catch(error => { console.error('Falló migración:', error.message); process.exitCode = 1 })
