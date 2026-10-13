import { FastifyInstance } from 'fastify';
import { pool, tx } from '../db.js';
import { ruoli, utenteDi, Ruolo } from '../auth.js';

export interface Risorsa {
  /** nome tabella (anche path /api/<path>) */
  tabella: string;
  path?: string;
  colonne: string[];            // colonne scrivibili
  ricerca?: string[];           // colonne ricercabili con ?q=
  filtri?: string[];            // colonne filtrabili con ?col=valore
  ordine?: string;
  scrittura?: Ruolo[];          // ruoli abilitati alla scrittura (oltre admin)
  elimina?: boolean;
  select?: string;              // SELECT custom (con join) per list/get; alias tabella 't'
}

/** CRUD generico con colonne in allowlist: i nomi di colonna non arrivano mai dall'input senza validazione. */
export function crud(app: FastifyInstance, r: Risorsa) {
  const base = `/api/${r.path ?? r.tabella}`;
  const sel = r.select ?? `SELECT t.* FROM ${r.tabella} t`;
  const guard = ruoli(...(r.scrittura ?? []));
  const pick = (body: Record<string, unknown>) => Object.keys(body).filter(k => r.colonne.includes(k));

  app.get(base, async req => {
    const q = req.query as Record<string, string>;
    const where: string[] = [], args: unknown[] = [];
    for (const f of r.filtri ?? []) if (q[f] !== undefined && q[f] !== '') { args.push(q[f]); where.push(`t.${f}::text = $${args.length}`); }
    if (q.q && r.ricerca?.length) { args.push(`%${q.q}%`); where.push('(' + r.ricerca.map(c => `t.${c}::text ILIKE $${args.length}`).join(' OR ') + ')'); }
    const limit = Math.min(Number(q.limit ?? 200), 1000), offset = Number(q.offset ?? 0);
    const sql = `${sel} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${r.ordine ?? 't.id DESC'} LIMIT ${limit} OFFSET ${offset}`;
    return (await pool.query(sql, args)).rows;
  });
  app.get(`${base}/:id`, async (req, reply) => {
    const { rows } = await pool.query(`${sel} WHERE t.id=$1`, [(req.params as any).id]);
    return rows[0] ?? reply.code(404).send({ errore: 'Non trovato' });
  });
  app.post(base, { preHandler: guard }, async req => {
    const body = req.body as Record<string, unknown>; const cols = pick(body);
    if (!cols.length) throw Object.assign(new Error('Nessun campo valido'), { statusCode: 400 });
    return tx(async c => (await c.query(
      `INSERT INTO ${r.tabella} (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, cols.map(k => body[k]))).rows[0],
      utenteDi(req).username);
  });
  app.put(`${base}/:id`, { preHandler: guard }, async (req, reply) => {
    const body = req.body as Record<string, unknown>; const cols = pick(body);
    if (!cols.length) return reply.code(400).send({ errore: 'Nessun campo valido' });
    const row = await tx(async c => (await c.query(
      `UPDATE ${r.tabella} SET ${cols.map((k, i) => `${k}=$${i + 1}`).join(',')} WHERE id=$${cols.length + 1} RETURNING *`,
      [...cols.map(k => body[k]), (req.params as any).id])).rows[0], utenteDi(req).username);
    return row ?? reply.code(404).send({ errore: 'Non trovato' });
  });
  if (r.elimina) app.delete(`${base}/:id`, { preHandler: ruoli('admin') }, async req => {
    await tx(c => c.query(`DELETE FROM ${r.tabella} WHERE id=$1`, [(req.params as any).id]), utenteDi(req).username);
    return { ok: true };
  });
}
