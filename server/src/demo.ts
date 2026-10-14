/** Avvio "tutto in uno" per provare l'app senza installare PostgreSQL: DB incorporato + dati demo + server. */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const radice = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = resolve(radice, '.demo-data');
const porta = Number(process.env.PG_PORT ?? 54329);
const nuovo = !existsSync(resolve(dir, 'PG_VERSION'));

const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'gest', password: 'gest', port: porta, persistent: true, onLog: () => {}, onError: m => console.error(String(m)) });
if (nuovo) { console.log('Creo il database demo (solo la prima volta)…'); await pg.initialise(); }
await pg.start();
if (nuovo) await pg.createDatabase('gestionale');

process.env.DATABASE_URL = `postgres://gest:gest@localhost:${porta}/gestionale`;
process.env.WEB_DIR = resolve(radice, 'web/dist');
if (!existsSync(resolve(radice, 'web/dist/index.html'))) { console.log('Compilo il frontend…'); execSync('npm -w web run build', { cwd: radice, stdio: 'inherit' }); }

const { seed } = await import('./seed.js');
await seed(true, true);
const { build } = await import('./index.js');
const { config } = await import('./config.js');
const app = await build();
await app.listen({ port: config.port, host: '127.0.0.1' });
console.log(`\n  Gestionale pronto:  http://localhost:${config.port}\n  Utente: admin   Password: admin\n  (CTRL+C per fermare)\n`);

const stop = async () => { await app.close(); await pg.stop(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
