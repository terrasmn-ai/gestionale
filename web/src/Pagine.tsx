import { useEffect, useState } from 'react';
import { api, scarica, apriStampa } from './api';
import { Msg } from './Grid';

const oggi = () => new Date().toISOString().slice(0, 10);
const eur = (n: number) => Number(n ?? 0).toLocaleString('it-IT', { minimumFractionDigits: 2 });
type P = { servizi: string[] };
const useServ = (servizi: string[]) => useState(servizi[0] ?? 'TLR');
const Servizio = ({ v, set, servizi }: { v: string; set: (s: string) => void; servizi: string[] }) => <select value={v} onChange={e => set(e.target.value)}>{servizi.map(s => <option key={s}>{s}</option>)}</select>;
function useAction() { const [err, setErr] = useState(''); const [out, setOut] = useState<any>(null); const run = async (f: () => Promise<any>) => { setErr(''); try { setOut(await f()); } catch (e: any) { setErr(e.message); } }; return { err, out, run, setOut }; }
const Json = ({ v }: { v: any }) => v == null ? null : <pre>{typeof v === 'string' ? v : JSON.stringify(v, null, 1)}</pre>;

export function Fatturazione({ servizi }: P) {
  const [s, setS] = useServ(servizi); const [dd, setDd] = useState(oggi()); const [df, setDf] = useState(oggi()); const [ciclo, setCiclo] = useState(''); const [stima, setStima] = useState(false);
  const [cicli, setCicli] = useState<any[]>([]); const [runs, setRuns] = useState<any[]>([]); const [sel, setSel] = useState<any>(null); const { err, out, run } = useAction();
  const load = () => api('GET', '/api/fatturazione').then(setRuns); useEffect(() => { load(); }, []);
  useEffect(() => { api('GET', `/api/ciclo_fatturazione?servizio=${s}`).then(setCicli); }, [s]);
  const apri = (id: number) => api('GET', `/api/fatturazione/${id}`).then(setSel);
  return <div><h2>Fatturazione</h2>
    <div className="bar"><Servizio v={s} set={setS} servizi={servizi} /><select value={ciclo} onChange={e => setCiclo(e.target.value)}><option value="">Tutti i cicli</option>{cicli.map(c => <option key={c.id} value={c.id}>{c.descrizione}</option>)}</select>
      <label>Data doc. <input type="date" value={dd} onChange={e => setDd(e.target.value)} /></label><label>Letture fino al <input type="date" value={df} onChange={e => setDf(e.target.value)} /></label>
      <label><input type="checkbox" checked={stima} onChange={e => setStima(e.target.checked)} /> stima letture mancanti</label>
      <button onClick={() => run(async () => { const r = await api('POST', '/api/fatturazione/prova', { servizio: s, ciclo_id: ciclo ? Number(ciclo) : undefined, data_documento: dd, data_fino: df, stima_mancanti: stima }); load(); apri(r.run_id); return r; })}>Elabora in prova</button></div>
    <Msg e={err} />{out?.anomalie?.length > 0 && <details open><summary>{out.anomalie.length} anomalie</summary><table><tbody>{out.anomalie.map((a: any, i: number) => <tr key={i}><td>{a.codice}</td><td>{a.messaggio}</td></tr>)}</tbody></table></details>}
    <h3>Elaborazioni</h3><table><thead><tr><th>#</th><th>Servizio</th><th>Stato</th><th>Doc.</th><th>Totale</th><th>Data</th><th /></tr></thead><tbody>{runs.map(r => <tr key={r.id} className={sel?.run?.id === r.id ? 'sel' : ''}><td>{r.id}</td><td>{r.servizio}</td><td>{r.stato}</td><td>{r.n_documenti}</td><td className="n">{eur(r.totale)}</td><td>{String(r.data_documento).slice(0, 10)}</td><td className="act"><button className="sec" onClick={() => apri(r.id)}>Apri</button></td></tr>)}</tbody></table>
    {sel && <div><h3>Elaborazione #{sel.run.id} — {sel.run.stato}</h3>
      <div className="bar">
        {sel.run.stato === 'prova' && <><button onClick={() => confirm('Emettere i documenti? La numerazione sarà definitiva.') && run(async () => { const r = await api('POST', `/api/fatturazione/${sel.run.id}/conferma`); load(); apri(sel.run.id); return r; })}>Conferma → effettivo</button>
          <button className="sec" onClick={() => run(async () => { await api('DELETE', `/api/fatturazione/${sel.run.id}`); setSel(null); load(); return null; })}>Elimina prova</button></>}
        <button className="sec" onClick={() => scarica('GET', `/api/fatturazione/${sel.run.id}/stampa.csv`)}>Flusso stampatore</button>
        {s === 'TLR' && <button className="sec" onClick={() => scarica('GET', `/api/fatturazione/${sel.run.id}/defalco?formato=csv`)}>Verifica defalco</button>}</div>
      <table><thead><tr><th>N.</th><th>Cliente</th><th>Fornitura</th><th>Tipo</th><th>Totale</th><th>Scadenza</th><th /></tr></thead><tbody>{sel.documenti.map((d: any) => <tr key={d.id}><td>{d.numero ? `${d.numero}/${d.anno}` : 'prova'}</td><td>{d.denominazione}</td><td>{d.fornitura}</td><td>{d.tipo}</td><td className="n">{eur(d.totale)}</td><td>{String(d.scadenza).slice(0, 10)}</td>
        <td className="act"><button className="sec" onClick={() => apriStampa(`/api/documenti/${d.id}/stampa`)}>Stampa</button>{sel.run.stato === 'effettivo' && <button className="sec" onClick={() => scarica('GET', `/api/documenti/${d.id}/fatturapa.xml`)}>XML SDI</button>}</td></tr>)}</tbody></table></div>}
  </div>;
}

