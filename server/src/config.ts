export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://gest:gest@localhost:5432/gestionale',
  jwtSecret: process.env.JWT_SECRET ?? 'cambiami-in-produzione',
  /** TLR | GPL | BOTH: restringe i servizi esposti dall'istanza (stesso codice, istanze separate) */
  serviziAttivi: (process.env.SERVIZI ?? 'BOTH').toUpperCase(),
  adminUser: process.env.ADMIN_USER ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'admin',
  webDir: process.env.WEB_DIR ?? '../web/dist',
};
export const servizioAmmesso = (s: string) => config.serviziAttivi === 'BOTH' || config.serviziAttivi === s;
