import { pool } from './db.js';
import { migrate } from './migrate.js';
import { ensureAdmin } from './auth.js';

/** Configurazione di base + dati demo. Valori numerici di tariffe/accise/crediti sono PLACEHOLDER da sostituire con quelli reali. */
export async function seed(demo = true, dati = false) {
  await migrate(); await ensureAdmin();
  const q = (s: string, a: unknown[] = []) => pool.query(s, a);
  await q(`INSERT INTO categoria_cliente(codice,descrizione,giorni_scadenza,esente_mora,pubblica_amministrazione) VALUES
    ('PRIV','Privati',20,false,false),('AZ','Aziende',30,false,false),('PA30','Ente pubblico 30 gg',30,true,true),('PA90','Ente pubblico 90 gg',90,true,true) ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO ciclo_fatturazione(servizio,codice,descrizione,mesi_periodo) VALUES ('GPL','1','Ciclo 1 – mensili',1),('GPL','2','Ciclo 2 – quadrimestrali',4),('TLR','1','TLR – periodico',2) ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO tariffa(servizio,codice,descrizione) VALUES ('GPL','GPL-USO','GPL uso'),('GPL','GPL-PUB','GPL uso pubblico (sconto 15% incluso)'),('TLR','TLR-STD','TLR standard') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO parametro(codice,valido_dal,valore,note) VALUES
    ('tasso_bce','2025-01-01',2.15,'Tasso BCE'),('interesse_legale','2025-01-01',1.6,'Interesse legale'),('maggiorazione_mora','2025-01-01',3.5,'Maggiorazione mora'),
    ('accisa_gpl_smc','2025-01-01',0.18,'PLACEHOLDER: accisa €/Smc'),('sconto_zone_montane_smc','2025-01-01',0.05,'PLACEHOLDER: sconto zone montane €/Smc'),
    ('smc_kg','2025-01-01',1.9,'PLACEHOLDER: coefficiente fisso Smc→kg'),
    ('credito_imposta_1_kwh','2025-01-01',0.01,'PLACEHOLDER: credito d''imposta 1 €/kWh'),('credito_imposta_2_kwh','2025-01-01',0.005,'PLACEHOLDER: credito d''imposta 2 €/kWh') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO piano_conti(servizio,chiave,conto_sap,descrizione) VALUES
    (NULL,'cliente','1210000','Crediti vs clienti'),(NULL,'iva','2610000','IVA a debito'),
    (NULL,'incasso:bonifico','1110001','Banca c/c'),(NULL,'incasso:sepa','1110001','Banca c/c'),(NULL,'incasso:postale','1110002','C/c postale'),(NULL,'incasso:pagopa','1110001','Banca c/c'),(NULL,'incasso:contanti','1110003','Cassa'),(NULL,'incasso:altro','1110001','Banca c/c'),
    ('TLR','consumo','4100001','Ricavi calore'),('TLR','quota_fissa','4100002','Ricavi quota fissa TLR'),('TLR','credito_imposta','4100003','Crediti d''imposta'),('TLR','bonus_sociale','4100004','Bonus sociale TLR'),
    ('TLR','acconto','2200001','Acconti TLR'),('TLR','scomputo_acconto','2200001','Acconti TLR'),('TLR','addebito','4900001','Altri addebiti'),('TLR','accredito','4900001','Altri addebiti'),('TLR','preventivo','4200001','Lavori e prestazioni'),
    ('GPL','consumo','4300001','Ricavi GPL'),('GPL','quota_fissa','4300002','Ricavi quota fissa GPL'),('GPL','accisa','4300003','Accise GPL'),('GPL','sconto_zone_montane','4300004','Sconto zone montane'),
    ('GPL','acconto','2200002','Acconti GPL'),('GPL','scomputo_acconto','2200002','Acconti GPL'),('GPL','addebito','4900002','Altri addebiti'),('GPL','accredito','4900002','Altri addebiti'),('GPL','preventivo','4200002','Lavori e prestazioni') ON CONFLICT DO NOTHING`);
  const tv = (cod: string, regole: unknown) => q(`INSERT INTO tariffa_versione(tariffa_id,valido_dal,regole) SELECT id,'2025-01-01',$2 FROM tariffa WHERE codice=$1 ON CONFLICT DO NOTHING`, [cod, JSON.stringify(regole)]);
  await tv('GPL-USO', { servizio: 'GPL', prezzo_smc: 1.2, quota_fissa_mese: 4 });
  await tv('GPL-PUB', { servizio: 'GPL', prezzo_smc: 1.02, sconto_incluso_pct: 15, quota_fissa_mese: 4 });
  await tv('TLR-STD', { servizio: 'TLR', scaglioni_base: 'annuo', scaglioni: [{ fino_a: 10000, prezzo: 0.1 }, { fino_a: null, prezzo: 0.08 }],
    quota_fissa: [{ portata_fino_a_kw: 20, importo_mese: 10 }, { portata_fino_a_kw: 50, importo_mese: 25 }, { portata_fino_a_kw: null, importo_mese: 60 }],
    crediti_imposta: [{ codice_parametro: 'credito_imposta_1_kwh', descrizione: 'Credito d\'imposta 1' }, { codice_parametro: 'credito_imposta_2_kwh', descrizione: 'Credito d\'imposta 2' }] });
  if (!demo) return;
  await q(`INSERT INTO comune(codice_istat,nome,provincia,zona_montana) VALUES ('025001','Comune Alto','BL',true),('025002','Comune Valle','BL',false) ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO coefficiente_c(comune_id,valido_dal,valore) SELECT id,'2025-01-01', CASE codice_istat WHEN '025001' THEN 0.9270 ELSE 1.0010 END FROM comune ON CONFLICT DO NOTHING`);
  if (dati) await seedDatiDemo();
}