export function Documenti({ servizi }: P) {
  const [rows, setRows] = useState<any[]>([]); const [q, setQ] = useState(''); const [st, setSt] = useState('emesso'); const { err, run } = useAction();
  const load = () => api('GET', `/api/documenti?stato=${st}&q=${encodeURIComponent(q)}`).then(setRows); useEffect(() => { load(); }, [q, st]);
  return <div><h2>Documenti</h2><div className="bar"><input placeholder="Cliente o numero" value={q} onChange={e => setQ(e.target.value)} /><select value={st} onChange={e => setSt(e.target.value)}><option>emesso</option><option>prova</option><option>annullato</option></select>
    <PuntualeBtn servizi={servizi} onDone={load} /></div><Msg e={err} />
    <table><thead><tr><th>N.</th><th>Srv</th><th>Tipo</th><th>Cliente</th><th>Fornitura</th><th>Data</th><th>Totale</th><th>Residuo</th><th /></tr></thead><tbody>{rows.map(d => <tr key={d.id}><td>{d.numero ? `${d.numero}/${d.anno}` : 'prova'}</td><td>{d.servizio}</td><td>{d.tipo}</td><td>{d.denominazione}</td><td>{d.fornitura}</td><td>{String(d.data_documento).slice(0, 10)}</td><td className="n">{eur(d.totale)}</td><td className="n">{eur(d.residuo)}</td>
      <td className="act"><button className="sec" onClick={() => apriStampa(`/api/documenti/${d.id}/stampa`)}>Stampa</button>{d.stato === 'emesso' && d.tipo !== 'nota_credito' && <button className="sec" onClick={() => confirm('Stornare con nota di credito?') && run(async () => { await api('POST', `/api/documenti/${d.id}/nota-credito`, { data: oggi() }); load(); })}>Storna</button>}</td></tr>)}</tbody></table></div>;
}
function PuntualeBtn({ servizi, onDone }: { servizi: string[]; onDone: () => void }) {
  const [cod, setCod] = useState(''); const [forn, setForn] = useState<any[]>([]); const { err, out, run } = useAction();
  useEffect(() => { if (cod.length > 1) api('GET', `/api/fornitura?q=${encodeURIComponent(cod)}&limit=8`).then(setForn); else setForn([]); }, [cod]);
  return <span className="inline"><input placeholder="Fatt. puntuale: cod. fornitura" value={cod} onChange={e => setCod(e.target.value)} list="fl" /><datalist id="fl">{forn.map(f => <option key={f.id} value={f.codice}>{f.denominazione}</option>)}</datalist>
    <button onClick={() => { const f = forn.find(x => x.codice === cod); if (f) run(async () => { const r = await api('POST', '/api/fatturazione/puntuale', { fornitura_id: f.id, servizio: f.servizio, data_documento: oggi() }); onDone(); return r; }); }}>Fattura</button>
    {err && <span className="err">{err}</span>}{out?.n_documenti === 0 && <span className="muted"> nessuna lettura da fatturare</span>}</span>;
}

