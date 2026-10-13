import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../src/db.js';
import { seed } from '../src/seed.js';
import { build } from '../src/index.js';

let app: Awaited<ReturnType<typeof build>>; let token = '';
const call = async (method: string, url: string, payload?: unknown) => {
  const r = await app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` } });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body };
};
const ok = async (m: string, u: string, p?: unknown) => { const r = await call(m, u, p); if (r.status >= 300) throw new Error(`${m} ${u} → ${r.status} ${JSON.stringify(r.body)}`); return r.body; };

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await seed(true);
  app = await build();
  token = (await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'admin' } })).json().token;
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('API', () => {
  it('rifiuta richieste senza token', async () => expect((await app.inject({ url: '/api/anagrafica' })).statusCode).toBe(401));
});

describe('GPL: ciclo completo', () => {
  let f: any, k: any, anag: any, runId: number, docId: number;
  it('anagrafica, fornitura, contatore, letture', async () => {
    const cat = (await ok('GET', '/api/categoria_cliente')).find((c: any) => c.codice === 'PRIV');
    anag = await ok('POST', '/api/anagrafica', { codice: 'C001', tipo: 'privato', denominazione: 'Mario Rossi', codice_fiscale: 'RSSMRA80A01H501U', categoria_id: cat.id });
    const comuni = await ok('GET', '/api/comune'); const alto = comuni.find((c: any) => c.zona_montana);
    const tar = (await ok('GET', '/api/tariffa?servizio=GPL')).find((t: any) => t.codice === 'GPL-USO');
    const ciclo = (await ok('GET', '/api/ciclo_fatturazione?servizio=GPL')).find((c: any) => c.codice === '1');
    f = await ok('POST', '/api/fornitura', { codice: 'G0001', servizio: 'GPL', anagrafica_id: anag.id, tariffa_id: tar.id, ciclo_id: ciclo.id, comune_id: alto.id, iva_pct: 10, uso: 'cottura_acs' });
    k = await ok('POST', '/api/contatore', { fornitura_id: f.id, matricola: 'M-GPL-1', um_lettura: 'mc', lettura_iniziale: 100, data_lettura_iniziale: '2025-01-01' });
    const imp = await ok('POST', '/api/letture/import', { testo: 'M-GPL-1;01/03/2025;150\nXXX;01/03/2025;5\nM-GPL-1;rotto;oops' });
    expect(imp.importate).toBe(1); expect(imp.scartate).toBe(2);
  });
  it('prova: Smc = 50 mc × C 0,927; accisa e sconto montano; scadenza 20gg', async () => {
    const r = await ok('POST', '/api/fatturazione/prova', { servizio: 'GPL', data_documento: '2025-03-05', data_fino: '2025-03-05' });
    expect(r.n_documenti).toBe(1); runId = r.run_id;
    const { documenti } = await ok('GET', `/api/fatturazione/${runId}`); docId = documenti[0].id;
    const d = await ok('GET', `/api/documenti/${docId}`);
    expect(d.stato).toBe('prova'); expect(d.numero).toBeNull();
    const cons = d.righe.find((x: any) => x.tipo_riga === 'consumo');
    expect(cons.quantita).toBe(46.35);                        // 50 × 0.927
    expect(d.righe.find((x: any) => x.tipo_riga === 'sconto_zone_montane').fuori_campo_iva).toBe(true);
    expect(d.righe.find((x: any) => x.tipo_riga === 'quota_fissa').quantita).toBe(2);   // 01/01→05/03 ≈ 2 mesi + 4/30
    expect(d.scadenza.slice(0, 10)).toBe('2025-03-25');
    expect(Math.abs(d.totale - (d.imponibile + d.iva + d.fuori_campo_iva))).toBeLessThan(0.006);
  });
  it('conferma: numerazione e letture agganciate; seconda prova non rifattura', async () => {
    await ok('POST', `/api/fatturazione/${runId}/conferma`);
    const d = await ok('GET', `/api/documenti/${docId}`);
    expect(d.stato).toBe('emesso'); expect(d.numero).toBe(1); expect(d.anno).toBe(2025);
    const r2 = await ok('POST', '/api/fatturazione/prova', { servizio: 'GPL', data_documento: '2025-03-06', data_fino: '2025-03-06' });
    expect(r2.n_documenti).toBe(0);
    expect(r2.anomalie.some((a: any) => a.codice === 'lettura_mancante')).toBe(true);
    await ok('DELETE', `/api/fatturazione/${r2.run_id}`);
  });
  it('XML FatturaPA e SEPA', async () => {
    const x = await call('GET', `/api/documenti/${docId}/fatturapa.xml`);
    expect(x.status).toBe(400);   // cedente non configurato → errore esplicito
    await ok('PUT', '/api/impostazione/cedente', { valore: { denominazione: 'Gestore SpA', partita_iva: '01234567890', codice_fiscale: '01234567890', indirizzo: 'Via X 1', cap: '32100', comune: 'Belluno', provincia: 'BL', regime_fiscale: 'RF01', iban: 'IT60X0542811101000000123456', creditor_id_sepa: 'IT12ZZZ0000001234567890' } });
    const ok2 = await app.inject({ url: `/api/documenti/${docId}/fatturapa.xml`, headers: { authorization: `Bearer ${token}` } });
    expect(ok2.body).toContain('<TipoDocumento>TD01</TipoDocumento>'); expect(ok2.body).toContain('<Natura>N2.2</Natura>');
  });
  it('mora, incasso Poste con abbinamento, residuo', async () => {
    const d = await ok('GET', `/api/documenti/${docId}`);
    const mora = await ok('POST', '/api/crediti/mora', { servizio: 'GPL', alla_data: '2025-06-25', scrivi: true });
    expect(mora).toHaveLength(1); expect(mora[0].tasso_pct).toBeCloseTo(5.1, 5);   // GPL: interesse legale 1,6 + maggiorazione 3,5
    expect(mora[0].da_abbinare ?? mora[0].da_addebitare).toBeGreaterThan(0);
    const imp = await ok('POST', '/api/incassi/import', { formato: 'poste', testo: `1;${d.totale};25/03/2025\n999;10,00`, data: '2025-03-20' });
    expect(imp.abbinati).toBe(1); expect(imp.da_abbinare).toBe(1);
    expect((await ok('GET', `/api/documenti/${docId}`)).residuo).toBe(0);
  });
  it('accise mensili: Smc per comune → kg', async () => {
    const a = await ok('GET', '/api/dichiarazioni/accise-mensile?anno=2025&mese=3');
    expect(a.totale_smc).toBe(46.35); expect(a.totale_kg).toBeCloseTo(46.35 * 1.9, 1);
  });
  it('nota di credito compensa il residuo', async () => {
    const nc = await ok('POST', `/api/documenti/${docId}/nota-credito`, { data: '2025-04-01' });
    expect(nc.numero).toBe(2);
    const dd = await ok('GET', `/api/documenti/${docId}`);
    expect(dd.residuo).toBeCloseTo(-dd.totale, 2);   // pagata per intero e poi stornata: credito verso cliente = totale
  });
  it('SAP emesso: piano conti applicato, dare = avere', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/sap/emesso', payload: { servizio: 'GPL', da: '2025-01-01', a: '2025-12-31', definitivo: true }, headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(200);
    const righe = r.body.replace('﻿', '').split('\r\n').slice(1).map(l => l.split(';'));
    const num = (s: string) => parseFloat(s.replace(',', '.') || '0');
    const dare = righe.reduce((s, c) => s + num(c[5]), 0), avere = righe.reduce((s, c) => s + num(c[6]), 0);
    expect(Math.abs(dare - avere)).toBeLessThan(0.011);
  });
});

describe('TLR: defalco, crediti d\'imposta, bonus sociale', () => {
  let ids: any = {};
  it('padre + 2 figli', async () => {
    const cat = (await ok('GET', '/api/categoria_cliente')).find((c: any) => c.codice === 'AZ');
    const tar = (await ok('GET', '/api/tariffa?servizio=TLR'))[0]; const ciclo = (await ok('GET', '/api/ciclo_fatturazione?servizio=TLR'))[0];
    const mk = async (cod: string) => {
      const a = await ok('POST', '/api/anagrafica', { codice: 'T' + cod, tipo: 'azienda', denominazione: 'Cond ' + cod, codice_fiscale: 'CF' + cod, categoria_id: cat.id });
      const f = await ok('POST', '/api/fornitura', { codice: 'TLR' + cod, servizio: 'TLR', anagrafica_id: a.id, tariffa_id: tar.id, ciclo_id: ciclo.id, iva_pct: 10, portata_kw: 30 });
      return { a, f };
    };
    const P = await mk('P'), A = await mk('A'), B = await mk('B');
    const kp = await ok('POST', '/api/contatore', { fornitura_id: P.f.id, matricola: 'KP', fatturabile: false, lettura_iniziale: 0, data_lettura_iniziale: '2027-01-01' });
    const ka = await ok('POST', '/api/contatore', { fornitura_id: A.f.id, matricola: 'KA', padre_id: kp.id, lettura_iniziale: 0, data_lettura_iniziale: '2027-01-01' });
    const kb = await ok('POST', '/api/contatore', { fornitura_id: B.f.id, matricola: 'KB', padre_id: kp.id, lettura_iniziale: 0, data_lettura_iniziale: '2027-01-01' });
    ids = { P, A, B, kp, ka, kb };
    await ok('POST', '/api/letture/import', { testo: '2027-03-01;;\nKP;2027-03-01;1000\nKA;2027-03-01;300\nKB;2027-03-01;100' });
    // bonus sociale dal flusso: CF deve coincidere
    const flusso = await ok('POST', '/api/bonus-sociale/flusso', { nome_file: 'f.csv', testo: `codice_fiscale;codice_fornitura;valido_dal;valido_al;importo;protocollo\nCFA;TLRA;2027-01-01;2027-12-31;365,00;P1\nSBAGLIATO;TLRB;2027-01-01;2027-12-31;100;P2` });
    expect(flusso.acquisite).toBe(1); expect(flusso.scarti[0].motivo).toMatch(/codice fiscale/);
  });
  it('prova: padre non fatturato, differenza ripartita 3:1, crediti e bonus', async () => {
    const r = await ok('POST', '/api/fatturazione/prova', { servizio: 'TLR', data_documento: '2027-03-05', data_fino: '2027-03-01' });
    expect(r.n_documenti).toBe(2);                                     // solo i figli
    const def = await ok('GET', `/api/fatturazione/${r.run_id}/defalco`);
    expect(def.map((x: any) => [x.consumo_proprio, x.quota_ripartita, x.consumo_fatturato])).toEqual([[300, 450, 750], [100, 150, 250]]);
    const { documenti } = await ok('GET', `/api/fatturazione/${r.run_id}`);
    const dA = await ok('GET', `/api/documenti/${documenti.find((d: any) => d.fornitura === 'TLRA').id}`);
    const per = (t: string) => dA.righe.filter((x: any) => x.tipo_riga === t);
    expect(per('consumo')[0].quantita).toBe(750);
    expect(per('credito_imposta')).toHaveLength(2);
    expect(per('credito_imposta')[0].imponibile).toBe(-7.5);          // 750 × 0.01
    expect(per('bonus_sociale')).toHaveLength(1); expect(per('bonus_sociale')[0].imponibile).toBeLessThan(0);
    const dB = await ok('GET', `/api/documenti/${documenti.find((d: any) => d.fornitura === 'TLRB').id}`);
    expect(dB.righe.some((x: any) => x.tipo_riga === 'bonus_sociale')).toBe(false);  // flusso scartato
    await ok('POST', `/api/fatturazione/${r.run_id}/conferma`);
    const dich = await ok('GET', '/api/dichiarazioni/tlr-annuale?anno=2027');
    expect(dich.righe.reduce((s: number, x: any) => s + x.kwh_fatturati, 0)).toBe(1000);
  });
});