/** Clienti, forniture, letture e uno storico già fatturato (con insoluti) per provare l'app. Solo se il DB è vuoto. */
async function seedDatiDemo() {
  const q = (s: string, a: unknown[] = []) => pool.query(s, a);
  if ((await q('SELECT count(*)::int AS n FROM anagrafica')).rows[0].n > 0) return;
  const id = async (sql: string, a: unknown[] = []) => (await q(sql, a)).rows[0].id as number;
  const cat = async (c: string) => id('SELECT id FROM categoria_cliente WHERE codice=$1', [c]);
  const tar = async (c: string) => id('SELECT id FROM tariffa WHERE codice=$1', [c]);
  const ciclo = async (s: string, c: string) => id('SELECT id FROM ciclo_fatturazione WHERE servizio=$1 AND codice=$2', [s, c]);
  const com = async (c: string) => id('SELECT id FROM comune WHERE codice_istat=$1', [c]);
  const cliente = (cod: string, tipo: string, nome: string, cf: string, cat_: number, via: string, extra: Record<string, unknown> = {}) =>
    id(`INSERT INTO anagrafica(codice,tipo,denominazione,codice_fiscale,partita_iva,categoria_id,ind_via,ind_civico,ind_cap,ind_comune,ind_prov,email,codice_destinatario,codice_ipa) VALUES ($1,$2,$3,$4,$5,$6,$7,'1','32100',$8,'BL',$9,$10,$11) RETURNING id`,
      [cod, tipo, nome, cf, extra.piva ?? null, cat_, via, extra.comune ?? 'Belluno', extra.email ?? null, extra.sdi ?? '0000000', extra.ipa ?? null]);
  const forn = (cod: string, srv: string, an: number, t: number, c: number, comune: number | null, uso: string, iva: number, via: string, portata: number | null = null) =>
    id(`INSERT INTO fornitura(codice,servizio,anagrafica_id,tariffa_id,ciclo_id,comune_id,uso,iva_pct,ind_via,ind_civico,portata_kw,potenza_impianto_kw,data_attivazione) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'1',$10,$10,'2020-01-01') RETURNING id`,
      [cod, srv, an, t, c, comune, uso, iva, via, portata]);
  const cont = (f: number, mat: string, um: string, ini: number, padre: number | null = null, fatt = true) =>
    id(`INSERT INTO contatore(fornitura_id,matricola,um_lettura,cifre,padre_id,fatturabile,lettura_iniziale,data_lettura_iniziale) VALUES ($1,$2,$3,6,$4,$5,$6,'2026-01-01') RETURNING id`, [f, mat, um, padre, fatt, ini]);
  const lett = (c: number, data: string, v: number) => q(`INSERT INTO lettura(contatore_id,data_lettura,valore,origine) VALUES ($1,$2,$3,'demo')`, [c, data, v]);

  const [PRIV, AZ, PA30, PA90] = await Promise.all(['PRIV', 'AZ', 'PA30', 'PA90'].map(cat));
  const alto = await com('025001'), valle = await com('025002');
  const gUso = await tar('GPL-USO'), gPub = await tar('GPL-PUB'), tStd = await tar('TLR-STD');
  const g1 = await ciclo('GPL', '1'), g2 = await ciclo('GPL', '2'), t1 = await ciclo('TLR', '1');

  // ---- GPL ----
  const gpl: [string, string, string, string, number, number, number, number, string, number, number, number, number][] = [
    // cod, tipo, nome, cf, categoria, tariffa, ciclo, comune, uso, iva, lettura iniziale, lettura 30/06, lettura 30/09
    ['GPL-001', 'privato', 'Rossi Mario', 'RSSMRA70A01A757X', PRIV, gUso, g1, alto, 'cottura_acs', 10, 100, 130, 152],
    ['GPL-002', 'privato', 'Bianchi Anna', 'BNCNNA65B41A757Y', PRIV, gUso, g1, alto, 'riscaldamento', 22, 500, 640, 655],
    ['GPL-003', 'ente_pubblico', 'Comune di Valle – scuola', '00123450251', PA30, gPub, g1, valle, 'pubblico', 22, 2000, 2310, 2330],
    ['GPL-004', 'azienda', 'Trattoria Alpina snc', '01234560259', AZ, gUso, g2, alto, 'riscaldamento', 22, 800, 1180, 1190],
    ['GPL-005', 'privato', 'Verdi Luca', 'VRDLCU80C10A757Z', PRIV, gUso, g1, valle, 'cottura_acs', 10, 50, 66, 79],
  ];
  const gplIds: number[] = [];
  for (const [cod, tipo, nome, cf, c, t, cl, cm, uso, iva, l0, l1, l2] of gpl) {
    const a = await cliente('C-' + cod, tipo, nome, cf, c, 'Via Roma', { piva: tipo === 'azienda' ? cf : null, comune: cm === alto ? 'Comune Alto' : 'Comune Valle', ipa: tipo === 'ente_pubblico' ? 'UF1234' : null, sdi: tipo === 'ente_pubblico' ? '0000000' : '0000000' });
    const f = await forn(cod, 'GPL', a, t, cl, cm, uso, iva, 'Via Roma');
    const k = await cont(f, 'MG-' + cod.slice(-3), 'mc', l0);
    await lett(k, '2026-06-30', l1); await lett(k, '2026-09-30', l2); gplIds.push(a);
  }
  await q(`INSERT INTO domiciliazione(anagrafica_id,iban,intestatario,mandato_sepa,data_mandato) VALUES ($1,'IT60X0542811101000000123456','Rossi Mario','MND-001','2024-03-01')`, [gplIds[0]]);

  // ---- TLR: centrale condominiale con contatore padre e due sottostazioni figlie, + utenza autonoma ----
  const cond = await cliente('C-TLR-COND', 'condominio', 'Condominio Centrale Via Roma', '90012340251', PRIV, 'Via Roma');
  const paolo = await cliente('C-TLR-001', 'privato', 'Rossi Paolo', 'RSSPLA75D15A757K', PRIV, 'Via Roma');
  const hotel = await cliente('C-TLR-002', 'azienda', 'Hotel Dolomiti srl', '01122330252', AZ, 'Via Roma', { piva: '01122330252' });
  const scuola = await cliente('C-TLR-003', 'ente_pubblico', 'Comune di Valle – palestra', '00123450251', PA90, 'Via Sport', { ipa: 'UF5678' });
  const fP = await forn('TLR-P', 'TLR', cond, tStd, t1, null, 'altro', 10, 'Via Roma', 200);
  const f1 = await forn('TLR-001', 'TLR', paolo, tStd, t1, null, 'domestico', 10, 'Via Roma', 15);
  const f2 = await forn('TLR-002', 'TLR', hotel, tStd, t1, null, 'altro', 10, 'Via Roma', 80);
  const f3 = await forn('TLR-003', 'TLR', scuola, tStd, t1, null, 'altro', 10, 'Via Sport', 40);
  const kP = await cont(fP, 'KP-CENTRALE', 'kWh', 0, null, false);
  const k1 = await cont(f1, 'KT-001', 'kWh', 0, kP), k2 = await cont(f2, 'KT-002', 'kWh', 0, kP), k3 = await cont(f3, 'KT-003', 'kWh', 0);
  for (const [k, a, b] of [[kP, 60000, 130000], [k1, 12000, 26000], [k2, 30000, 62000], [k3, 15000, 24000]] as const) { await lett(k, '2026-06-30', a); await lett(k, '2026-09-30', b); }
  await q(`INSERT INTO bonus_sociale(fornitura_id,codice_fiscale,valido_dal,valido_al,importo_totale,protocollo) VALUES ($1,'RSSPLA75D15A757K','2026-01-01','2026-12-31',120,'DEMO-1')`, [f1]);

  // ---- Altro ----
  await q(`INSERT INTO listino(servizio,codice,descrizione,um,prezzo,iva_pct) VALUES ('GPL','ALL-GPL','Allacciamento utenza GPL','nr',350,22),('GPL','SOP','Sopralluogo tecnico','nr',60,22),('TLR','ALL-TLR','Allacciamento utenza TLR','nr',900,22),('TLR','SOST-CNT','Sostituzione contatore','nr',180,22) ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO odi(servizio,tipo,fornitura_id,descrizione) SELECT 'GPL','sopralluogo',id,'Verifica impianto' FROM fornitura WHERE codice='GPL-004'`);
  await q(`UPDATE impostazione SET valore=$1 WHERE chiave='cedente'`, [JSON.stringify({ denominazione: 'DEMO Gestore SpA', partita_iva: '01234567890', codice_fiscale: '01234567890', indirizzo: 'Via Demo 1', cap: '32100', comune: 'Belluno', provincia: 'BL', regime_fiscale: 'RF01', iban: 'IT60X0542811101000000123456', creditor_id_sepa: 'IT12ZZZ0000001234567890' })]);

  // ---- Storico: fatturazione del 1° semestre già emessa (scadenze passate → insoluti, mora, solleciti da provare) ----
  const { creaProva, confermaRun } = await import('./services/billing.js');
  for (const servizio of ['GPL', 'TLR'] as const) {
    const r = await creaProva({ servizio, data_documento: '2026-07-10', data_fino: '2026-06-30' }, 'demo');
    await confermaRun(r.run_id, 'demo');
  }
  // il Comune di Valle (GPL-003) e Rossi Mario (GPL-001) hanno pagato; gli altri risultano insoluti
  const { importaIncassi } = await import('./services/crediti.js');
  const pagati = (await q(`SELECT d.numero, d.totale FROM documento d JOIN fornitura f ON f.id=d.fornitura_id WHERE f.codice IN ('GPL-001','GPL-003') AND d.stato='emesso'`)).rows;
  await importaIncassi(pagati.map(d => ({ data: '2026-08-05', importo: d.totale, riferimento: String(d.numero), canale: 'postale' })), null, 'demo', 'GPL');
}
if (process.argv[1]?.endsWith('seed.ts')) seed(!process.argv.includes('--no-demo'), process.argv.includes('--dati')).then(() => { console.log('seed ok'); return pool.end(); }).catch(e => { console.error(e); process.exit(1); });