export function Letture({ servizi }: P) {
  const [s, setS] = useServ(servizi); const [testo, setTesto] = useState(''); const { err, out, run } = useAction();
  return <div><h2>Letture — import massivo</h2><div className="bar"><Servizio v={s} set={setS} servizi={servizi} /><button className="sec" onClick={() => scarica('GET', `/api/letture/template?servizio=${s}`)}>Scarica elenco utenze attive</button><button className="sec" onClick={() => scarica('GET', `/api/letture/da-fatturare?servizio=${s}&formato=csv`)}>Letture da fatturare</button></div>
    <p className="muted">Formato: <code>matricola;data;valore[;tipo]</code> (data AAAA-MM-GG o GG/MM/AAAA). Le righe scartate vengono elencate.</p>
    <textarea rows={8} value={testo} onChange={e => setTesto(e.target.value)} placeholder="Incolla qui le letture o carica un file" />
    <div className="bar"><input type="file" onChange={async e => e.target.files?.[0] && setTesto(await e.target.files[0].text())} /><button onClick={() => run(() => api('POST', '/api/letture/import', { testo }))}>Importa</button></div><Msg e={err} /><Json v={out} /></div>;
}

export function Crediti({ servizi }: P) {
  const [s, setS] = useServ(servizi); const [data, setData] = useState(oggi()); const [testo, setTesto] = useState(''); const [formato, setFormato] = useState('poste'); const [ins, setIns] = useState<any[]>([]); const { err, out, run } = useAction();
  useEffect(() => { api('GET', '/api/crediti/insoluti').then(setIns); }, [out]);
  return <div><h2>Crediti e incassi</h2>
    <h3>Import incassi</h3><div className="bar"><select value={formato} onChange={e => setFormato(e.target.value)}><option value="poste">Poste (txt: n. bolletta;importo;data)</option><option value="banca">Banca (csv: data;importo;causale)</option></select><input type="file" onChange={async e => e.target.files?.[0] && setTesto(await e.target.files[0].text())} /></div>
    <textarea rows={5} value={testo} onChange={e => setTesto(e.target.value)} /><div className="bar"><button onClick={() => run(() => api('POST', '/api/incassi/import', { formato, testo }))}>Importa e abbina</button></div>
    <h3>Mora e solleciti</h3><div className="bar"><Servizio v={s} set={setS} servizi={servizi} /><input type="date" value={data} onChange={e => setData(e.target.value)} />
      <button className="sec" onClick={() => run(() => api('POST', '/api/crediti/mora', { servizio: s, alla_data: data, scrivi: false }))}>Simula mora</button>
      <button onClick={() => confirm('Generare le partite di mora?') && run(() => api('POST', '/api/crediti/mora', { servizio: s, alla_data: data, scrivi: true }))}>Addebita mora</button>
      <button className="sec" onClick={() => run(() => api('POST', '/api/crediti/solleciti', { servizio: s, alla_data: data, scrivi: false }))}>Elenco solleciti</button>
      <button onClick={() => run(() => api('POST', '/api/crediti/solleciti', { servizio: s, alla_data: data, scrivi: true }))}>Registra solleciti</button></div>
    <Msg e={err} /><Json v={out} />
    <h3>Insoluti ({ins.length})</h3><table><thead><tr><th>Doc.</th><th>Srv</th><th>Cliente</th><th>Scadenza</th><th>Residuo</th><th>Ritardo gg</th></tr></thead><tbody>{ins.map(d => <tr key={d.id}><td>{d.numero}/{d.anno}</td><td>{d.servizio}</td><td>{d.denominazione}</td><td>{d.scadenza}</td><td className="n">{eur(d.residuo)}</td><td className="n">{d.giorni_ritardo}</td></tr>)}</tbody></table></div>;
}

