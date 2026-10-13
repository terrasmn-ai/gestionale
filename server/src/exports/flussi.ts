import { pool, tx } from '../db.js';
import { getImpostazione } from '../services/impostazioni.js';
import { toCsv, xml } from './util.js';
import { r2 } from '../engine/types.js';

const err = (m: string, s = 400) => Object.assign(new Error(m), { statusCode: s });

// ---------- SEPA Direct Debit (pain.008.001.02) per documenti emessi con domiciliazione attiva ----------
export async function flussoSepa(servizio: string, scadenzaDa: string, scadenzaA: string) {
  const ced = await getImpostazione('cedente');
  if (!ced?.iban || !ced?.creditor_id_sepa) throw err('Configurare IBAN e Creditor ID SEPA nelle impostazioni (cedente)');
  const { rows } = await pool.query(
    `SELECT d.id, d.numero, d.anno, d.scadenza::text, d.residuo, a.denominazione, m.iban, m.mandato_sepa, m.data_mandato::text
       FROM v_documento_residuo d JOIN anagrafica a ON a.id=d.anagrafica_id
       JOIN LATERAL (SELECT * FROM domiciliazione z WHERE z.anagrafica_id=a.id AND z.attivo AND z.mandato_sepa IS NOT NULL ORDER BY valido_dal DESC LIMIT 1) m ON true
      WHERE d.servizio=$1 AND d.stato='emesso' AND d.tipo<>'nota_credito' AND d.residuo>0.005 AND d.scadenza BETWEEN $2 AND $3 ORDER BY d.scadenza, d.id`, [servizio, scadenzaDa, scadenzaA]);
  if (!rows.length) throw err('Nessun documento da incassare via SEPA nel periodo', 404);
  const tot = r2(rows.reduce((s, r) => s + r.residuo, 0)); const msgId = `SDD${Date.now()}`;
  const body = rows.map(r => `<DrctDbtTxInf><PmtId><EndToEndId>${xml(`${r.numero}-${r.anno}`)}</EndToEndId></PmtId><InstdAmt Ccy="EUR">${r.residuo.toFixed(2)}</InstdAmt>
<DrctDbtTx><MndtRltdInf><MndtId>${xml(r.mandato_sepa)}</MndtId><DtOfSgntr>${r.data_mandato ?? r.scadenza}</DtOfSgntr></MndtRltdInf></DrctDbtTx>
<DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt><Dbtr><Nm>${xml(r.denominazione.slice(0, 70))}</Nm></Dbtr><DbtrAcct><Id><IBAN>${xml(r.iban)}</IBAN></Id></DbtrAcct>
<RmtInf><Ustrd>Fattura ${r.numero}/${r.anno}</Ustrd></RmtInf></DrctDbtTxInf>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.02"><CstmrDrctDbtInitn>
<GrpHdr><MsgId>${msgId}</MsgId><CreDtTm>${new Date().toISOString().slice(0, 19)}</CreDtTm><NbOfTxs>${rows.length}</NbOfTxs><CtrlSum>${tot.toFixed(2)}</CtrlSum><InitgPty><Nm>${xml(ced.denominazione)}</Nm></InitgPty></GrpHdr>
<PmtInf><PmtInfId>${msgId}-1</PmtInfId><PmtMtd>DD</PmtMtd><NbOfTxs>${rows.length}</NbOfTxs><CtrlSum>${tot.toFixed(2)}</CtrlSum>
<PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl><LclInstrm><Cd>CORE</Cd></LclInstrm><SeqTp>RCUR</SeqTp></PmtTpInf><ReqdColltnDt>${rows[0].scadenza}</ReqdColltnDt>
<Cdtr><Nm>${xml(ced.denominazione)}</Nm></Cdtr><CdtrAcct><Id><IBAN>${xml(ced.iban)}</IBAN></Id></CdtrAcct><CdtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></CdtrAgt>
<CdtrSchmeId><Id><PrvtId><Othr><Id>${xml(ced.creditor_id_sepa)}</Id><SchmeNm><Prtry>SEPA</Prtry></SchmeNm></Othr></PrvtId></Id></CdtrSchmeId>
${body}
</PmtInf></CstmrDrctDbtInitn></Document>`;
}

// ---------- FatturaPA (FPR12 / TD01-TD04) ----------
export async function fatturaPaXml(documentoId: number) {
  const ced = await getImpostazione('cedente');
  if (!ced?.partita_iva) throw err('Configurare i dati del cedente nelle impostazioni');
  const { rows: [d] } = await pool.query(
    `SELECT d.*, a.denominazione, a.codice_fiscale, a.partita_iva, a.codice_destinatario, a.codice_ipa, a.pec, a.ind_via, a.ind_civico, a.ind_cap, a.ind_comune, a.ind_prov, c.pubblica_amministrazione,
            o.numero AS onum, o.anno AS oanno, o.data_documento::text AS odata
       FROM documento d JOIN anagrafica a ON a.id=d.anagrafica_id JOIN categoria_cliente c ON c.id=a.categoria_id
       LEFT JOIN documento o ON o.id=d.documento_origine_id WHERE d.id=$1 AND d.stato='emesso'`, [documentoId]);
  if (!d) throw err('Documento emesso non trovato', 404);
  const { rows: righe } = await pool.query(`SELECT * FROM documento_riga WHERE documento_id=$1 ORDER BY ordine`, [documentoId]);
  const nc = d.tipo === 'nota_credito', sgn = nc ? -1 : 1;
  const td = nc ? 'TD04' : d.tipo === 'fattura_acconto' ? 'TD02' : 'TD01';
  const fmt = (n: number, dec = 2) => (Math.abs(n) < 1e-9 ? 0 : n).toFixed(dec);
  // riepilogo IVA per aliquota / natura (fuori campo → N2.2)
  const riep = new Map<string, { aliq: number; nat?: string; imp: number; iva: number }>();
  for (const r of righe) {
    const k = r.fuori_campo_iva ? 'N2.2' : String(r.iva_pct); const x = riep.get(k) ?? { aliq: r.fuori_campo_iva ? 0 : Number(r.iva_pct), nat: r.fuori_campo_iva ? 'N2.2' : undefined, imp: 0, iva: 0 };
    x.imp += sgn * r.imponibile; x.iva += sgn * r.iva; riep.set(k, x);
  }
  const pa = d.pubblica_amministrazione, dest = pa ? (d.codice_ipa || '0000000') : (d.codice_destinatario || '0000000');
  const idf = d.partita_iva ? `<IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${xml(d.partita_iva)}</IdCodice></IdFiscaleIVA>` : '';
  const progressivo = `${d.anno}${String(d.numero).padStart(6, '0')}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="${pa ? 'FPA12' : 'FPR12'}" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2">
<FatturaElettronicaHeader>
<DatiTrasmissione><IdTrasmittente><IdPaese>IT</IdPaese><IdCodice>${xml(ced.codice_fiscale || ced.partita_iva)}</IdCodice></IdTrasmittente><ProgressivoInvio>${progressivo}</ProgressivoInvio><FormatoTrasmissione>${pa ? 'FPA12' : 'FPR12'}</FormatoTrasmissione><CodiceDestinatario>${xml(dest)}</CodiceDestinatario>${!pa && dest === '0000000' && d.pec ? `<PECDestinatario>${xml(d.pec)}</PECDestinatario>` : ''}</DatiTrasmissione>
<CedentePrestatore><DatiAnagrafici><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${xml(ced.partita_iva)}</IdCodice></IdFiscaleIVA><Anagrafica><Denominazione>${xml(ced.denominazione)}</Denominazione></Anagrafica><RegimeFiscale>${xml(ced.regime_fiscale || 'RF01')}</RegimeFiscale></DatiAnagrafici>
<Sede><Indirizzo>${xml(ced.indirizzo)}</Indirizzo><CAP>${xml(ced.cap)}</CAP><Comune>${xml(ced.comune)}</Comune><Provincia>${xml(ced.provincia)}</Provincia><Nazione>IT</Nazione></Sede></CedentePrestatore>
<CessionarioCommittente><DatiAnagrafici>${idf}${d.codice_fiscale ? `<CodiceFiscale>${xml(d.codice_fiscale)}</CodiceFiscale>` : ''}<Anagrafica><Denominazione>${xml(d.denominazione)}</Denominazione></Anagrafica></DatiAnagrafici>
<Sede><Indirizzo>${xml((d.ind_via ?? '') + ' ' + (d.ind_civico ?? ''))}</Indirizzo><CAP>${xml(d.ind_cap)}</CAP><Comune>${xml(d.ind_comune)}</Comune>${d.ind_prov ? `<Provincia>${xml(d.ind_prov)}</Provincia>` : ''}<Nazione>IT</Nazione></Sede></CessionarioCommittente>
</FatturaElettronicaHeader>
<FatturaElettronicaBody>
<DatiGenerali><DatiGeneraliDocumento><TipoDocumento>${td}</TipoDocumento><Divisa>EUR</Divisa><Data>${d.data_documento instanceof Date ? d.data_documento.toISOString().slice(0, 10) : d.data_documento}</Data><Numero>${d.numero}/${d.anno}</Numero><ImportoTotaleDocumento>${fmt(sgn * d.totale)}</ImportoTotaleDocumento>${d.note ? `<Causale>${xml(d.note.slice(0, 200))}</Causale>` : ''}</DatiGeneraliDocumento>
${nc && d.onum ? `<DatiFattureCollegate><IdDocumento>${d.onum}/${d.oanno}</IdDocumento></DatiFattureCollegate>` : ''}</DatiGenerali>
<DatiBeniServizi>
${righe.map((r, i) => `<DettaglioLinee><NumeroLinea>${i + 1}</NumeroLinea><Descrizione>${xml(r.descrizione.slice(0, 1000))}</Descrizione>${r.quantita != null ? `<Quantita>${fmt(Math.abs(r.quantita), 3)}</Quantita>${r.um ? `<UnitaMisura>${xml(r.um)}</UnitaMisura>` : ''}` : ''}<PrezzoUnitario>${r.quantita != null && r.prezzo != null ? fmt(sgn * r.prezzo * (r.quantita < 0 ? -1 : 1), 6) : fmt(sgn * r.imponibile, 6)}</PrezzoUnitario><PrezzoTotale>${fmt(sgn * r.imponibile)}</PrezzoTotale><AliquotaIVA>${fmt(r.fuori_campo_iva ? 0 : Number(r.iva_pct))}</AliquotaIVA>${r.fuori_campo_iva ? '<Natura>N2.2</Natura>' : ''}</DettaglioLinee>`).join('\n')}
${[...riep.values()].map(x => `<DatiRiepilogo><AliquotaIVA>${fmt(x.aliq)}</AliquotaIVA>${x.nat ? `<Natura>${x.nat}</Natura>` : ''}<ImponibileImporto>${fmt(x.imp)}</ImponibileImporto><Imposta>${fmt(x.iva)}</Imposta><EsigibilitaIVA>${pa ? 'S' : 'I'}</EsigibilitaIVA></DatiRiepilogo>`).join('\n')}
</DatiBeniServizi>
${!nc ? `<DatiPagamento><CondizioniPagamento>TP02</CondizioniPagamento><DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento><DataScadenzaPagamento>${d.scadenza instanceof Date ? d.scadenza.toISOString().slice(0, 10) : d.scadenza}</DataScadenzaPagamento><ImportoPagamento>${fmt(d.totale)}</ImportoPagamento>${ced.iban ? `<IBAN>${xml(ced.iban)}</IBAN>` : ''}</DettaglioPagamento></DatiPagamento>` : ''}
</FatturaElettronicaBody></p:FatturaElettronica>`;
}

// ---------- Flusso STABO: record per documento per stampatore esterno ----------
export async function flussoStampa(runId: number) {
  const { rows } = await pool.query(
    `SELECT d.id, d.numero, d.anno, d.tipo, d.data_documento::text, d.scadenza::text, d.periodo_da::text, d.periodo_a::text, d.imponibile, d.iva, d.fuori_campo_iva, d.totale,
            a.codice AS cod_cliente, a.denominazione, a.ind_via, a.ind_civico, a.ind_cap, a.ind_comune, a.ind_prov, f.codice AS cod_fornitura, d.note, d.insoluti_esposti
       FROM documento d JOIN anagrafica a ON a.id=d.anagrafica_id LEFT JOIN fornitura f ON f.id=d.fornitura_id WHERE d.run_id=$1 ORDER BY d.id`, [runId]);
  const out: Record<string, unknown>[] = [];
  for (const d of rows) {
    const { rows: righe } = await pool.query(`SELECT tipo_riga, descrizione, quantita, um, prezzo, imponibile, iva_pct FROM documento_riga WHERE documento_id=$1 ORDER BY ordine`, [d.id]);
    const insol = d.insoluti_esposti ? (d.insoluti_esposti as any[]).map(x => `${x.numero}/${x.anno} € ${Number(x.residuo).toFixed(2)}`).join(' | ') : '';
    out.push({ record: 'T', numero: d.numero ?? 'PROVA', anno: d.anno ?? '', ...d, righe: undefined, insoluti_esposti: insol });
    for (const r of righe) out.push({ record: 'R', numero: d.numero ?? 'PROVA', anno: d.anno ?? '', ...r });
  }
  return toCsv(out, ['record', 'numero', 'anno', 'tipo', 'data_documento', 'scadenza', 'periodo_da', 'periodo_a', 'cod_cliente', 'denominazione', 'ind_via', 'ind_civico', 'ind_cap', 'ind_comune', 'ind_prov', 'cod_fornitura',
    'tipo_riga', 'descrizione', 'quantita', 'um', 'prezzo', 'imponibile', 'iva_pct', 'iva', 'fuori_campo_iva', 'totale', 'insoluti_esposti', 'note']);
}

// ---------- SAP: file contabili ----------
async function conto(map: Map<string, string>, servizio: string, chiave: string) {
  const c = map.get(`${servizio}|${chiave}`) ?? map.get(`|${chiave}`);
  if (!c) throw err(`Piano dei conti: manca il conto per «${chiave}» (${servizio})`);
  return c;
}
async function pianoConti() {
  const { rows } = await pool.query(`SELECT COALESCE(servizio::text,'') AS s, chiave, conto_sap FROM piano_conti`);
  return new Map(rows.map(r => [`${r.s}|${r.chiave}`, r.conto_sap]));
}

/** Contabilizzazione emesso: scritture per documento (cliente dare, ricavi per tipo riga avere, IVA avere). */
export async function sapEmesso(servizio: string, da: string, a: string, definitivo: boolean, utente: string) {
  const piano = await pianoConti();
  const { rows: docs } = await pool.query(
    `SELECT d.*, a.codice AS cod_cliente FROM documento d JOIN anagrafica a ON a.id=d.anagrafica_id
      WHERE d.servizio=$1 AND d.stato='emesso' AND d.data_documento BETWEEN $2 AND $3 AND d.contabilizzazione_id IS NULL ORDER BY d.data_documento, d.numero`, [servizio, da, a]);
  const mov: Record<string, unknown>[] = [];
  for (const d of docs) {
    const { rows: righe } = await pool.query(`SELECT tipo_riga, sum(imponibile) AS imp, sum(iva) AS iva FROM documento_riga WHERE documento_id=$1 GROUP BY tipo_riga`, [d.id]);
    const base = { data: d.data_documento.toISOString?.().slice(0, 10) ?? d.data_documento, documento: `${d.numero}/${d.anno}`, tipo: d.tipo, cliente: d.cod_cliente };
    mov.push({ ...base, conto: await conto(piano, servizio, 'cliente'), dare: d.totale, avere: 0, descrizione: 'Credito vs cliente' });
    for (const r of righe) if (Math.abs(r.imp) > 0.004) mov.push({ ...base, conto: await conto(piano, servizio, r.tipo_riga), dare: 0, avere: r2(r.imp), descrizione: r.tipo_riga });
    const ivaTot = righe.reduce((s, r) => s + Number(r.iva), 0);
    if (Math.abs(ivaTot) > 0.004) mov.push({ ...base, conto: await conto(piano, servizio, 'iva'), dare: 0, avere: r2(ivaTot), descrizione: 'IVA a debito' });
  }
  const totale = r2(docs.reduce((s, d) => s + d.totale, 0));
  if (definitivo && docs.length) await tx(async c => {
    const { rows: [b] } = await c.query(`INSERT INTO contabilizzazione(tipo,servizio,da,a,n_movimenti,totale) VALUES ('emesso',$1,$2,$3,$4,$5) RETURNING id`, [servizio, da, a, mov.length, totale]);
    await c.query(`UPDATE documento SET contabilizzazione_id=$1 WHERE id = ANY($2)`, [b.id, docs.map(d => d.id)]);
  }, utente);
  return { csv: toCsv(mov), n_documenti: docs.length, totale };
}

/** Contabilizzazione incassi / mazzette: banca-posta dare, cliente avere. */
export async function sapIncassi(da: string, a: string, definitivo: boolean, utente: string) {
  const piano = await pianoConti();
  const { rows } = await pool.query(
    `SELECT i.*, an.codice AS cod_cliente FROM incasso i LEFT JOIN anagrafica an ON an.id=i.anagrafica_id
      WHERE i.data_valuta BETWEEN $1 AND $2 AND i.sap_batch_id IS NULL AND i.stato<>'stornato' ORDER BY i.data_valuta, i.id`, [da, a]);
  const mov: Record<string, unknown>[] = [];
  for (const i of rows) {
    const base = { data: i.data_valuta.toISOString?.().slice(0, 10) ?? i.data_valuta, riferimento: i.riferimento, mazzetta: i.mazzetta_id, cliente: i.cod_cliente };
    mov.push({ ...base, conto: await conto(piano, '', `incasso:${i.canale}`), dare: i.importo, avere: 0, descrizione: `Incasso ${i.canale}` });
    mov.push({ ...base, conto: await conto(piano, '', 'cliente'), dare: 0, avere: i.importo, descrizione: i.cod_cliente ? 'Chiusura credito cliente' : 'Incasso da identificare' });
  }
  const totale = r2(rows.reduce((s, i) => s + i.importo, 0));
  if (definitivo && rows.length) await tx(async c => {
    const { rows: [b] } = await c.query(`INSERT INTO contabilizzazione(tipo,da,a,n_movimenti,totale) VALUES ('incassi',$1,$2,$3,$4) RETURNING id`, [da, a, mov.length, totale]);
    await c.query(`UPDATE incasso SET sap_batch_id=$1 WHERE id = ANY($2)`, [b.id, rows.map(i => i.id)]);
  }, utente);
  return { csv: toCsv(mov), n_incassi: rows.length, totale };
}
