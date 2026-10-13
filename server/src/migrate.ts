import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

export async function migrate(dir = join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations')) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (nome text PRIMARY KEY, applicata_il timestamptz DEFAULT now())`);
  const fatte = new Set((await pool.query('SELECT nome FROM schema_migrations')).rows.map(r => r.nome));
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (fatte.has(f)) continue;
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); await c.query(readFileSync(join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations(nome) VALUES ($1)', [f]); await c.query('COMMIT');
      console.log('migrazione applicata:', f);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
}
if (process.argv[1]?.endsWith('migrate.ts')) migrate().then(() => pool.end()).catch(e => { console.error(e); process.exit(1); });
