import { pool } from '../db.js';
import { loadParametri } from '../services/impostazioni.js';
import { r2, r3 } from '../engine/types.js';

/** Dichiarazione mensile accise GPL: Smc fatturati per comune → kg (coefficiente fisso `smc_kg`). */
export async function acciseMensile(anno: number, mese: number) {
  const param = await loadParametri(); const fine = new Date(Date.UTC(anno, mese, 0)).toISOString().slice(0, 10);
  const kg = param('smc_kg', fine); if (!kg) throw Object.assign(new Error('Parametro smc_kg non definito'), { statusCode: 400 });
  const { rows } = await pool.query(
    `SELECT co.codice_istat, co.nome AS comune, sum(r.quantita) AS smc, count(DISTINCT d.id) AS n_documenti
       FROM documento d JOIN documento_riga r ON r.documento_id=d.id AND r.tipo_riga='consumo'
       JOIN fornitura f ON f.id=d.fornitura_id LEFT JOIN comune co ON co.id=f.comune_id
      WHERE d.servizio='GPL' AND d.stato='emesso' AND extract(year from d.data_documento)=$1 AND extract(month from d.data_documento)=$2
      GROUP BY co.codice_istat, co.nome ORDER BY co.nome`, [anno, mese]);
  const out = rows.map(r => ({ ...r, smc: r3(r.smc), kg: r2(r.smc * kg) }));
  return { anno, mese, coefficiente_smc_kg: kg, righe: out, totale_smc: r3(out.reduce((s, r) => s + r.smc, 0)), totale_kg: r2(out.reduce((s, r) => s + r.kg, 0)) };
}

/** Dichiarazione annuale Dogane (rimborso differenza accisa): per fornitura, volumi dal 1/1 al 31/12 convertiti in kg, con dati fornitura. */
export async function acciseAnnuale(anno: number) {
  const param = await loadParametri(); const kg = param('smc_kg', `${anno}-12-31`);
  if (!kg) throw Object.assign(new Error('Parametro smc_kg non definito'), { statusCode: 400 });
  const { rows } = await pool.query(
    `SELECT f.codice AS fornitura, a.denominazione, a.codice_fiscale, a.partita_iva, f.pod_pdr, f.uso, f.iva_pct, co.nome AS comune, co.codice_istat, co.zona_montana,
            f.ind_via||' '||COALESCE(f.ind_civico,'') AS indirizzo,
            string_agg(DISTINCT d.numero||'/'||d.anno, ', ') AS documenti, sum(r.quantita) AS smc
       FROM documento d JOIN documento_riga r ON r.documento_id=d.id AND r.tipo_riga='consumo'
       JOIN fornitura f ON f.id=d.fornitura_id JOIN anagrafica a ON a.id=d.anagrafica_id LEFT JOIN comune co ON co.id=f.comune_id
      WHERE d.servizio='GPL' AND d.stato='emesso' AND d.data_documento BETWEEN make_date($1,1,1) AND make_date($1,12,31)
      GROUP BY f.id, a.id, co.id ORDER BY f.codice`, [anno]);
  return { anno, coefficiente_smc_kg: kg, righe: rows.map(r => ({ ...r, smc: r3(r.smc), kg: r2(r.smc * kg) })) };
}

/** Dichiarazione annuale TLR: volumi, misuratori, consumi per competenza, potenza, IVA, agevolazioni. */
export async function dichiarazioneTlr(anno: number) {
  const { rows } = await pool.query(
    `SELECT f.codice AS fornitura, a.denominazione, a.codice_fiscale, a.partita_iva, f.ind_via||' '||COALESCE(f.ind_civico,'') AS indirizzo,
            f.portata_kw, f.potenza_impianto_kw,
            (SELECT string_agg(matricola, ', ') FROM contatore k WHERE k.fornitura_id=f.id) AS matricole,
            COALESCE(sum(r.quantita) FILTER (WHERE r.tipo_riga='consumo'),0) AS kwh_fatturati,
            COALESCE(sum(r.imponibile) FILTER (WHERE r.tipo_riga='consumo'),0) AS imponibile_consumi,
            COALESCE(sum(r.imponibile) FILTER (WHERE r.tipo_riga='quota_fissa'),0) AS imponibile_quota_fissa,
            COALESCE(sum(r.iva),0) AS iva_applicata, max(r.iva_pct) AS aliquota_iva,
            COALESCE(-sum(r.imponibile) FILTER (WHERE r.tipo_riga='credito_imposta'),0) AS crediti_imposta,
            COALESCE(-sum(r.imponibile) FILTER (WHERE r.tipo_riga='bonus_sociale'),0) AS bonus_sociale
       FROM documento_riga r JOIN documento d ON d.id=r.documento_id JOIN fornitura f ON f.id=d.fornitura_id JOIN anagrafica a ON a.id=d.anagrafica_id
      WHERE d.servizio='TLR' AND d.stato='emesso' AND extract(year from COALESCE(r.competenza_a, d.data_documento))=$1
      GROUP BY f.id, a.id ORDER BY f.codice`, [anno]);
  return { anno, righe: rows };
}
