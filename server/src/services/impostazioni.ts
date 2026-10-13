import { pool, Q } from '../db.js';
import { makeParametroLookup, ParametroLookup } from '../engine/common.js';

export async function getImpostazione<T = any>(chiave: string, q: Q = pool): Promise<T> {
  const { rows } = await q.query('SELECT valore FROM impostazione WHERE chiave=$1', [chiave]);
  return rows[0]?.valore as T;
}
export async function loadParametri(q: Q = pool): Promise<ParametroLookup> {
  const { rows } = await q.query('SELECT codice, valido_dal::text, valore FROM parametro');
  return makeParametroLookup(rows);
}
