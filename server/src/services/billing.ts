import { PoolClient } from 'pg';
import { pool, tx } from '../db.js';
import { RegoleSchema, Riga, r2, r3 } from '../engine/types.js';
import { addDays, diffDays, totali } from '../engine/common.js';
import { calcolaTlr, calcolaDefalco } from '../engine/tlr.js';
import { calcolaGpl } from '../engine/gpl.js';
import { consumo as calcConsumo, rilevaAnomalia, stimaConsumo } from '../engine/letture.js';
import { getImpostazione, loadParametri } from './impostazioni.js';

export interface RunInput { servizio: 'TLR' | 'GPL'; ciclo_id?: number; data_documento: string; data_fino: string; fornitura_ids?: number[]; stima_mancanti?: boolean }
export interface Anomalia { fornitura_id?: number; contatore_id?: number; codice: string; messaggio: string }

interface ConsumoContatore {
  contatore_id: number; fornitura_id: number; da: string; a: string; consumo: number; letture_ids: number[];
  stimata?: { data: string; valore: number }; anomalia?: string; fatturabile: boolean; padre_id: number | null;
}

/** Consumo non ancora fatturato per ciascun contatore, dalla baseline (ultima lettura fatturata o iniziale) all'ultima lettura utile. */
async function consumiContatori(c: PoolClient, fornitura_ids: number[], dataFino: string, stima: boolean, sogliaX: number) {
  const out: ConsumoContatore[] = []; const anomalie: Anomalia[] = [];
  const { rows: cont } = await c.query(`SELECT * FROM contatore WHERE fornitura_id = ANY($1) AND attivo`, [fornitura_ids]);
  for (const k of cont) {
    const { rows: base } = await c.query(
      `SELECT data_lettura::text AS data, valore FROM lettura WHERE contatore_id=$1 AND documento_id IS NOT NULL AND NOT annullata ORDER BY data_lettura DESC, id DESC LIMIT 1`, [k.id]);
    const b = base[0] ?? { data: k.data_lettura_iniziale, valore: k.lettura_iniziale };
    const { rows: ls } = await c.query(
      `SELECT id, data_lettura::text AS data, valore FROM lettura WHERE contatore_id=$1 AND documento_id IS NULL AND NOT annullata AND data_lettura<=$2 AND data_lettura >= $3 ORDER BY data_lettura, id`,
      [k.id, dataFino, b.data ?? '1900-01-01']);
    if (!ls.length) {
      if (stima && b.data) {
        const media = await mediaGiornaliera(c, k.id);
        if (media > 0) {
          const cons = stimaConsumo(media, b.data, dataFino);
          out.push({ contatore_id: k.id, fornitura_id: k.fornitura_id, da: b.data, a: dataFino, consumo: cons, letture_ids: [], stimata: { data: dataFino, valore: r3(b.valore + cons) }, fatturabile: k.fatturabile, padre_id: k.padre_id });
          anomalie.push({ contatore_id: k.id, fornitura_id: k.fornitura_id, codice: 'lettura_stimata', messaggio: `Lettura mancante stimata (${cons})` });
          continue;
        }
      }
      if (k.fatturabile || k.padre_id === null) anomalie.push({ contatore_id: k.id, fornitura_id: k.fornitura_id, codice: 'lettura_mancante', messaggio: `Nessuna lettura per matricola ${k.matricola}` });
      continue;
    }
    let prec = Number(b.valore), tot = 0;
    for (const l of ls) { const r = calcConsumo(prec, Number(l.valore), k.cifre); tot += r.consumo; prec = Number(l.valore); }
    tot = r3(tot);
    const da = b.data ?? ls[0].data, a = ls[ls.length - 1].data;
    const media = await mediaGiornaliera(c, k.id);
    const an = rilevaAnomalia(tot, diffDays(da, a), media, sogliaX);
    if (an) anomalie.push({ contatore_id: k.id, fornitura_id: k.fornitura_id, codice: an, messaggio: `${an}: consumo ${tot} (matricola ${k.matricola})` });
    out.push({ contatore_id: k.id, fornitura_id: k.fornitura_id, da, a, consumo: tot, letture_ids: ls.map((l: any) => l.id), anomalia: an, fatturabile: k.fatturabile, padre_id: k.padre_id });
  }
  return { consumi: out, anomalie };
}