export function Dichiarazioni({ servizi }: P) {
  const [anno, setAnno] = useState(new Date().getFullYear()); const [mese, setMese] = useState(new Date().getMonth() + 1); const [s, setS] = useServ(servizi); const [da, setDa] = useState(`${new Date().getFullYear()}-01-01`); const [a, setA] = useState(oggi()); const { err, out, run } = useAction();
  const rep = ['elenco_fatture', 'prospetto_rendite', 'consumi_competenza', 'qf_competenza', 'verifica_iva', 'giornale_iva', 'quadratura_incassi'];
  return <div><h2>Dichiarazioni, report e flussi</h2><Msg e={err} />
    <div className="bar"><label>Anno <input type="number" value={anno} onChange={e => setAnno(+e.target.value)} /></label><label>Mese <input type="number" min={1} max={12} value={mese} onChange={e => setMese(+e.target.value)} /></label></div>
    <div className="bar">{servizi.includes('GPL') && <><button onClick={() => run(() => api('GET', `/api/dichiarazioni/accise-mensile?anno=${anno}&mese=${mese}`))}>Accise mensile (anteprima)</button><button className="sec" onClick={() => scarica('GET', `/api/dichiarazioni/accise-mensile?anno=${anno}&mese=${mese}&formato=csv`)}>CSV</button>
      <button onClick={() => run(() => api('GET', `/api/dichiarazioni/accise-annuale?anno=${anno}`))}>Accise annuale Dogane</button><button className="sec" onClick={() => scarica('GET', `/api/dichiarazioni/accise-annuale?anno=${anno}&formato=csv`)}>CSV</button></>}
      {servizi.includes('TLR') && <><button onClick={() => run(() => api('GET', `/api/dichiarazioni/tlr-annuale?anno=${anno}`))}>Dichiarazione annuale TLR</button><button className="sec" onClick={() => scarica('GET', `/api/dichiarazioni/tlr-annuale?anno=${anno}&formato=csv`)}>Excel/CSV</button>
        <button className="sec" onClick={() => scarica('GET', `/api/bonus-sociale/rendicontazione?anno=${anno}&formato=csv`)}>Rendicontazione bonus sociale</button></>}</div>
    <h3>Report periodici</h3><div className="bar"><Servizio v={s} set={setS} servizi={servizi} /><input type="date" value={da} onChange={e => setDa(e.target.value)} /><input type="date" value={a} onChange={e => setA(e.target.value)} /></div>
    <div className="bar">{rep.map(r => <span key={r}><button className="sec" onClick={() => run(() => api('GET', `/api/report/${r}?servizio=${s}&da=${da}&a=${a}`))}>{r.replace('_', ' ')}</button><button className="sec" title="CSV" onClick={() => scarica('GET', `/api/report/${r}?servizio=${s}&da=${da}&a=${a}&formato=csv`)}>⬇</button></span>)}</div>
    <h3>Flussi</h3><div className="bar"><button className="sec" onClick={() => scarica('GET', `/api/export/sepa.xml?servizio=${s}&da=${da}&a=${a}`)}>Flusso SEPA (scadenze nel periodo)</button></div>
    <Tabella v={out} /></div>;
}
function Tabella({ v }: { v: any }) {
  const rows = Array.isArray(v) ? v : v?.righe; if (!Array.isArray(rows)) return <Json v={v} />;
  const cols = rows.length ? Object.keys(rows[0]) : [];
  return <div><Json v={v?.righe ? { ...v, righe: `(${rows.length} righe)` } : null} /><table><thead><tr>{cols.map(c => <th key={c}>{c}</th>)}</tr></thead><tbody>{rows.map((r: any, i: number) => <tr key={i}>{cols.map(c => <td key={c}>{String(r[c] ?? '')}</td>)}</tr>)}</tbody></table></div>;
}

