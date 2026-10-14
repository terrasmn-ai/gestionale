import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { ruoli, utenteDi } from '../auth.js';
import { creaProva, confermaRun, annullaProva, fatturaPuntuale, notaCredito } from '../services/billing.js';
import { calcolaMoraBatch, generaSolleciti, importaIncassi, parsePoste, parseBanca, abbinaManuale, estrattoConto } from '../services/crediti.js';
import { acciseMensile, acciseAnnuale, dichiarazioneTlr } from '../exports/accise.js';
import { flussoSepa, fatturaPaXml, flussoStampa, sapEmesso, sapIncassi } from '../exports/flussi.js';
import { toCsv } from '../exports/util.js';
import { servizioAmmesso } from '../config.js';
import { r2 } from '../engine/types.js';
import { rilevaAnomalia } from '../engine/letture.js';
import { diffDays } from '../engine/common.js';

const Srv = z.enum(['TLR', 'GPL']);
const Data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const fat = ruoli('fatturazione'), amm = ruoli('amministrazione'), sport = ruoli('sportello'), tec = ruoli('tecnico', 'fatturazione');
const bad = (m: string, s = 400) => Object.assign(new Error(m), { statusCode: s });
const csvReply = (rep: any, nome: string, csv: string) => rep.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${nome}"`).send(csv);
const xmlReply = (rep: any, nome: string, x: string) => rep.header('Content-Type', 'application/xml').header('Content-Disposition', `attachment; filename="${nome}"`).send(x);
const srv = (s: string) => { const v = Srv.parse(s); if (!servizioAmmesso(v)) throw bad(`Servizio ${v} non attivo su questa istanza`, 403); return v; };