/** Media giornaliera dai periodi già fatturati (ultime 2 letture fatturate). */
async function mediaGiornaliera(c: PoolClient, contatore_id: number): Promise<number> {
  const { rows } = await c.query(
    `SELECT data_lettura::text AS data, valore FROM lettura WHERE contatore_id=$1 AND documento_id IS NOT NULL AND NOT annullata ORDER BY data_lettura DESC, id DESC LIMIT 6`, [contatore_id]);
  if (rows.length < 2) return 0;
  const gg = diffDays(rows[rows.length - 1].data, rows[0].data);
  return gg > 0 ? (Number(rows[0].valore) - Number(rows[rows.length - 1].valore)) / gg : 0;
}

export async function creaProva(input: RunInput, utente: string) {
  return tx(async c => {
    const param = await loadParametri(c);
    const sogliaX = Number(await getImpostazione('soglia_anomalia_consumo_x', c) ?? 3);
    const { rows: [run] } = await c.query(
      `INSERT INTO fatturazione_run(servizio,ciclo_id,data_documento,data_fino) VALUES ($1,$2,$3,$4) RETURNING *`,
      [input.servizio, input.ciclo_id ?? null, input.data_documento, input.data_fino]);

    const args: unknown[] = [input.servizio]; let w = `f.servizio=$1 AND f.stato IN ('attiva','cessata','sospesa')`;
    if (input.ciclo_id) { args.push(input.ciclo_id); w += ` AND f.ciclo_id=$${args.length}`; }
    if (input.fornitura_ids?.length) { args.push(input.fornitura_ids); w += ` AND f.id = ANY($${args.length})`; }
    const { rows: forn } = await c.query(
      `SELECT f.*, cc.giorni_scadenza AS gg_cat, co.zona_montana, co.id AS comune_id_, cl.mesi_periodo
         FROM fornitura f JOIN anagrafica a ON a.id=f.anagrafica_id JOIN categoria_cliente cc ON cc.id=a.categoria_id
         LEFT JOIN comune co ON co.id=f.comune_id JOIN ciclo_fatturazione cl ON cl.id=f.ciclo_id WHERE ${w} ORDER BY f.anagrafica_id, f.id`, args);

    const { consumi, anomalie } = await consumiContatori(c, forn.map(f => f.id), input.data_fino, !!input.stima_mancanti, sogliaX);

    // ----- Defalco TLR: padre -> figli -----
    const defalcoRows: any[] = []; const consumoFatt = new Map<number, number>(); // contatore_id -> consumo fatturato
    const byCont = new Map(consumi.map(x => [x.contatore_id, x]));
    if (input.servizio === 'TLR') {
      const { rows: padri } = await c.query(`SELECT DISTINCT p.id FROM contatore p JOIN contatore f ON f.padre_id=p.id WHERE f.attivo`);
      for (const p of padri) {
        const pc = byCont.get(p.id);
        const { rows: figli } = await c.query(`SELECT id FROM contatore WHERE padre_id=$1 AND attivo`, [p.id]);
        if (!pc) { anomalie.push({ contatore_id: p.id, codice: 'defalco_padre_senza_lettura', messaggio: `Contatore padre ${p.id} senza lettura: figli fatturati sul solo consumo proprio` }); continue; }
        const fig = figli.map(f => ({ contatore_id: f.id, consumo: byCont.get(f.id)?.consumo ?? 0 }));
        const d = calcolaDefalco(pc.consumo, fig);
        if (d.anomalia) anomalie.push({ contatore_id: p.id, codice: 'defalco_anomalia', messaggio: d.anomalia });
        for (const f of d.figli) {
          consumoFatt.set(f.contatore_id, f.consumo_fatturato);
          defalcoRows.push([run.id, p.id, f.contatore_id, pc.consumo, fig.reduce((s, x) => s + x.consumo, 0), d.differenza, f.consumo_proprio, f.quota_ripartita, f.consumo_fatturato]);
        }
      }
    }

    // ----- Documenti per fornitura -----
    let nDoc = 0, totRun = 0;
    const anagraficheConDoc = new Map<number, number>(); // anagrafica -> documento_id (per partite senza fornitura)
    for (const f of forn) {
      const mine = consumi.filter(x => x.fornitura_id === f.id && x.fatturabile);
      const partiteSenza = []; // partite di fornitura
      const { rows: partite } = await c.query(
        `SELECT * FROM partita WHERE documento_id IS NULL AND (fornitura_id=$1 OR (fornitura_id IS NULL AND anagrafica_id=$2 AND NOT EXISTS (SELECT 1 FROM documento d WHERE d.run_id=$3 AND d.anagrafica_id=$2)))`,
        [f.id, f.anagrafica_id, run.id]);
      if (!mine.length && !partite.length) continue;
      const cons = mine.reduce((s, x) => s + (consumoFatt.get(x.contatore_id) ?? x.consumo), 0);
      const periodo_da = mine.length ? mine.map(x => x.da).sort()[0] : input.data_fino;
      const periodo_a = mine.length ? mine.map(x => x.a).sort().reverse()[0] : input.data_fino;

      let righe: Riga[] = [];
      if (mine.length) {
        const { rows: [ver] } = await c.query(
          `SELECT v.regole FROM tariffa_versione v WHERE v.tariffa_id=$1 AND v.valido_dal<=$2 ORDER BY v.valido_dal DESC LIMIT 1`, [f.tariffa_id, periodo_a]);
        if (!ver) { anomalie.push({ fornitura_id: f.id, codice: 'tariffa_mancante', messaggio: `Nessuna versione di tariffa valida al ${periodo_a}` }); continue; }
        const regole = RegoleSchema.parse(ver.regole);
        if (regole.servizio !== input.servizio) { anomalie.push({ fornitura_id: f.id, codice: 'tariffa_incoerente', messaggio: 'Tariffa di altro servizio' }); continue; }
        if (regole.servizio === 'TLR') {
          const { rows: [{ gia }] } = await c.query(
            `SELECT COALESCE(sum(r.quantita),0) AS gia FROM documento_riga r JOIN documento d ON d.id=r.documento_id
              WHERE d.fornitura_id=$1 AND d.stato='emesso' AND r.tipo_riga='consumo' AND extract(year from r.competenza_a)=extract(year from $2::date)`, [f.id, periodo_a]);
          const { rows: bonus } = await c.query(
            `SELECT importo_totale, valido_dal::text, valido_al::text FROM bonus_sociale WHERE fornitura_id=$1 AND stato='valido' AND valido_dal<=$3 AND valido_al>=$2`, [f.id, periodo_da, periodo_a]);
          righe = calcolaTlr({ regole, periodo_da, periodo_a, consumo_kwh: r3(cons), consumo_anno_precedente: gia, portata_kw: Number(f.portata_kw ?? 0), iva_pct: Number(f.iva_pct), param, bonus });
        } else {
          const { rows: [cc] } = await c.query(`SELECT valore FROM coefficiente_c WHERE comune_id=$1 AND valido_dal<=$2 ORDER BY valido_dal DESC LIMIT 1`, [f.comune_id, periodo_a]);
          if (!cc) { anomalie.push({ fornitura_id: f.id, codice: 'coeff_c_mancante', messaggio: 'Coefficiente C non definito per il comune' }); continue; }
          righe = calcolaGpl({ regole, periodo_da, periodo_a, consumo_mc: r3(cons), coeff_c: Number(cc.valore), zona_montana: !!f.zona_montana, iva_pct: Number(f.iva_pct), param });
        }
        // Acconto sul periodo successivo + scomputo di quelli già fatturati
        const { rows: [{ pregr }] } = await c.query(
          `SELECT COALESCE(sum(CASE WHEN r.tipo_riga='acconto' THEN r.imponibile WHEN r.tipo_riga='scomputo_acconto' THEN r.imponibile ELSE 0 END),0) AS pregr
             FROM documento_riga r JOIN documento d ON d.id=r.documento_id WHERE d.fornitura_id=$1 AND d.stato='emesso'`, [f.id]);
        if (pregr > 0) righe.push({ tipo_riga: 'scomputo_acconto', descrizione: 'Scomputo acconti precedenti', imponibile: -r2(pregr), iva_pct: Number(f.iva_pct) });
        if (regole.acconto_pct > 0) {
          const base = righe.filter(r => ['consumo', 'quota_fissa', 'accisa'].includes(r.tipo_riga)).reduce((s, r) => s + r.imponibile, 0);
          if (base > 0) righe.push({ tipo_riga: 'acconto', descrizione: `Acconto ${regole.acconto_pct}% periodo successivo`, imponibile: r2(base * regole.acconto_pct / 100), iva_pct: Number(f.iva_pct) });
        }
      }
      for (const p of partite) righe.push({
        tipo_riga: p.tipo === 'addebito' ? 'addebito' : 'accredito', descrizione: p.descrizione,
        imponibile: p.tipo === 'addebito' ? Number(p.imponibile) : -Number(p.imponibile), iva_pct: Number(p.iva_pct), fuori_campo_iva: p.fuori_campo_iva });

      const t = totali(righe);
      const tipo = t.totale < 0 ? 'nota_credito' : 'fattura';
      const gg = f.giorni_scadenza ?? f.gg_cat;
      const { rows: ins } = await c.query(
        `SELECT d.id, d.numero, d.anno, d.data_documento::text, d.scadenza::text, d.residuo FROM v_documento_residuo d
          WHERE d.anagrafica_id=$1 AND d.stato='emesso' AND d.tipo<>'nota_credito' AND d.residuo>0.005 AND d.scadenza<$2 AND d.servizio=$3`, [f.anagrafica_id, input.data_documento, input.servizio]);
      const { rows: [doc] } = await c.query(
        `INSERT INTO documento(run_id,servizio,tipo,stato,data_documento,anagrafica_id,fornitura_id,periodo_da,periodo_a,scadenza,imponibile,iva,totale,fuori_campo_iva,note,insoluti_esposti,letture_ids,partite_ids,dettaglio)
         VALUES ($1,$2,$3,'prova',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
        [run.id, input.servizio, tipo, input.data_documento, f.anagrafica_id, f.id, periodo_da, periodo_a, addDays(input.data_documento, gg),
         t.imponibile, t.iva, t.totale, t.fuori_campo_iva, f.note_bolletta, ins.length ? JSON.stringify(ins) : null,
         mine.flatMap(x => x.letture_ids), partite.map(p => p.id),
         JSON.stringify({ stime: mine.filter(x => x.stimata).map(x => ({ contatore_id: x.contatore_id, ...x.stimata })), consumo: r3(cons) })]);
      let ord = 0;
      for (const r of t.righe) await c.query(
        `INSERT INTO documento_riga(documento_id,ordine,tipo_riga,descrizione,quantita,um,prezzo,imponibile,iva_pct,iva,fuori_campo_iva,competenza_da,competenza_a,dettaglio)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [doc.id, ord++, r.tipo_riga, r.descrizione, r.quantita ?? null, r.um ?? null, r.prezzo ?? null, r.imponibile, r.iva_pct, r.iva, r.fuori_campo_iva ?? false, r.competenza_da ?? null, r.competenza_a ?? null, r.dettaglio ? JSON.stringify(r.dettaglio) : null]);
      anagraficheConDoc.set(f.anagrafica_id, doc.id);
      nDoc++; totRun += t.totale;
    }
    for (const d of defalcoRows) await c.query(
      `INSERT INTO defalco_ripartizione(run_id,contatore_padre_id,contatore_figlio_id,consumo_padre,consumo_figli_tot,differenza,consumo_proprio,quota_ripartita,consumo_fatturato) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, d);
    await c.query(`UPDATE fatturazione_run SET n_documenti=$2, totale=$3, anomalie=$4 WHERE id=$1`, [run.id, nDoc, r2(totRun), JSON.stringify(anomalie)]);
    return { run_id: run.id, n_documenti: nDoc, totale: r2(totRun), anomalie };
  }, utente);
}

/** Passaggio da prova a effettivo: numerazione progressiva, aggancio letture/partite, stime registrate. */
export async function confermaRun(runId: number, utente: string) {
  return tx(async c => {
    const { rows: [run] } = await c.query(`SELECT * FROM fatturazione_run WHERE id=$1 FOR UPDATE`, [runId]);
    if (!run) throw Object.assign(new Error('Run inesistente'), { statusCode: 404 });
    if (run.stato !== 'prova') throw Object.assign(new Error('Il run non è in prova'), { statusCode: 409 });
    const anno = Number(String(run.data_documento).slice(0, 4));
    const { rows: docs } = await c.query(`SELECT * FROM documento WHERE run_id=$1 ORDER BY (tipo='nota_credito'), anagrafica_id, id`, [runId]);
    const next = new Map<string, number>();
    for (const d of docs) {
      const key = `${d.servizio}|${d.sezionale}`;
      if (!next.has(key)) {
        const { rows: [{ m }] } = await c.query(`SELECT COALESCE(max(numero),0) AS m FROM documento WHERE servizio=$1 AND sezionale=$2 AND anno=$3`, [d.servizio, d.sezionale, anno]);
        next.set(key, m);
      }
      const n = next.get(key)! + 1; next.set(key, n);
      await c.query(`UPDATE documento SET stato='emesso', anno=$2, numero=$3 WHERE id=$1`, [d.id, anno, n]);
      if (d.letture_ids?.length) await c.query(`UPDATE lettura SET documento_id=$1 WHERE id = ANY($2)`, [d.id, d.letture_ids]);
      if (d.partite_ids?.length) await c.query(`UPDATE partita SET documento_id=$1 WHERE id = ANY($2)`, [d.id, d.partite_ids]);
      for (const s of d.dettaglio?.stime ?? []) await c.query(
        `INSERT INTO lettura(contatore_id,data_lettura,valore,tipo,origine,documento_id,anomalia) VALUES ($1,$2,$3,'stimata','stima',$4,'lettura_stimata')`, [s.contatore_id, s.data, s.valore, d.id]);
    }
    await c.query(`UPDATE fatturazione_run SET stato='effettivo', confermato_il=now() WHERE id=$1`, [runId]);
    return { run_id: runId, documenti_emessi: docs.length };
  }, utente);
}

export async function annullaProva(runId: number) {
  return tx(async c => {
    const { rows: [run] } = await c.query(`SELECT stato FROM fatturazione_run WHERE id=$1 FOR UPDATE`, [runId]);
    if (run?.stato !== 'prova') throw Object.assign(new Error('Solo un run in prova può essere eliminato'), { statusCode: 409 });
    await c.query(`DELETE FROM documento WHERE run_id=$1`, [runId]);
    await c.query(`DELETE FROM fatturazione_run WHERE id=$1`, [runId]);
    return { ok: true };
  });
}

/** Fatturazione puntuale da sportello (stessa pipeline, una sola fornitura). */
export const fatturaPuntuale = (fornitura_id: number, servizio: 'TLR' | 'GPL', data_documento: string, utente: string, stima = false) =>
  creaProva({ servizio, data_documento, data_fino: data_documento, fornitura_ids: [fornitura_id], stima_mancanti: stima }, utente)
    .then(async r => ({ ...r, ...(r.n_documenti ? await confermaRun(r.run_id, utente) : await annullaProva(r.run_id).then(() => ({}))) }));

/** Nota di credito a storno totale di un documento emesso. */
export async function notaCredito(documentoId: number, data: string, utente: string) {
  return tx(async c => {
    const { rows: [d] } = await c.query(`SELECT * FROM documento WHERE id=$1 AND stato='emesso' AND tipo IN ('fattura','fattura_acconto','fattura_preventivo') FOR UPDATE`, [documentoId]);
    if (!d) throw Object.assign(new Error('Documento non stornabile'), { statusCode: 404 });
    const anno = Number(data.slice(0, 4));
    const { rows: [{ m }] } = await c.query(`SELECT COALESCE(max(numero),0) AS m FROM documento WHERE servizio=$1 AND sezionale=$2 AND anno=$3`, [d.servizio, d.sezionale, anno]);
    const { rows: [nc] } = await c.query(
      `INSERT INTO documento(servizio,tipo,stato,anno,numero,sezionale,data_documento,anagrafica_id,fornitura_id,periodo_da,periodo_a,scadenza,imponibile,iva,totale,fuori_campo_iva,documento_origine_id,note)
       VALUES ($1,'nota_credito','emesso',$2,$3,$4,$5,$6,$7,$8,$9,$5,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [d.servizio, anno, m + 1, d.sezionale, data, d.anagrafica_id, d.fornitura_id, d.periodo_da, d.periodo_a, -d.imponibile, -d.iva, -d.totale, -d.fuori_campo_iva, d.id, `Storno documento ${d.numero}/${d.anno}`]);
    await c.query(
      `INSERT INTO documento_riga(documento_id,ordine,tipo_riga,descrizione,quantita,um,prezzo,imponibile,iva_pct,iva,fuori_campo_iva,competenza_da,competenza_a,dettaglio)
       SELECT $1,ordine,tipo_riga,'Storno: '||descrizione,quantita,um,prezzo,-imponibile,iva_pct,-iva,fuori_campo_iva,competenza_da,competenza_a,dettaglio FROM documento_riga WHERE documento_id=$2`, [nc.id, d.id]);
    // libera letture e partite per rifatturazione
    await c.query(`UPDATE lettura SET documento_id=NULL WHERE documento_id=$1 AND tipo<>'stimata'`, [d.id]);
    await c.query(`UPDATE partita SET documento_id=NULL WHERE documento_id=$1`, [d.id]);
    return { nota_credito_id: nc.id, numero: m + 1, anno };
  }, utente);
}