export function Sap({ servizi }: P) {
  const [s, setS] = useServ(servizi); const [da, setDa] = useState(`${new Date().getFullYear()}-01-01`); const [a, setA] = useState(oggi()); const [def, setDef] = useState(false); const { err, run } = useAction();
  return <div><h2>Contabilità — file per SAP</h2><div className="bar"><Servizio v={s} set={setS} servizi={servizi} /><input type="date" value={da} onChange={e => setDa(e.target.value)} /><input type="date" value={a} onChange={e => setA(e.target.value)} /><label><input type="checkbox" checked={def} onChange={e => setDef(e.target.checked)} /> definitivo (marca come contabilizzato)</label></div>
    <div className="bar"><button onClick={() => run(() => scarica('POST', '/api/sap/emesso', { servizio: s, da, a, definitivo: def }))}>Contabilizza emesso</button><button onClick={() => run(() => scarica('POST', '/api/sap/incassi', { da, a, definitivo: def }))}>Contabilizza incassi / mazzette</button></div>
    <p className="muted">I conti si configurano in «Piano dei conti → SAP». Il tracciato esatto del file SAP va concordato con l'amministrazione: oggi è un CSV con data, documento, cliente, conto, dare, avere.</p><Msg e={err} /></div>;
}

export function Tariffe() {
  const [t, setT] = useState<any[]>([]); const [sel, setSel] = useState<any>(null); const [ver, setVer] = useState<any[]>([]); const [dal, setDal] = useState(oggi()); const [json, setJson] = useState(''); const { err, out, run } = useAction();
  useEffect(() => { api('GET', '/api/tariffa').then(setT); }, []);
  const apri = (x: any) => api('GET', `/api/tariffa/${x.id}/versioni`).then(v => { setSel(x); setVer(v); setJson(JSON.stringify(v[0]?.regole ?? {}, null, 2)); });
  return <div><h2>Regole tariffarie (versionate)</h2><p className="muted">Scaglioni, quote fisse, crediti d'imposta, prezzi GPL: configurabili qui senza intervento di sviluppo. Ogni modifica è una nuova versione con data di decorrenza.</p>
    <div className="bar">{t.map(x => <button key={x.id} className={sel?.id === x.id ? '' : 'sec'} onClick={() => apri(x)}>{x.codice}</button>)}</div>
    {sel && <div><p>Versioni: {ver.map(v => <a key={v.id} href="#" onClick={e => { e.preventDefault(); setJson(JSON.stringify(v.regole, null, 2)); setDal(String(v.valido_dal).slice(0, 10)); }}>{String(v.valido_dal).slice(0, 10)} </a>)}</p>
      <div className="bar"><label>In vigore dal <input type="date" value={dal} onChange={e => setDal(e.target.value)} /></label><button onClick={() => run(async () => { const r = await api('POST', `/api/tariffa/${sel.id}/versioni`, { valido_dal: dal, regole: JSON.parse(json) }); apri(sel); return r; })}>Salva versione</button></div>
      <textarea rows={18} className="mono" value={json} onChange={e => setJson(e.target.value)} /></div>}<Msg e={err} />{out && <p className="ok">Salvata.</p>}</div>;
}

export function ImportBonus() {
  const [testo, setTesto] = useState(''); const { err, out, run } = useAction();
  return <div><h2>Bonus sociale TLR — acquisizione flusso</h2><p className="muted">CSV: <code>codice_fiscale;codice_fornitura;valido_dal;valido_al;importo;protocollo</code>. Si verifica che il codice fiscale coincida con l'intestatario; gli scarti sono riportati con il motivo.</p>
    <input type="file" onChange={async e => e.target.files?.[0] && setTesto(await e.target.files[0].text())} /><textarea rows={8} value={testo} onChange={e => setTesto(e.target.value)} /><div className="bar"><button onClick={() => run(() => api('POST', '/api/bonus-sociale/flusso', { nome_file: 'manuale', testo }))}>Acquisisci</button></div><Msg e={err} /><Json v={out} /></div>;
}

