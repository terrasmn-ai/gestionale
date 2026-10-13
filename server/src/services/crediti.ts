import { pool, tx } from '../db.js';
import { getImpostazione, loadParametri } from './impostazioni.js';
import { calcolaMora, tassoMora } from '../engine/mora.js';
import { addDays } from '../engine/common.js';
import { r2 } from '../engine/types.js';

/** Calcola la mora sui documenti scaduti e genera partite di addebito (fuori campo IVA) per la prossima fatturazione. */
export async function calcolaMoraBatch(servizio: 'TLR' | 'GPL', alla_data: string, scrivi: boolean, utente: string) {
  const param = await loadParametri();
  const comp = await getImpostazione<string[]>(`mora_componenti_${servizio}`);
  const tolleranza = Number(await getImpostazione('giorni_tolleranza_mora') ?? 0);
  const { rows } = await pool.query(
    `SELECT d.id, d.numero, d.anno, d.anagrafica_id, d.fornitura_id, d.scadenza::text, d.residuo, d.mora_addebitata, a.denominazione
       FROM v_documento_residuo d JOIN anagrafica a ON a.id=d.anagrafica_id JOIN categoria_cliente c ON c.id=a.categoria_id
      WHERE d.servizio=$1 AND d.stato='emesso' AND d.tipo<>'nota_credito' AND d.residuo>0.005 AND NOT c.esente_mora AND d.scadenza < $2`,
    [servizio, addDays(alla_data, -tolleranza)]);
  const out = rows.map(d => {
    const tasso = tassoMora(comp, d.scadenza, param);
    const dovuta = calcolaMora(d.residuo, d.scadenza, alla_data, tasso);
    return { documento_id: d.id, documento: `${d.numero}/${d.anno}`, cliente: d.denominazione, anagrafica_id: d.anagrafica_id, fornitura_id: d.fornitura_id,
      residuo: d.residuo, scadenza: d.scadenza, tasso_pct: tasso, mora_dovuta: dovuta, gia_addebitata: d.mora_addebitata, da_addebitare: r2(dovuta - d.mora_addebitata) };
  }).filter(x => x.da_addebitare > 0.01);
  if (scrivi) await tx(async c => {
    for (const x of out) {
      await c.query(`INSERT INTO partita(anagrafica_id,fornitura_id,tipo,descrizione,imponibile,iva_pct,fuori_campo_iva,lotto) VALUES ($1,$2,'addebito',$3,$4,0,true,$5)`,
        [x.anagrafica_id, x.fornitura_id, `Interessi di mora fattura ${x.documento} al ${alla_data} (${x.tasso_pct.toFixed(2)}%)`, x.da_addebitare, `mora-${alla_data}`]);
      await c.query(`UPDATE documento SET mora_addebitata = mora_addebitata + $2 WHERE id=$1`, [x.documento_id, x.da_addebitare]);
    }
  }, utente);
  return out;
}

/** Elenco morosi e creazione solleciti (un sollecito per anagrafica, livello progressivo). */
export async function generaSolleciti(servizio: 'TLR' | 'GPL', alla_data: string, scrivi: boolean) {
  const gg = Number(await getImpostazione('giorni_primo_sollecito') ?? 15);
  const { rows } = await pool.query(
    `SELECT d.anagrafica_id, a.denominazione, json_agg(json_build_object('id',d.id,'numero',d.numero,'anno',d.anno,'scadenza',d.scadenza,'residuo',d.residuo) ORDER BY d.scadenza) AS documenti,
            sum(d.residuo) AS totale, (SELECT COALESCE(max(livello),0) FROM sollecito s WHERE s.anagrafica_id=d.anagrafica_id) AS ultimo_livello
       FROM v_documento_residuo d JOIN anagrafica a ON a.id=d.anagrafica_id
      WHERE d.servizio=$1 AND d.stato='emesso' AND d.tipo<>'nota_credito' AND d.residuo>0.005 AND d.scadenza < $2::date - $3::int
      GROUP BY d.anagrafica_id, a.denominazione`, [servizio, alla_data, gg]);
  if (scrivi) for (const r of rows) await pool.query(
    `INSERT INTO sollecito(anagrafica_id,livello,data,documenti,totale,testo) VALUES ($1,$2,$3,$4,$5,$6)`,
    [r.anagrafica_id, r.ultimo_livello + 1, alla_data, JSON.stringify(r.documenti), r2(r.totale),
     `Gentile cliente, risultano non pagate le fatture elencate per un totale di € ${r2(r.totale).toFixed(2)}. Vi invitiamo a regolarizzare.`]);
  return rows.map(r => ({ ...r, totale: r2(r.totale), livello: r.ultimo_livello + 1 }));
}

// ---------- Import incassi ----------
export interface RigaIncasso { data: string; importo: number; riferimento: string; canale: string }

function normData(s: string): string {
  const m = s.match(/^(\d{2})[\/.-](\d{2})[\/.-](\d{4})$/); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const n = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return n ? n[0] : '';
}
const num = (s: string) => parseFloat(s.replace(/\./g, m => (s.includes(',') ? '' : m)).replace(',', '.'));