export function registraOperazioni(app: FastifyInstance) {
  // ===== Configurazione istanza =====
  app.get('/api/istanza', async () => ({ servizi: (['TLR', 'GPL'] as const).filter(servizioAmmesso) }));

  // ===== Contratti: applica evento alla fornitura =====
  app.post('/api/contratti/:id/applica', { preHandler: sport }, async req => tx(async c => {
    const { rows: [k] } = await c.query(`SELECT * FROM contratto WHERE id=$1 FOR UPDATE`, [(req.params as any).id]);
    if (!k) throw bad('Contratto non trovato', 404);
    if (k.stato === 'efficace') throw bad('Evento già applicato', 409);
    const f = k.fornitura_id, d = k.data_evento;
    switch (k.tipo) {
      case 'nuovo': await c.query(`UPDATE fornitura SET stato='attiva', anagrafica_id=$2, data_attivazione=$3, data_cessazione=NULL WHERE id=$1`, [f, k.anagrafica_id, d]); break;
      case 'voltura': case 'subentro': await c.query(`UPDATE fornitura SET anagrafica_id=$2 WHERE id=$1`, [f, k.anagrafica_id]); break;
      case 'cessazione': await c.query(`UPDATE fornitura SET stato='cessata', data_cessazione=$2 WHERE id=$1`, [f, d]); break;
      case 'sospensione': await c.query(`UPDATE fornitura SET stato='sospesa' WHERE id=$1`, [f]); break;
      case 'riattivazione': await c.query(`UPDATE fornitura SET stato='attiva', data_cessazione=NULL WHERE id=$1`, [f]); break;
    }
    // lettura all'evento (chiude il periodo del vecchio intestatario): su tutti i contatori fatturabili se uno solo
    if (k.lettura_evento != null) {
      const { rows: cont } = await c.query(`SELECT id FROM contatore WHERE fornitura_id=$1 AND attivo AND fatturabile`, [f]);
      if (cont.length === 1) await c.query(`INSERT INTO lettura(contatore_id,data_lettura,valore,tipo,origine,note) VALUES ($1,$2,$3,'intermedia','contratto',$4)`, [cont[0].id, d, k.lettura_evento, `Evento contrattuale ${k.tipo}`]);
    }
    await c.query(`UPDATE contratto SET stato='efficace' WHERE id=$1`, [k.id]);
    return { ok: true };
  }, utenteDi(req).username));

  // ===== Letture =====
  app.get('/api/letture/template', async (req, rep) => {
    const { servizio, ciclo_id } = req.query as any;
    const { rows } = await pool.query(
      `SELECT k.matricola, f.codice AS fornitura, a.denominazione, k.um_lettura AS um,
              (SELECT valore FROM lettura l WHERE l.contatore_id=k.id AND NOT l.annullata ORDER BY data_lettura DESC, id DESC LIMIT 1) AS ultima_lettura,
              (SELECT data_lettura::text FROM lettura l WHERE l.contatore_id=k.id AND NOT l.annullata ORDER BY data_lettura DESC, id DESC LIMIT 1) AS data_ultima,
              ''::text AS data_nuova, ''::text AS nuova_lettura
         FROM contatore k JOIN fornitura f ON f.id=k.fornitura_id JOIN anagrafica a ON a.id=f.anagrafica_id
        WHERE k.attivo AND f.stato='attiva' AND f.servizio=$1 AND ($2::int IS NULL OR f.ciclo_id=$2) ORDER BY f.codice, k.matricola`, [srv(servizio), ciclo_id || null]);
    return csvReply(rep, `letture_${servizio}.csv`, toCsv(rows));
  });
  /** Import massivo: CSV `matricola;data(YYYY-MM-DD|GG/MM/AAAA);valore[;tipo]`. Nessuna riga viene persa: gli scarti sono riportati. */
  app.post('/api/letture/import', { preHandler: tec }, async req => {
    const testo = String((req.body as any).testo ?? '');
    const { rows: [{ valore: sx }] } = await pool.query(`SELECT valore FROM impostazione WHERE chiave='soglia_anomalia_consumo_x'`);
    let ok = 0; const scarti: any[] = []; const anomalie: any[] = [];
    await tx(async c => {
      let n = 0;
      for (const riga of testo.split(/\r?\n/)) {
        n++; const t = riga.trim(); if (!t) continue;
        const [m, d, v, tipo] = t.split(';').map(x => x.trim());
        const data = /^\d{2}\/\d{2}\/\d{4}$/.test(d ?? '') ? d.split('/').reverse().join('-') : d;
        const val = parseFloat((v ?? '').replace(',', '.'));
        if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(data ?? '') || !isFinite(val)) { if (n > 1 || /\d/.test(v ?? '')) scarti.push({ riga: n, testo: t, motivo: 'formato non valido' }); continue; }
        const { rows: [k] } = await c.query(`SELECT * FROM contatore WHERE matricola=$1`, [m]);
        if (!k) { scarti.push({ riga: n, testo: t, motivo: 'matricola sconosciuta' }); continue; }
        const { rows: [p] } = await c.query(`SELECT valore, data_lettura::text AS data FROM lettura WHERE contatore_id=$1 AND NOT annullata AND data_lettura<=$2 ORDER BY data_lettura DESC, id DESC LIMIT 1`, [k.id, data]);
        const prev = p ?? { valore: k.lettura_iniziale, data: k.data_lettura_iniziale };
        let an: string | undefined;
        if (Number(val) < Number(prev.valore) && !k.cifre) an = 'consumo_negativo';
        else if (prev.data) an = rilevaAnomalia(val - Number(prev.valore), diffDays(prev.data, data), undefined, Number(sx));
        await c.query(`INSERT INTO lettura(contatore_id,data_lettura,valore,tipo,origine,anomalia) VALUES ($1,$2,$3,$4,'import',$5)`, [k.id, data, val, ['effettiva', 'intermedia', 'autolettura'].includes(tipo) ? tipo : 'effettiva', an ?? null]);
        ok++; if (an) anomalie.push({ riga: n, matricola: m, anomalia: an });
      }
    }, utenteDi(req).username);
    return { importate: ok, scartate: scarti.length, scarti, anomalie };
  });
  app.get('/api/letture/da-fatturare', async (req, rep) => {
    const q = req.query as any; const { rows } = await pool.query(
      `SELECT f.codice AS fornitura, a.denominazione, k.matricola, l.data_lettura::text AS data, l.valore, l.tipo, l.anomalia,
              l.valore - COALESCE(LAG(l.valore) OVER (PARTITION BY k.id ORDER BY l.data_lettura, l.id), k.lettura_iniziale) AS consumo_grezzo
         FROM lettura l JOIN contatore k ON k.id=l.contatore_id JOIN fornitura f ON f.id=k.fornitura_id JOIN anagrafica a ON a.id=f.anagrafica_id
        WHERE l.documento_id IS NULL AND l.run_id IS NULL AND NOT l.annullata AND f.servizio=$1 ORDER BY f.codice, l.data_lettura`, [srv(q.servizio)]);
    return q.formato === 'csv' ? csvReply(rep, 'letture_da_fatturare.csv', toCsv(rows)) : rows;
  });

  // ===== Fatturazione =====
  const RunBody = z.object({ servizio: Srv, ciclo_id: z.number().int().optional(), data_documento: Data, data_fino: Data, fornitura_ids: z.array(z.number().int()).optional(), stima_mancanti: z.boolean().optional() });
  app.post('/api/fatturazione/prova', { preHandler: fat }, async req => { const b = RunBody.parse(req.body); srv(b.servizio); return creaProva(b, utenteDi(req).username); });
  app.post('/api/fatturazione/:id/conferma', { preHandler: fat }, async req => confermaRun(Number((req.params as any).id), utenteDi(req).username));
  app.delete('/api/fatturazione/:id', { preHandler: fat }, async req => annullaProva(Number((req.params as any).id)));
  app.post('/api/fatturazione/puntuale', { preHandler: ruoli('fatturazione', 'sportello') }, async req => {
    const b = z.object({ fornitura_id: z.number().int(), servizio: Srv, data_documento: Data, stima: z.boolean().optional() }).parse(req.body);
    srv(b.servizio); return fatturaPuntuale(b.fornitura_id, b.servizio, b.data_documento, utenteDi(req).username, b.stima);
  });
  app.post('/api/documenti/:id/nota-credito', { preHandler: fat }, async req => notaCredito(Number((req.params as any).id), Data.parse((req.body as any).data), utenteDi(req).username));
  app.get('/api/fatturazione', async () => (await pool.query('SELECT * FROM fatturazione_run ORDER BY id DESC LIMIT 100')).rows);
  app.get('/api/fatturazione/:id', async req => {
    const id = (req.params as any).id;
    const { rows: [run] } = await pool.query('SELECT * FROM fatturazione_run WHERE id=$1', [id]);
    const { rows: docs } = await pool.query(`SELECT d.id,d.numero,d.anno,d.tipo,d.totale,d.scadenza::text,a.denominazione,f.codice AS fornitura FROM documento d JOIN anagrafica a ON a.id=d.anagrafica_id LEFT JOIN fornitura f ON f.id=d.fornitura_id WHERE d.run_id=$1 ORDER BY a.denominazione`, [id]);
    return { run, documenti: docs };
  });
  app.get('/api/fatturazione/:id/defalco', async (req, rep) => {
    const { rows } = await pool.query(
      `SELECT p.matricola AS padre, f.matricola AS figlio, fo.codice AS fornitura, d.consumo_padre, d.consumo_figli_tot, d.differenza, d.consumo_proprio, d.quota_ripartita, d.consumo_fatturato
         FROM defalco_ripartizione d JOIN contatore p ON p.id=d.contatore_padre_id JOIN contatore f ON f.id=d.contatore_figlio_id JOIN fornitura fo ON fo.id=f.fornitura_id WHERE d.run_id=$1 ORDER BY p.matricola, f.matricola`, [(req.params as any).id]);
    return (req.query as any).formato === 'csv' ? csvReply(rep, 'verifica_defalco.csv', toCsv(rows)) : rows;
  });
  app.get('/api/fatturazione/:id/stampa.csv', async (req, rep) => csvReply(rep, `flusso_stampa_${(req.params as any).id}.csv`, await flussoStampa(Number((req.params as any).id))));

  app.get('/api/documenti', async req => {
    const q = req.query as any; const w: string[] = [], a: unknown[] = [];
    for (const [k, col] of [['servizio', 'd.servizio::text'], ['stato', 'd.stato'], ['anagrafica_id', 'd.anagrafica_id::text'], ['fornitura_id', 'd.fornitura_id::text'], ['anno', 'd.anno::text']] as const) if (q[k]) { a.push(q[k]); w.push(`${col}=$${a.length}`); }
    if (q.q) { a.push(`%${q.q}%`); w.push(`(an.denominazione ILIKE $${a.length} OR d.numero::text ILIKE $${a.length})`); }
    return (await pool.query(`SELECT d.id,d.servizio,d.tipo,d.stato,d.numero,d.anno,d.data_documento::text,d.scadenza::text,d.totale,d.residuo,an.denominazione,f.codice AS fornitura
      FROM v_documento_residuo d JOIN anagrafica an ON an.id=d.anagrafica_id LEFT JOIN fornitura f ON f.id=d.fornitura_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY d.id DESC LIMIT 300`, a)).rows;
  });
  app.get('/api/documenti/:id', async (req, rep) => {
    const { rows: [d] } = await pool.query(`SELECT d.*, an.denominazione, an.codice_fiscale, an.partita_iva, an.ind_via, an.ind_civico, an.ind_cap, an.ind_comune, an.ind_prov, f.codice AS fornitura FROM v_documento_residuo d JOIN anagrafica an ON an.id=d.anagrafica_id LEFT JOIN fornitura f ON f.id=d.fornitura_id WHERE d.id=$1`, [(req.params as any).id]);
    if (!d) return rep.code(404).send({ errore: 'Non trovato' });
    const { rows: righe } = await pool.query('SELECT * FROM documento_riga WHERE documento_id=$1 ORDER BY ordine', [d.id]);
    return { ...d, righe };
  });
  app.get('/api/documenti/:id/stampa', async (req, rep) => {
    const { rows: [d] } = await pool.query(`SELECT d.*, an.denominazione, an.ind_via, an.ind_civico, an.ind_cap, an.ind_comune, f.codice AS fornitura FROM documento d JOIN anagrafica an ON an.id=d.anagrafica_id LEFT JOIN fornitura f ON f.id=d.fornitura_id WHERE d.id=$1`, [(req.params as any).id]);
    if (!d) return rep.code(404).send({ errore: 'Non trovato' });
    const { rows: righe } = await pool.query('SELECT * FROM documento_riga WHERE documento_id=$1 ORDER BY ordine', [d.id]);
    const e = (s: unknown) => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!));
    const eur = (n: number) => n.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    const ins = (d.insoluti_esposti ?? []) as any[];
    rep.type('text/html').send(`<!doctype html><meta charset=utf-8><title>Documento ${d.numero ?? 'PROVA'}</title><style>body{font:13px sans-serif;max-width:800px;margin:20px auto;${d.stato === 'prova' ? 'background:repeating-linear-gradient(45deg,#fff,#fff 40px,#fff6f6 40px,#fff6f6 80px)' : ''}}table{width:100%;border-collapse:collapse}td,th{padding:4px 6px;border-bottom:1px solid #ddd}td.n,th.n{text-align:right}.k{color:#a00;font-weight:bold}</style>
<h2>${d.tipo === 'nota_credito' ? 'Nota di credito' : 'Fattura'} ${d.numero ? d.numero + '/' + d.anno : '<span class=k>— PROVA —</span>'}</h2>
<p>Data ${e(d.data_documento instanceof Date ? d.data_documento.toISOString().slice(0, 10) : d.data_documento)} · Scadenza ${e(d.scadenza instanceof Date ? d.scadenza.toISOString().slice(0, 10) : d.scadenza)} · Fornitura ${e(d.fornitura)}</p>
<p><b>${e(d.denominazione)}</b><br>${e(d.ind_via)} ${e(d.ind_civico)}, ${e(d.ind_cap)} ${e(d.ind_comune)}</p>
<table><tr><th>Descrizione</th><th class=n>Quantità</th><th class=n>Prezzo</th><th class=n>Imponibile</th><th class=n>IVA %</th></tr>
${righe.map(r => `<tr><td>${e(r.descrizione)}</td><td class=n>${r.quantita ?? ''} ${e(r.um)}</td><td class=n>${r.prezzo ?? ''}</td><td class=n>${eur(r.imponibile)}</td><td class=n>${r.fuori_campo_iva ? 'F.C.' : r.iva_pct}</td></tr>`).join('')}</table>
<p>Imponibile € ${eur(d.imponibile)} · IVA € ${eur(d.iva)} · Fuori campo IVA € ${eur(d.fuori_campo_iva)}</p><h3>Totale € ${eur(d.totale)}</h3>
${ins.length ? `<p class=k>Fatture scadute non risultano pagate: ${ins.map(i => `${i.numero}/${i.anno} € ${eur(i.residuo)}`).join('; ')}</p>` : ''}${d.note ? `<p>${e(d.note)}</p>` : ''}`);
  });
  app.get('/api/documenti/:id/fatturapa.xml', async (req, rep) => xmlReply(rep, `fattura_${(req.params as any).id}.xml`, await fatturaPaXml(Number((req.params as any).id))));

  // ===== Preventivi =====
  app.post('/api/preventivi/:id/fattura', { preHandler: ruoli('fatturazione', 'sportello') }, async req => tx(async c => {
    const { rows: [p] } = await c.query(`SELECT * FROM preventivo WHERE id=$1 FOR UPDATE`, [(req.params as any).id]);
    if (!p || p.stato !== 'approvato') throw bad('Il preventivo deve essere approvato', 409);
    const { rows: pr } = await c.query(`SELECT * FROM preventivo_riga WHERE preventivo_id=$1 ORDER BY id`, [p.id]);
    const data = (req.body as any)?.data ?? new Date().toISOString().slice(0, 10); const anno = Number(data.slice(0, 4));
    const imp = r2(pr.reduce((s, r) => s + r.quantita * r.prezzo, 0)), iva = r2(pr.reduce((s, r) => s + r2(r.quantita * r.prezzo) * r.iva_pct / 100, 0));
    const { rows: [{ m }] } = await c.query(`SELECT COALESCE(max(numero),0) AS m FROM documento WHERE servizio=$1 AND sezionale='A' AND anno=$2`, [p.servizio, anno]);
    const { rows: [{ gg }] } = await c.query(`SELECT cc.giorni_scadenza AS gg FROM anagrafica a JOIN categoria_cliente cc ON cc.id=a.categoria_id WHERE a.id=$1`, [p.anagrafica_id]);
    const { rows: [d] } = await c.query(
      `INSERT INTO documento(servizio,tipo,stato,anno,numero,data_documento,anagrafica_id,fornitura_id,scadenza,imponibile,iva,totale,preventivo_id) VALUES ($1,'fattura_preventivo','emesso',$2,$3,$4,$5,$6,$4::date+$7::int,$8,$9,$10,$11) RETURNING id`,
      [p.servizio, anno, m + 1, data, p.anagrafica_id, p.fornitura_id, gg, imp, iva, r2(imp + iva), p.id]);
    let o = 0; for (const r of pr) await c.query(`INSERT INTO documento_riga(documento_id,ordine,tipo_riga,descrizione,quantita,prezzo,imponibile,iva_pct,iva) VALUES ($1,$2,'preventivo',$3,$4,$5,$6,$7,$8)`,
      [d.id, o++, r.descrizione, r.quantita, r.prezzo, r2(r.quantita * r.prezzo), r.iva_pct, r2(r2(r.quantita * r.prezzo) * r.iva_pct / 100)]);
    await c.query(`UPDATE preventivo SET stato='fatturato', documento_id=$2 WHERE id=$1`, [p.id, d.id]);
    return { documento_id: d.id, numero: m + 1, anno };
  }, utenteDi(req).username));
  app.get('/api/preventivi', async req => (await pool.query(`SELECT p.*, a.denominazione, (SELECT COALESCE(sum(quantita*prezzo),0) FROM preventivo_riga r WHERE r.preventivo_id=p.id) AS imponibile FROM preventivo p JOIN anagrafica a ON a.id=p.anagrafica_id ORDER BY p.id DESC LIMIT 200`)).rows);
  app.post('/api/preventivi', { preHandler: ruoli('sportello', 'fatturazione') }, async req => tx(async c => {
    const b = req.body as any; const anno = new Date().getFullYear();
    const { rows: [{ n }] } = await c.query(`SELECT count(*)+1 AS n FROM preventivo WHERE anno=$1 AND servizio=$2`, [anno, b.servizio]);
    const { rows: [p] } = await c.query(`INSERT INTO preventivo(numero,anno,servizio,anagrafica_id,fornitura_id,note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [`P${n}`, anno, b.servizio, b.anagrafica_id, b.fornitura_id ?? null, b.note ?? null]);
    for (const r of b.righe ?? []) {
      const l = r.listino_id ? (await c.query('SELECT * FROM listino WHERE id=$1', [r.listino_id])).rows[0] : null;
      await c.query(`INSERT INTO preventivo_riga(preventivo_id,listino_id,descrizione,quantita,prezzo,iva_pct) VALUES ($1,$2,$3,$4,$5,$6)`,
        [p.id, l?.id ?? null, r.descrizione ?? l.descrizione, r.quantita ?? 1, r.prezzo ?? l.prezzo, r.iva_pct ?? l?.iva_pct ?? 22]);
    }
    return p;
  }, utenteDi(req).username));
  app.get('/api/preventivi/:id/righe', async req => (await pool.query('SELECT * FROM preventivo_riga WHERE preventivo_id=$1 ORDER BY id', [(req.params as any).id])).rows);
  app.put('/api/preventivi/:id/stato', { preHandler: ruoli('sportello', 'fatturazione') }, async req => {
    const stato = z.enum(['emesso', 'approvato', 'rifiutato']).parse((req.body as any).stato);
    await pool.query('UPDATE preventivo SET stato=$2 WHERE id=$1', [(req.params as any).id, stato]); return { ok: true };
  });

  // ===== Partite massive (es. assicurazione) =====
  app.post('/api/partite/import', { preHandler: ruoli('fatturazione', 'sportello') }, async req => {
    // CSV: codice_fornitura;tipo(addebito|accredito);descrizione;imponibile;iva_pct;fc(0|1)
    const { testo, lotto } = req.body as any; let ok = 0; const scarti: any[] = [];
    await tx(async c => {
      let n = 0; for (const l of String(testo).split(/\r?\n/)) {
        n++; const t = l.trim(); if (!t) continue; const [cod, tipo, desc, imp, iva, fc] = t.split(';').map(x => x.trim());
        const i = parseFloat((imp ?? '').replace(',', '.'));
        const { rows: [f] } = await c.query('SELECT id, anagrafica_id FROM fornitura WHERE codice=$1', [cod]);
        if (!f || !['addebito', 'accredito'].includes(tipo) || !isFinite(i)) { if (n > 1) scarti.push({ riga: n, testo: t }); continue; }
        await c.query(`INSERT INTO partita(anagrafica_id,fornitura_id,tipo,descrizione,imponibile,iva_pct,fuori_campo_iva,lotto) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [f.anagrafica_id, f.id, tipo, desc, Math.abs(i), parseFloat(iva) || 0, fc === '1', lotto ?? null]); ok++;
      }
    }, utenteDi(req).username);
    return { inserite: ok, scartate: scarti.length, scarti };
  });

  // ===== Bonus sociale: acquisizione flusso =====
  app.post('/api/bonus-sociale/flusso', { preHandler: ruoli('fatturazione', 'sportello') }, async req => {
    // CSV: codice_fiscale;codice_fornitura;valido_dal;valido_al;importo;protocollo
    const { nome_file, testo } = req.body as any; const scarti: any[] = []; let ok = 0, tot = 0;
    await tx(async c => {
      const { rows: [fl] } = await c.query(`INSERT INTO bonus_flusso(nome_file) VALUES ($1) RETURNING id`, [nome_file ?? null]);
      let n = 0; for (const l of String(testo).split(/\r?\n/)) {
        n++; const t = l.trim(); if (!t || /^codice/i.test(t)) continue; tot++;
        const [cf, cod, dal, al, imp, prot] = t.split(';').map(x => x.trim()); const i = parseFloat((imp ?? '').replace(',', '.'));
        const { rows: [f] } = await c.query(`SELECT f.id, a.codice_fiscale, f.servizio FROM fornitura f JOIN anagrafica a ON a.id=f.anagrafica_id WHERE f.codice=$1`, [cod]);
        const motivo = !f ? 'fornitura inesistente' : f.servizio !== 'TLR' ? 'fornitura non TLR' : (f.codice_fiscale ?? '').toUpperCase() !== (cf ?? '').toUpperCase() ? 'codice fiscale non corrisponde all\'intestatario'
          : !/^\d{4}-\d{2}-\d{2}$/.test(dal ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(al ?? '') || al < dal ? 'date non valide' : !isFinite(i) || i <= 0 ? 'importo non valido' : null;
        if (motivo) { scarti.push({ riga: n, testo: t, motivo }); continue; }
        await c.query(`INSERT INTO bonus_sociale(fornitura_id,flusso_id,codice_fiscale,valido_dal,valido_al,importo_totale,protocollo) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [f.id, fl.id, cf, dal, al, i, prot ?? null]); ok++;
      }
      await c.query(`UPDATE bonus_flusso SET righe_totali=$2, righe_ok=$3, righe_scartate=$4, scarti=$5 WHERE id=$1`, [fl.id, tot, ok, scarti.length, JSON.stringify(scarti)]);
    }, utenteDi(req).username);
    return { righe: tot, acquisite: ok, scartate: scarti.length, scarti };
  });
  app.get('/api/bonus-sociale/rendicontazione', async (req, rep) => {
    const q = req.query as any; const { rows } = await pool.query(
      `SELECT f.codice AS fornitura, a.denominazione, b.protocollo, b.valido_dal::text, b.valido_al::text, b.importo_totale AS riconosciuto,
              COALESCE((SELECT -sum(r.imponibile) FROM documento_riga r JOIN documento d ON d.id=r.documento_id WHERE d.fornitura_id=f.id AND d.stato='emesso' AND r.tipo_riga='bonus_sociale' AND r.competenza_da>=b.valido_dal AND r.competenza_a<=b.valido_al),0) AS applicato_in_fattura
         FROM bonus_sociale b JOIN fornitura f ON f.id=b.fornitura_id JOIN anagrafica a ON a.id=f.anagrafica_id WHERE b.stato='valido' AND ($1::int IS NULL OR extract(year from b.valido_dal)=$1) ORDER BY f.codice`, [q.anno || null]);
    return q.formato === 'csv' ? csvReply(rep, 'bonus_sociale.csv', toCsv(rows)) : rows;
  });

  // ===== Crediti =====
  app.post('/api/crediti/mora', { preHandler: amm }, async req => { const b = req.body as any; return calcolaMoraBatch(srv(b.servizio), Data.parse(b.alla_data), !!b.scrivi, utenteDi(req).username); });
  app.post('/api/crediti/solleciti', { preHandler: amm }, async req => { const b = req.body as any; return generaSolleciti(srv(b.servizio), Data.parse(b.alla_data), !!b.scrivi); });
  app.get('/api/crediti/estratto-conto/:anagrafica', async req => estrattoConto(Number((req.params as any).anagrafica)));
  app.get('/api/crediti/insoluti', async req => (await pool.query(
    `SELECT d.id, d.servizio, d.numero, d.anno, d.scadenza::text, d.residuo, a.denominazione, (CURRENT_DATE - d.scadenza) AS giorni_ritardo
       FROM v_documento_residuo d JOIN anagrafica a ON a.id=d.anagrafica_id WHERE d.stato='emesso' AND d.tipo<>'nota_credito' AND d.residuo>0.005 AND d.scadenza<CURRENT_DATE ORDER BY d.scadenza LIMIT 1000`)).rows);
  app.post('/api/incassi/import', { preHandler: amm }, async req => {
    const b = req.body as any; const righe = b.formato === 'poste' ? parsePoste(String(b.testo), b.data ?? new Date().toISOString().slice(0, 10)) : parseBanca(String(b.testo), b.canale);
    return importaIncassi(righe, b.mazzetta_id ?? null, utenteDi(req).username, b.servizio ? srv(b.servizio) : undefined);
  });
  app.post('/api/incassi/:id/abbina', { preHandler: amm }, async req => abbinaManuale(Number((req.params as any).id), (req.body as any).allocazioni, utenteDi(req).username));
  app.get('/api/mazzette/:id/riepilogo', async req => (await pool.query(
    `SELECT m.*, COALESCE(sum(i.importo),0) AS totale_incassi, count(i.id) AS n_incassi, m.totale_dichiarato - COALESCE(sum(i.importo),0) AS differenza
       FROM mazzetta m LEFT JOIN incasso i ON i.mazzetta_id=m.id WHERE m.id=$1 GROUP BY m.id`, [(req.params as any).id])).rows[0]);
  app.post('/api/mazzette/:id/contabilizza', { preHandler: amm }, async req => { await pool.query(`UPDATE mazzetta SET stato='contabilizzata' WHERE id=$1`, [(req.params as any).id]); return { ok: true }; });

  // ===== Flussi & dichiarazioni =====
  app.get('/api/export/sepa.xml', { preHandler: amm }, async (req, rep) => { const q = req.query as any; return xmlReply(rep, 'sepa_sdd.xml', await flussoSepa(srv(q.servizio), Data.parse(q.da), Data.parse(q.a))); });
  app.get('/api/dichiarazioni/accise-mensile', async (req, rep) => { const q = req.query as any; const r = await acciseMensile(Number(q.anno), Number(q.mese)); return q.formato === 'csv' ? csvReply(rep, `accise_${q.anno}_${q.mese}.csv`, toCsv(r.righe)) : r; });
  app.get('/api/dichiarazioni/accise-annuale', async (req, rep) => { const q = req.query as any; const r = await acciseAnnuale(Number(q.anno)); return q.formato === 'csv' ? csvReply(rep, `accise_annuale_${q.anno}.csv`, toCsv(r.righe)) : r; });
  app.get('/api/dichiarazioni/tlr-annuale', async (req, rep) => { const q = req.query as any; const r = await dichiarazioneTlr(Number(q.anno)); return q.formato === 'csv' ? csvReply(rep, `dichiarazione_tlr_${q.anno}.csv`, toCsv(r.righe)) : r; });
  app.post('/api/sap/emesso', { preHandler: amm }, async (req, rep) => { const b = req.body as any; const r = await sapEmesso(srv(b.servizio), Data.parse(b.da), Data.parse(b.a), !!b.definitivo, utenteDi(req).username); return csvReply(rep, `sap_emesso_${b.da}_${b.a}.csv`, r.csv); });
  app.post('/api/sap/incassi', { preHandler: amm }, async (req, rep) => { const b = req.body as any; const r = await sapIncassi(Data.parse(b.da), Data.parse(b.a), !!b.definitivo, utenteDi(req).username); return csvReply(rep, `sap_incassi_${b.da}_${b.a}.csv`, r.csv); });

  // ===== Report =====
  const report: Record<string, string> = {
    elenco_fatture: `SELECT d.servizio, d.numero, d.anno, d.tipo, d.data_documento::text AS data, an.denominazione, f.codice AS fornitura, d.imponibile, d.iva, d.fuori_campo_iva, d.totale, d.residuo
      FROM v_documento_residuo d JOIN anagrafica an ON an.id=d.anagrafica_id LEFT JOIN fornitura f ON f.id=d.fornitura_id WHERE d.stato='emesso' AND d.servizio=$1 AND d.data_documento BETWEEN $2 AND $3 ORDER BY d.anno, d.numero`,
    prospetto_rendite: `SELECT to_char(d.data_documento,'YYYY-MM') AS mese, r.tipo_riga, sum(r.imponibile) AS imponibile, sum(r.iva) AS iva, count(DISTINCT d.id) AS documenti
      FROM documento_riga r JOIN documento d ON d.id=r.documento_id WHERE d.stato='emesso' AND d.servizio=$1 AND d.data_documento BETWEEN $2 AND $3 GROUP BY 1,2 ORDER BY 1,2`,
    consumi_competenza: `SELECT to_char(r.competenza_a,'YYYY-MM') AS competenza, r.um, sum(r.quantita) AS quantita, sum(r.imponibile) AS imponibile
      FROM documento_riga r JOIN documento d ON d.id=r.documento_id WHERE d.stato='emesso' AND d.servizio=$1 AND r.tipo_riga='consumo' AND d.data_documento BETWEEN $2 AND $3 GROUP BY 1,2 ORDER BY 1`,
    qf_competenza: `SELECT to_char(r.competenza_a,'YYYY-MM') AS competenza, sum(r.quantita) AS mesi, sum(r.imponibile) AS imponibile
      FROM documento_riga r JOIN documento d ON d.id=r.documento_id WHERE d.stato='emesso' AND d.servizio=$1 AND r.tipo_riga='quota_fissa' AND d.data_documento BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 1`,
    verifica_iva: `SELECT CASE WHEN r.fuori_campo_iva THEN 'F.C.' ELSE r.iva_pct::text END AS aliquota, f.uso, sum(r.imponibile) AS imponibile, sum(r.iva) AS iva, count(*) AS righe
      FROM documento_riga r JOIN documento d ON d.id=r.documento_id LEFT JOIN fornitura f ON f.id=d.fornitura_id WHERE d.stato='emesso' AND d.servizio=$1 AND d.data_documento BETWEEN $2 AND $3 GROUP BY 1,2 ORDER BY 1,2`,
    giornale_iva: `SELECT d.data_documento::text AS data, d.anno, d.numero, d.tipo, an.denominazione, an.partita_iva, d.imponibile, d.iva, d.fuori_campo_iva, d.totale
      FROM documento d JOIN anagrafica an ON an.id=d.anagrafica_id WHERE d.stato='emesso' AND d.servizio=$1 AND d.data_documento BETWEEN $2 AND $3 ORDER BY d.data_documento, d.anno, d.numero`,
    quadratura_incassi: `SELECT i.data_valuta::text AS data, i.canale, count(*) AS n, sum(i.importo) AS totale, sum(i.importo) FILTER (WHERE i.stato='da_abbinare') AS da_abbinare
      FROM incasso i WHERE i.data_valuta BETWEEN $2 AND $3 AND $1 = $1 GROUP BY 1,2 ORDER BY 1,2`,
  };
  app.get('/api/report/:nome', async (req, rep) => {
    const sql = report[(req.params as any).nome]; if (!sql) return rep.code(404).send({ errore: 'Report sconosciuto', disponibili: Object.keys(report) });
    const q = req.query as any; const rows = (await pool.query(sql, [srv(q.servizio ?? 'TLR'), q.da ?? '1900-01-01', q.a ?? '2999-12-31'])).rows;
    return q.formato === 'csv' ? csvReply(rep, `${(req.params as any).nome}.csv`, toCsv(rows)) : rows;
  });
}
