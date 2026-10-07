/**
 * Migration runner. Applies db/migrations/*.sql in filename order, once each.
 *
 *   npm run db:migrate
 *
 * LOADS .env ITSELF, via `--env-file-if-exists=.env` in the npm script. Plain
 * Node does not read .env the way Next.js does, so without that flag this
 * script reports "DATABASE_URL is not set" while a perfectly good .env sits
 * next to it — which reads as a broken config file rather than a missing flag.
 * The flag is on this script alone: `verify` and `tiles` read no env var, and
 * --env-file-if-exists prints a warning when the file is absent, which would be
 * pure noise for a fresh clone.
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
import { requireValue } from '../src/lib/server/env-check.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = resolve(__dirname, '..', 'db', 'migrations')

async function main(): Promise<void> {
  // Inside main(), not at module top level. A top-level throw happens during
  // import, before main() ever returns a promise, so the handler below never
  // sees it — the guard's one actionable sentence would be replaced by a stack
  // trace pointing into env-check.ts, which is the exact failure it was written
  // to prevent.
  const connectionString = requireValue('DATABASE_URL', process.env.DATABASE_URL)

  const client = new Client({
    connectionString,
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
  // The env guards' messages are written to be read, not debugged. Printing a
  // stack trace above one buries the one line that says what to do.
  if (err instanceof Error && (err.name === 'MissingEnvError' || err.name === 'UnfilledEnvError')) {
    console.error(`\n  ${err.message}\n`)
  } else {
    console.error(err)
  }
  process.exit(1)
})
