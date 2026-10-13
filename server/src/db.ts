import pg from 'pg';
import { config } from './config.js';

pg.types.setTypeParser(1700, v => parseFloat(v));   // numeric -> number
pg.types.setTypeParser(20, v => parseInt(v, 10));   // bigint -> number
pg.types.setTypeParser(1082, v => v);               // date -> 'YYYY-MM-DD' (nessuna conversione di fuso)

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
export type Q = Pick<pg.PoolClient, 'query'>;

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>, utente?: string): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (utente) await c.query(`SELECT set_config('app.utente', $1, true)`, [utente]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