export function PartiteMassive() {
  const [testo, setTesto] = useState(''); const [lotto, setLotto] = useState(''); const { err, out, run } = useAction();
  return <div><h2>Partite massive (es. assicurazione)</h2><p className="muted">CSV: <code>codice_fornitura;addebito|accredito;descrizione;imponibile;iva_pct;fc(0/1)</code></p>
    <div className="bar"><input placeholder="Lotto" value={lotto} onChange={e => setLotto(e.target.value)} /><input type="file" onChange={async e => e.target.files?.[0] && setTesto(await e.target.files[0].text())} /></div><textarea rows={6} value={testo} onChange={e => setTesto(e.target.value)} />
    <div className="bar"><button onClick={() => run(() => api('POST', '/api/partite/import', { testo, lotto }))}>Importa</button></div><Msg e={err} /><Json v={out} /></div>;
}

export function Preventivi() {
  const [rows, setRows] = useState<any[]>([]); const { err, run } = useAction(); const [nuovo, setNuovo] = useState<any>(null); const [an, setAn] = useState<any[]>([]); const [lis, setLis] = useState<any[]>([]);
  const load = () => api('GET', '/api/preventivi').then(setRows); useEffect(() => { load(); api('GET', '/api/anagrafica?limit=500').then(setAn); api('GET', '/api/listino').then(setLis); }, []);
  const stato = (id: number, s: string) => run(async () => { await api('PUT', `/api/preventivi/${id}/stato`, { stato: s }); load(); });
  return <div><h2>Preventivi</h2><div className="bar"><button onClick={() => setNuovo({ servizio: 'GPL', righe: [] })}>+ Nuovo</button></div><Msg e={err} />
    {nuovo && <div className="form"><label>Servizio<select value={nuovo.servizio} onChange={e => setNuovo({ ...nuovo, servizio: e.target.value })}><option>GPL</option><option>TLR</option></select></label>
      <label>Cliente<select value={nuovo.anagrafica_id ?? ''} onChange={e => setNuovo({ ...nuovo, anagrafica_id: +e.target.value })}><option value="">—</option>{an.map(a => <option key={a.id} value={a.id}>{a.denominazione}</option>)}</select></label>
      <label>Aggiungi voce da listino<select value="" onChange={e => e.target.value && setNuovo({ ...nuovo, righe: [...nuovo.righe, { listino_id: +e.target.value, quantita: 1 }] })}><option value="">—</option>{lis.map(l => <option key={l.id} value={l.id}>{l.codice} — {l.descrizione} ({l.prezzo})</option>)}</select></label>
      {nuovo.righe.map((r: any, i: number) => <div key={i}>{lis.find(l => l.id === r.listino_id)?.descrizione} × <input type="number" value={r.quantita} onChange={e => setNuovo({ ...nuovo, righe: nuovo.righe.map((x: any, j: number) => j === i ? { ...x, quantita: +e.target.value } : x) })} /></div>)}
      <div><button onClick={() => run(async () => { await api('POST', '/api/preventivi', nuovo); setNuovo(null); load(); })}>Crea</button> <button className="sec" onClick={() => setNuovo(null)}>Annulla</button></div></div>}
    <table><thead><tr><th>N.</th><th>Srv</th><th>Cliente</th><th>Stato</th><th>Imponibile</th><th /></tr></thead><tbody>{rows.map(p => <tr key={p.id}><td>{p.numero}/{p.anno}</td><td>{p.servizio}</td><td>{p.denominazione}</td><td>{p.stato}</td><td className="n">{eur(p.imponibile)}</td>
      <td className="act">{p.stato === 'bozza' && <button className="sec" onClick={() => stato(p.id, 'emesso')}>Emetti</button>}{p.stato === 'emesso' && <><button className="sec" onClick={() => stato(p.id, 'approvato')}>Approva</button><button className="sec" onClick={() => stato(p.id, 'rifiutato')}>Rifiuta</button></>}
        {p.stato === 'approvato' && <button onClick={() => run(async () => { await api('POST', `/api/preventivi/${p.id}/fattura`, { data: oggi() }); load(); })}>→ Fattura</button>}</td></tr>)}</tbody></table></div>;
}

