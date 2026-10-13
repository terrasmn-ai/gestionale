import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import fstatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { config } from './config.js';
import { authRoutes, ensureAdmin } from './auth.js';
import { migrate } from './migrate.js';
import { registraRisorse } from './routes/risorse.js';
import { registraOperazioni } from './routes/operazioni.js';

export async function build() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 20 * 1024 * 1024 });
  await app.register(cors);
  await app.register(jwt, { secret: config.jwtSecret });
  authRoutes(app);
  app.addHook('onRequest', async (req, rep) => {
    if (!req.url.startsWith('/api/') || req.url === '/api/login' || req.url === '/api/health') return;
    try { await req.jwtVerify(); } catch { return rep.code(401).send({ errore: 'Non autenticato' }); }
  });
  app.get('/api/health', async () => ({ ok: true }));
  registraRisorse(app);
  registraOperazioni(app);
  app.setErrorHandler((e: any, _req, rep) => {
    if (e instanceof ZodError) return rep.code(400).send({ errore: 'Dati non validi', dettagli: e.issues });
    if (e.code === '23505') return rep.code(409).send({ errore: 'Valore duplicato', dettaglio: e.detail });
    if (e.code === '23503') return rep.code(409).send({ errore: 'Riferimento non valido o record in uso', dettaglio: e.detail });
    if (e.code?.startsWith('23')) return rep.code(400).send({ errore: 'Vincolo violato', dettaglio: e.detail ?? e.message });
    rep.code(e.statusCode ?? 500).send({ errore: e.message });
  });
  const dir = resolve(config.webDir);
  if (existsSync(dir)) {
    await app.register(fstatic, { root: dir });
    app.setNotFoundHandler((req, rep) => req.url.startsWith('/api/') ? rep.code(404).send({ errore: 'Non trovato' }) : rep.sendFile('index.html'));
  }
  return app;
}

if (process.argv[1]?.endsWith('index.ts')) {
  await migrate(); await ensureAdmin();
  const app = await build();
  await app.listen({ port: config.port, host: '0.0.0.0' });
}
