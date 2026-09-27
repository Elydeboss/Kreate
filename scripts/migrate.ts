/**
 * Migration runner. Applies db/migrations/*.sql in filename order, once each.
 *
 *   npm run db:migrate
 *
 * Tracks applied files in schema_migrations. Each file runs inside its own
 * transaction, so a failure leaves that file unapplied and everything before it
 * intact. No down-migrations — for a 16-day hackathon, forward-only is the right
 * trade, and a rollback path nobody tests is worse than none.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = resolve(__dirname, '..', 'db', 'migrations')

const CONNECTION_STRING = process.env.DATABASE_URL
if (!CONNECTION_STRING) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env.local first.')
  process.exit(1)
}

async function main(): Promise<void> {
  const client = new Client({
    connectionString: CONNECTION_STRING,
    ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
  })
  await client.connect()

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort()

    if (files.length === 0) {
      console.log('No migrations found.')
      return
    }

    const applied = new Set(
      (await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
        (r) => r.filename,
      ),
    )

    let ran = 0
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  skip  ${file}`)
        continue
      }
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
      process.stdout.write(`  apply ${file} ... `)
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file])
        await client.query('COMMIT')
        console.log('ok')
        ran += 1
      } catch (err) {
        await client.query('ROLLBACK')
        console.log('FAILED')
        console.error(err instanceof Error ? err.message : err)
        process.exitCode = 1
        return
      }
    }

    console.log(ran === 0 ? 'Already up to date.' : `Applied ${ran} migration(s).`)
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
