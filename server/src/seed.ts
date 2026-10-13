import { pool } from './db.js';
import { migrate } from './migrate.js';
import { ensureAdmin } from './auth.js';

/** Configurazione di base + dati demo. Valori numerici di tariffe/accise/crediti sono PLACEHOLDER da sostituire con quelli reali. */
export async function seed(demo = true) {
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
}
if (process.argv[1]?.endsWith('seed.ts')) seed(process.argv[2] !== '--no-demo').then(() => { console.log('seed ok'); return pool.end(); }).catch(e => { console.error(e); process.exit(1); });
