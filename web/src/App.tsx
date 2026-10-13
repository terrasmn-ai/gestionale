import { useEffect, useState } from 'react';
import { api, sessione } from './api';
import { Grid, Def, Msg } from './Grid';
import { defs } from './defs';
import * as P from './Pagine';

type Voce = { id: string; label: string; solo?: 'TLR' | 'GPL'; el: (servizi: string[]) => JSX.Element };
const grid = (k: string, extra?: Partial<Def>) => () => <Grid key={k} def={{ ...defs[k], ...extra }} />;
const menu: { gruppo: string; voci: Voce[] }[] = [
  { gruppo: 'Anagrafiche', voci: [{ id: 'anagrafica', label: 'Clienti', el: grid('anagrafica') }, { id: 'domiciliazione', label: 'Domiciliazioni SEPA', el: grid('domiciliazione') }, { id: 'fornitura', label: 'Forniture / utenze', el: grid('fornitura') }, { id: 'contatore', label: 'Contatori (padre/figlio)', el: grid('contatore') }] },
  { gruppo: 'Contratti e sportello', voci: [{ id: 'contratto', label: 'Contratti ed eventi', el: () => <Contratti /> }, { id: 'pratica', label: 'Pratiche', el: grid('pratica') }, { id: 'preventivi', label: 'Preventivi', el: () => <P.Preventivi /> }, { id: 'odi', label: 'Ordini di intervento', el: grid('odi') }] },
  { gruppo: 'Letture', voci: [{ id: 'letture', label: 'Import letture', el: s => <P.Letture servizi={s} /> }, { id: 'lettura', label: 'Storico letture', el: grid('lettura') }] },
  { gruppo: 'Fatturazione', voci: [{ id: 'fatt', label: 'Elaborazioni', el: s => <P.Fatturazione servizi={s} /> }, { id: 'docs', label: 'Documenti', el: s => <P.Documenti servizi={s} /> }, { id: 'partita', label: 'Addebiti / accrediti', el: grid('partita') }, { id: 'partmass', label: 'Partite massive', el: () => <P.PartiteMassive /> }, { id: 'bonusimp', label: 'Bonus sociale – flusso', solo: 'TLR', el: () => <P.ImportBonus /> }, { id: 'bonus', label: 'Bonus sociale – elenco', solo: 'TLR', el: grid('bonus') }] },
  { gruppo: 'Crediti e incassi', voci: [{ id: 'crediti', label: 'Incassi, mora, solleciti', el: s => <P.Crediti servizi={s} /> }, { id: 'incasso', label: 'Incassi', el: grid('incasso') }, { id: 'mazzetta', label: 'Mazzette', el: grid('mazzetta') }] },
  { gruppo: 'Dichiarazioni e contabilità', voci: [{ id: 'dich', label: 'Dichiarazioni e report', el: s => <P.Dichiarazioni servizi={s} /> }, { id: 'sap', label: 'File SAP', el: s => <P.Sap servizi={s} /> }] },
  { gruppo: 'Configurazione', voci: [{ id: 'tariffe', label: 'Regole tariffarie', el: () => <P.Tariffe /> }, { id: 'tariffa', label: 'Elenco tariffe', el: grid('tariffa') }, { id: 'parametro', label: 'Parametri (BCE, accise…)', el: grid('parametro') }, { id: 'coeff', label: 'Coefficiente C', solo: 'GPL', el: grid('coeff') }, { id: 'comune', label: 'Comuni', el: grid('comune') }, { id: 'categoria', label: 'Categorie cliente', el: grid('categoria') }, { id: 'ciclo', label: 'Cicli di fatturazione', el: grid('ciclo') }, { id: 'listino', label: 'Listino', el: grid('listino') }, { id: 'piano_conti', label: 'Piano dei conti', el: grid('piano_conti') }] },
];

function Contratti() {
  const [k, setK] = useState(0); const [err, setErr] = useState('');
  return <div><Msg e={err} /><Grid key={k} def={{ ...defs.contratto, extra: r => r.stato !== 'efficace' && <button onClick={async () => { try { setErr(''); await api('POST', `/api/contratti/${r.id}/applica`); setK(k + 1); } catch (e: any) { setErr(e.message); } }}>Applica evento</button> }} /></div>;
}

function Login({ ok }: { ok: () => void }) {
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [e, setE] = useState('');
  return <form className="login" onSubmit={async ev => { ev.preventDefault(); try { const r = await api('POST', '/api/login', { username: u, password: p }); sessione.set(r.token, r.ruolo, r.username); ok(); } catch (x: any) { setE(x.message); } }}>
    <h1>Gestionale TLR / GPL</h1><input placeholder="Utente" value={u} onChange={x => setU(x.target.value)} autoFocus /><input type="password" placeholder="Password" value={p} onChange={x => setP(x.target.value)} /><button>Accedi</button><Msg e={e} /></form>;
}

export default function App() {
  const [logged, setLogged] = useState(!!sessione.token); const [servizi, setServizi] = useState<string[]>([]); const [cur, setCur] = useState('anagrafica');
  useEffect(() => { if (logged) api('GET', '/api/istanza').then(r => setServizi(r.servizi)); }, [logged]);
  if (!logged) return <Login ok={() => setLogged(true)} />;
  const voce = menu.flatMap(g => g.voci).find(v => v.id === cur)!;
  return <div className="app"><nav><div className="brand">Gestionale<br /><small>{servizi.join(' + ')}</small></div>
    {menu.map(g => <div key={g.gruppo}><h4>{g.gruppo}</h4>{g.voci.filter(v => !v.solo || servizi.includes(v.solo)).map(v => <a key={v.id} className={cur === v.id ? 'on' : ''} onClick={() => setCur(v.id)}>{v.label}</a>)}</div>)}
    <div className="user">{localStorage.getItem('user')} ({localStorage.getItem('ruolo')}) <a onClick={() => { sessione.clear(); setLogged(false); }}>esci</a></div></nav>
    <main>{servizi.length > 0 && voce.el(servizi)}</main></div>;
}
