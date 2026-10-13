import { useEffect, useState, ReactNode } from 'react';
import { api } from './api';

export interface Campo { nome: string; label?: string; tipo?: 'text' | 'number' | 'date' | 'bool' | 'select' | 'textarea'; opzioni?: string[]; rif?: string; rifLabel?: string; lista?: boolean; default?: unknown }
export interface Def { path: string; titolo: string; campi: Campo[]; filtri?: Record<string, string>; ricerca?: boolean; extra?: (row: any) => ReactNode; sola_lettura?: boolean }

export function Msg({ e }: { e: string }) { return e ? <div className="err">{e}</div> : null; }

/** Griglia + form generici su una risorsa CRUD. I campi con `rif` diventano select popolate dalla risorsa collegata. */
export function Grid({ def }: { def: Def }) {
  const [rows, setRows] = useState<any[]>([]); const [q, setQ] = useState(''); const [edit, setEdit] = useState<any | null>(null);
  const [err, setErr] = useState(''); const [rif, setRif] = useState<Record<string, any[]>>({});
  const qs = (extra = '') => { const p = new URLSearchParams(def.filtri); if (q) p.set('q', q); return `/api/${def.path}?${p}${extra}`; };
  const load = () => api('GET', qs()).then(setRows).catch(e => setErr(e.message));
  useEffect(() => { load(); setEdit(null); }, [def.path, q]);
  useEffect(() => { for (const c of def.campi) if (c.rif && !rif[c.rif]) api('GET', `/api/${c.rif}?limit=1000`).then(r => setRif(s => ({ ...s, [c.rif!]: r }))); }, [def.path]);
  const lbl = (c: Campo, v: any) => c.rif ? (() => { const o = rif[c.rif!]?.find(x => x.id === v); return o ? (o[c.rifLabel ?? 'descrizione'] ?? o.denominazione ?? o.codice ?? o.nome ?? o.matricola ?? v) : v ?? ''; })() : typeof v === 'boolean' ? (v ? '✓' : '') : v == null ? '' : String(v).slice(0, 40);
  const save = async () => {
    try { setErr(''); const body: any = {}; for (const c of def.campi) if (edit[c.nome] !== undefined) body[c.nome] = edit[c.nome] === '' ? null : edit[c.nome];
      await (edit.id ? api('PUT', `/api/${def.path}/${edit.id}`, body) : api('POST', `/api/${def.path}`, body)); setEdit(null); load(); } catch (e: any) { setErr(e.message); }
  };
  const nuovo = () => { const o: any = {}; for (const c of def.campi) if (c.default !== undefined) o[c.nome] = c.default; setEdit(o); };
  return <div>
    <h2>{def.titolo}</h2>
    <div className="bar">{def.ricerca !== false && <input placeholder="Cerca…" value={q} onChange={e => setQ(e.target.value)} />}{!def.sola_lettura && <button onClick={nuovo}>+ Nuovo</button>}</div>
    <Msg e={err} />
    {edit && <div className="form">{def.campi.map(c => <label key={c.nome}>{c.label ?? c.nome}
      {c.rif ? <select value={edit[c.nome] ?? ''} onChange={e => setEdit({ ...edit, [c.nome]: e.target.value ? Number(e.target.value) : null })}><option value="">—</option>{(rif[c.rif] ?? []).map(o => <option key={o.id} value={o.id}>{o[c.rifLabel ?? 'descrizione'] ?? o.denominazione ?? o.codice ?? o.nome ?? o.matricola}</option>)}</select>
        : c.tipo === 'select' ? <select value={edit[c.nome] ?? ''} onChange={e => setEdit({ ...edit, [c.nome]: e.target.value })}><option value="">—</option>{c.opzioni!.map(o => <option key={o}>{o}</option>)}</select>
        : c.tipo === 'bool' ? <input type="checkbox" checked={!!edit[c.nome]} onChange={e => setEdit({ ...edit, [c.nome]: e.target.checked })} />
        : c.tipo === 'textarea' ? <textarea value={edit[c.nome] ?? ''} onChange={e => setEdit({ ...edit, [c.nome]: e.target.value })} />
        : <input type={c.tipo === 'number' ? 'number' : c.tipo === 'date' ? 'date' : 'text'} step="any" value={(c.tipo === 'date' ? String(edit[c.nome] ?? '').slice(0, 10) : edit[c.nome]) ?? ''} onChange={e => setEdit({ ...edit, [c.nome]: c.tipo === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value })} />}
    </label>)}<div><button onClick={save}>Salva</button> <button className="sec" onClick={() => setEdit(null)}>Annulla</button></div></div>}
    <table><thead><tr>{def.campi.filter(c => c.lista !== false).map(c => <th key={c.nome}>{c.label ?? c.nome}</th>)}<th /></tr></thead>
      <tbody>{rows.map(r => <tr key={r.id}>{def.campi.filter(c => c.lista !== false).map(c => <td key={c.nome}>{lbl(c, r[c.nome])}</td>)}
        <td className="act">{!def.sola_lettura && <button className="sec" onClick={() => setEdit({ ...r })}>Modifica</button>}{def.extra?.(r)}</td></tr>)}</tbody></table>
    {!rows.length && <p className="muted">Nessun elemento.</p>}
  </div>;
}
