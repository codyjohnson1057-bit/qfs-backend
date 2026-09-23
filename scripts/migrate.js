#!/usr/bin/env node
/**
 * Run SQL migrations in migrations/*.sql (numeric order) against DATABASE_URL.
 * Idempotent when SQL uses IF NOT EXISTS. SSL enabled for Neon.
 *
 * Usage: npm run migrate
 * Does not print connection strings or secrets.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (!files.length) {
    console.log('No .sql migrations found.');
    return;
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  console.log(`Connected. Applying ${files.length} SQL file(s)…`);

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id serial PRIMARY KEY,
        filename text NOT NULL UNIQUE,
        applied_at timestamptz DEFAULT now()
      )
    `);

    for (const file of files) {
      const already = await client.query(
        'SELECT 1 FROM schema_migrations WHERE filename = $1',
        [file]
      );
      if (already.rowCount) {
        console.log(`skip  ${file} (already applied)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      console.log(`apply ${file}…`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
          [file]
        );
        await client.query('COMMIT');
        console.log(`ok    ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`FAIL  ${file}:`, err.message);
        process.exitCode = 1;
        break;
      }
    }

    // Report new tables presence
    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('cards','payments','vaults','swaps')
      ORDER BY table_name
    `);
    console.log('Present tables:', tables.rows.map((r) => r.table_name).join(', ') || '(none)');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Migrate error:', err.message);
  process.exit(1);
});
