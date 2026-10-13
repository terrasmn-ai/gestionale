import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { pool } from './db.js';
import { config } from './config.js';

export function hashPassword(p: string) { const s = randomBytes(16).toString('hex'); return `${s}:${scryptSync(p, s, 64).toString('hex')}`; }
export function verifyPassword(p: string, h: string) {
  const [s, k] = h.split(':'); const a = Buffer.from(k, 'hex'); const b = scryptSync(p, s, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function ensureAdmin() {
  const { rowCount } = await pool.query('SELECT 1 FROM utente LIMIT 1');
  if (!rowCount) await pool.query(`INSERT INTO utente(username,password_hash,ruolo) VALUES ($1,$2,'admin')`, [config.adminUser, hashPassword(config.adminPassword)]);
}

export type Ruolo = 'admin' | 'sportello' | 'fatturazione' | 'amministrazione' | 'tecnico';
export const utenteDi = (r: FastifyRequest) => (r.user as { username: string; ruolo: Ruolo });

/** Guard per ruolo; admin passa sempre. */
export const ruoli = (...ammessi: Ruolo[]) => async (req: FastifyRequest, reply: any) => {
  const u = utenteDi(req);
  if (u.ruolo !== 'admin' && !ammessi.includes(u.ruolo)) return reply.code(403).send({ errore: 'Permesso negato' });
};

export function authRoutes(app: FastifyInstance) {
  app.post('/api/login', async (req, reply) => {
    const { username, password } = req.body as { username: string; password: string };
    const { rows } = await pool.query('SELECT * FROM utente WHERE username=$1 AND attivo', [username]);
    if (!rows[0] || !verifyPassword(password ?? '', rows[0].password_hash)) return reply.code(401).send({ errore: 'Credenziali non valide' });
    return { token: app.jwt.sign({ username, ruolo: rows[0].ruolo }, { expiresIn: '12h' }), ruolo: rows[0].ruolo, username };
  });
}