/** File Poste (txt): per riga `numero_bolletta[;|spazio]importo[;|spazio]data`. Importo e data opzionali. */
export function parsePoste(testo: string, dataDefault: string): RigaIncasso[] {
  return testo.split(/\r?\n/).map(l => l.trim()).filter(Boolean).flatMap(l => {
    const t = l.split(/[;\t, ]+/).filter(Boolean);
    if (!/^\d+(\/\d+)?$/.test(t[0])) return [];
    const imp = t[1] && /^[\d.,]+$/.test(t[1]) ? num(t[1]) : NaN;
    const d = t.map(normData).find(Boolean) ?? dataDefault;
    return [{ data: d, importo: imp, riferimento: t[0], canale: 'postale' }];
  });
}
/** CSV banca (`;`): data;importo;causale  (intestazione opzionale). */
export function parseBanca(testo: string, canale = 'bonifico'): RigaIncasso[] {
  return testo.split(/\r?\n/).map(l => l.trim()).filter(Boolean).flatMap(l => {
    const [d, i, ...c] = l.split(';'); const data = normData((d ?? '').trim());
    if (!data || !i) return [];
    const importo = num(i.trim()); if (!isFinite(importo)) return [];
    return [{ data, importo, riferimento: c.join(';').trim(), canale }];
  });
}

/** Registra gli incassi e prova l'abbinamento automatico per numero fattura (con anno opzionale) e importo. */
export async function importaIncassi(righe: RigaIncasso[], mazzettaId: number | null, utente: string) {
  return tx(async c => {
    let abbinati = 0, daAbbinare = 0;
    const esito: any[] = [];
    for (const r of righe) {
      const tokens = [...r.riferimento.matchAll(/(\d{1,7})(?:\s*[\/-]\s*(\d{4}))?/g)].map(m => ({ numero: Number(m[1]), anno: m[2] ? Number(m[2]) : null }));
      let doc: any = null;
      for (const t of tokens) {
        const { rows } = await c.query(
          `SELECT * FROM v_documento_residuo WHERE stato='emesso' AND tipo<>'nota_credito' AND numero=$1 AND residuo>0.005 AND ($2::int IS NULL OR anno=$2) ORDER BY anno DESC`, [t.numero, t.anno]);
        if (rows.length === 1 || (rows.length > 1 && t.anno === null && rows[0].anno !== rows[1].anno)) { doc = rows[0]; break; }
      }
      const imp = isFinite(r.importo) ? r.importo : doc?.residuo ?? 0;
      const { rows: [inc] } = await c.query(
        `INSERT INTO incasso(data_valuta,importo,canale,riferimento,anagrafica_id,mazzetta_id,origine,stato) VALUES ($1,$2,$3,$4,$5,$6,'import',$7) RETURNING id`,
        [r.data, imp, r.canale, r.riferimento, doc?.anagrafica_id ?? null, mazzettaId, doc ? (imp + 0.005 >= doc.residuo ? 'abbinato' : 'parziale') : 'da_abbinare']);
      if (doc) { await c.query(`INSERT INTO incasso_alloc(incasso_id,documento_id,importo) VALUES ($1,$2,$3)`, [inc.id, doc.id, Math.min(imp, doc.residuo)]); abbinati++; }
      else daAbbinare++;
      esito.push({ incasso_id: inc.id, riferimento: r.riferimento, importo: imp, documento_id: doc?.id ?? null });
    }
    return { totale: righe.length, abbinati, da_abbinare: daAbbinare, esito };
  }, utente);
}

/** Abbinamento manuale: ripartisce l'incasso sui documenti indicati (importi). */
export async function abbinaManuale(incassoId: number, alloc: { documento_id: number; importo: number }[], utente: string) {
  return tx(async c => {
    const { rows: [inc] } = await c.query(`SELECT * FROM incasso WHERE id=$1 FOR UPDATE`, [incassoId]);
    const { rows: [{ gia }] } = await c.query(`SELECT COALESCE(sum(importo),0) AS gia FROM incasso_alloc WHERE incasso_id=$1`, [incassoId]);
    const nuovo = alloc.reduce((s, a) => s + a.importo, 0);
    if (gia + nuovo > inc.importo + 0.005) throw Object.assign(new Error('Allocazione superiore all\'importo incassato'), { statusCode: 400 });
    for (const a of alloc) await c.query(`INSERT INTO incasso_alloc(incasso_id,documento_id,importo) VALUES ($1,$2,$3)`, [incassoId, a.documento_id, a.importo]);
    const tot = r2(gia + nuovo);
    await c.query(`UPDATE incasso SET stato=$2 WHERE id=$1`, [incassoId, tot + 0.005 >= inc.importo ? 'abbinato' : 'parziale']);
    return { allocato: tot };
  }, utente);
}

export async function estrattoConto(anagraficaId: number) {
  const { rows: docs } = await pool.query(
    `SELECT id, servizio, tipo, numero, anno, data_documento::text, scadenza::text, totale, residuo FROM v_documento_residuo WHERE anagrafica_id=$1 AND stato='emesso' ORDER BY data_documento, id`, [anagraficaId]);
  const { rows: inc } = await pool.query(
    `SELECT i.id, i.data_valuta::text, i.importo, i.canale, i.riferimento, i.stato FROM incasso i WHERE i.anagrafica_id=$1 OR i.id IN (SELECT a.incasso_id FROM incasso_alloc a JOIN documento d ON d.id=a.documento_id WHERE d.anagrafica_id=$1) ORDER BY data_valuta`, [anagraficaId]);
  return { documenti: docs, incassi: inc, saldo: r2(docs.filter(d => d.tipo !== 'nota_credito').reduce((s, d) => s + d.residuo, 0)) };
}
