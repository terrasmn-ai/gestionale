import { FastifyInstance } from 'fastify';
import { crud, Risorsa } from './crud.js';
import { hashPassword } from '../auth.js';
import { pool } from '../db.js';
import { RegoleSchema } from '../engine/types.js';

const S = ['sportello'] as const, F = ['fatturazione'] as const, A = ['amministrazione'] as const, T = ['tecnico', 'sportello'] as const;

export const risorse: Risorsa[] = [
  { tabella: 'categoria_cliente', colonne: ['codice', 'descrizione', 'giorni_scadenza', 'esente_mora', 'pubblica_amministrazione'], scrittura: [...F], ordine: 't.codice' },
  { tabella: 'anagrafica', colonne: ['codice', 'tipo', 'denominazione', 'cognome', 'nome', 'codice_fiscale', 'partita_iva', 'codice_destinatario', 'codice_ipa', 'categoria_id', 'telefono', 'email', 'pec',
      'ind_via', 'ind_civico', 'ind_cap', 'ind_comune', 'ind_prov', 'rec_presso', 'rec_via', 'rec_civico', 'rec_cap', 'rec_comune', 'rec_prov', 'note'],
    ricerca: ['codice', 'denominazione', 'codice_fiscale', 'partita_iva'], filtri: ['tipo', 'categoria_id'], scrittura: [...S] },
  { tabella: 'domiciliazione', colonne: ['anagrafica_id', 'iban', 'intestatario', 'mandato_sepa', 'data_mandato', 'valido_dal', 'valido_al', 'attivo'], filtri: ['anagrafica_id'], scrittura: [...S, ...A] },
  { tabella: 'comune', colonne: ['codice_istat', 'nome', 'provincia', 'zona_montana', 'altitudine'], ricerca: ['nome', 'codice_istat'], scrittura: [...F], ordine: 't.nome' },
  { tabella: 'coefficiente_c', colonne: ['comune_id', 'valido_dal', 'valore'], filtri: ['comune_id'], scrittura: [...F], ordine: 't.comune_id, t.valido_dal DESC',
    select: `SELECT t.*, c.nome AS comune FROM coefficiente_c t JOIN comune c ON c.id=t.comune_id` },
  { tabella: 'parametro', colonne: ['codice', 'valido_dal', 'valore', 'note'], filtri: ['codice'], ricerca: ['codice'], scrittura: [...F], ordine: 't.codice, t.valido_dal DESC', elimina: true },
  { tabella: 'tariffa', colonne: ['servizio', 'codice', 'descrizione'], filtri: ['servizio'], scrittura: [...F], ordine: 't.codice' },
  { tabella: 'ciclo_fatturazione', colonne: ['servizio', 'codice', 'descrizione', 'mesi_periodo'], filtri: ['servizio'], scrittura: [...F], ordine: 't.servizio, t.codice' },
  { tabella: 'fornitura', colonne: ['codice', 'servizio', 'anagrafica_id', 'stato', 'tariffa_id', 'ciclo_id', 'comune_id', 'ind_via', 'ind_civico', 'ind_cap', 'ind_scala_interno', 'uso', 'iva_pct', 'portata_kw',
      'potenza_impianto_kw', 'pod_pdr', 'data_attivazione', 'data_cessazione', 'giorni_scadenza', 'note_bolletta'],
    ricerca: ['codice', 'ind_via', 'pod_pdr', 'denominazione'], filtri: ['servizio', 'stato', 'anagrafica_id', 'ciclo_id'], scrittura: [...S],
    select: `SELECT t.*, a.denominazione, a.codice AS cod_anagrafica, c.nome AS comune FROM fornitura t JOIN anagrafica a ON a.id=t.anagrafica_id LEFT JOIN comune c ON c.id=t.comune_id` },
  { tabella: 'contatore', colonne: ['fornitura_id', 'matricola', 'um_lettura', 'cifre', 'padre_id', 'fatturabile', 'lettura_iniziale', 'data_lettura_iniziale', 'attivo'], filtri: ['fornitura_id', 'padre_id'], ricerca: ['matricola'], scrittura: [...T, ...F] },
  { tabella: 'contratto', colonne: ['fornitura_id', 'anagrafica_id', 'numero', 'tipo', 'data_evento', 'data_firma', 'stato', 'anagrafica_precedente_id', 'lettura_evento', 'note'], filtri: ['fornitura_id', 'anagrafica_id', 'tipo', 'stato'], scrittura: [...S] },
  { tabella: 'lettura', colonne: ['contatore_id', 'data_lettura', 'valore', 'tipo', 'origine', 'note', 'annullata'], filtri: ['contatore_id', 'tipo', 'anomalia'], scrittura: [...F, ...T],
    ordine: 't.data_lettura DESC, t.id DESC', select: `SELECT t.*, k.matricola, k.fornitura_id FROM lettura t JOIN contatore k ON k.id=t.contatore_id` },
  { tabella: 'partita', colonne: ['anagrafica_id', 'fornitura_id', 'tipo', 'descrizione', 'imponibile', 'iva_pct', 'fuori_campo_iva', 'lotto'], filtri: ['anagrafica_id', 'fornitura_id', 'lotto'], scrittura: [...F, ...S], elimina: true },
  { tabella: 'listino', colonne: ['servizio', 'codice', 'descrizione', 'um', 'prezzo', 'iva_pct', 'attivo'], ricerca: ['codice', 'descrizione'], scrittura: [...F], ordine: 't.codice' },
  { tabella: 'odi', colonne: ['servizio', 'tipo', 'fornitura_id', 'anagrafica_id', 'stato', 'aperto_il', 'pianificato_il', 'chiuso_il', 'assegnato_a', 'descrizione', 'esito', 'rendiconto', 'lettura_chiusura'], filtri: ['servizio', 'stato', 'tipo', 'fornitura_id'], scrittura: [...T] },
  { tabella: 'pratica', colonne: ['servizio', 'anagrafica_id', 'fornitura_id', 'tipo', 'stato', 'descrizione', 'aperta_il', 'chiusa_il'], filtri: ['servizio', 'stato'], scrittura: [...S] },
  { tabella: 'mazzetta', colonne: ['data', 'canale', 'descrizione', 'stato', 'totale_dichiarato'], scrittura: [...A] },
  { tabella: 'incasso', colonne: ['data_valuta', 'importo', 'canale', 'riferimento', 'anagrafica_id', 'mazzetta_id', 'stato'], filtri: ['stato', 'canale', 'mazzetta_id', 'anagrafica_id'], ricerca: ['riferimento'], scrittura: [...A], ordine: 't.data_valuta DESC, t.id DESC' },
  { tabella: 'bonus_sociale', colonne: ['fornitura_id', 'codice_fiscale', 'valido_dal', 'valido_al', 'importo_totale', 'protocollo', 'stato', 'note'], filtri: ['fornitura_id', 'stato'], scrittura: [...S, ...F] },
  { tabella: 'piano_conti', colonne: ['servizio', 'chiave', 'conto_sap', 'descrizione'], scrittura: [...A], ordine: 't.servizio, t.chiave' },
  { tabella: 'impostazione', colonne: ['chiave', 'valore'], scrittura: [] },
  { tabella: 'sollecito', colonne: [], filtri: ['anagrafica_id'], ordine: 't.data DESC' },
];

export function registraRisorse(app: FastifyInstance) {
  for (const r of risorse) if (r.tabella !== 'impostazione') crud(app, r);

  // impostazioni: chiave testuale come PK
  app.get('/api/impostazione', async () => (await pool.query('SELECT * FROM impostazione ORDER BY chiave')).rows);
  app.put('/api/impostazione/:chiave', { preHandler: async (req, rep) => { if ((req.user as any).ruolo !== 'admin') return rep.code(403).send({ errore: 'Solo admin' }); } }, async req => {
    const { chiave } = req.params as { chiave: string };
    await pool.query(`INSERT INTO impostazione(chiave,valore) VALUES ($1,$2) ON CONFLICT (chiave) DO UPDATE SET valore=EXCLUDED.valore`, [chiave, JSON.stringify((req.body as any).valore)]);
    return { ok: true };
  });

  // versioni di tariffa con validazione dello schema regole
  app.get('/api/tariffa/:id/versioni', async req => (await pool.query('SELECT * FROM tariffa_versione WHERE tariffa_id=$1 ORDER BY valido_dal DESC', [(req.params as any).id])).rows);
  app.post('/api/tariffa/:id/versioni', { preHandler: async (req, rep) => { if (!['admin', 'fatturazione'].includes((req.user as any).ruolo)) return rep.code(403).send({ errore: 'Permesso negato' }); } }, async (req, rep) => {
    const { valido_dal, regole } = req.body as { valido_dal: string; regole: unknown };
    const { rows: [t] } = await pool.query('SELECT servizio FROM tariffa WHERE id=$1', [(req.params as any).id]);
    const p = RegoleSchema.safeParse(regole);
    if (!p.success) return rep.code(400).send({ errore: 'Regole non valide', dettagli: p.error.issues });
    if (p.data.servizio !== t.servizio) return rep.code(400).send({ errore: 'Le regole non corrispondono al servizio della tariffa' });
    return (await pool.query(
      `INSERT INTO tariffa_versione(tariffa_id,valido_dal,regole) VALUES ($1,$2,$3) ON CONFLICT (tariffa_id,valido_dal) DO UPDATE SET regole=EXCLUDED.regole RETURNING *`,
      [(req.params as any).id, valido_dal, JSON.stringify(p.data)])).rows[0];
  });

  // utenti (solo admin)
  const admin = async (req: any, rep: any) => { if (req.user.ruolo !== 'admin') return rep.code(403).send({ errore: 'Solo admin' }); };
  app.get('/api/utenti', { preHandler: admin }, async () => (await pool.query('SELECT id, username, ruolo, attivo FROM utente ORDER BY username')).rows);
  app.post('/api/utenti', { preHandler: admin }, async req => {
    const { username, password, ruolo } = req.body as any;
    return (await pool.query('INSERT INTO utente(username,password_hash,ruolo) VALUES ($1,$2,$3) RETURNING id, username, ruolo', [username, hashPassword(password), ruolo])).rows[0];
  });

  // audit / storico variazioni di una riga
  app.get('/api/storico/:tabella/:id', async req => {
    const { tabella, id } = req.params as any;
    return (await pool.query('SELECT * FROM audit_log WHERE tabella=$1 AND riga_id=$2 ORDER BY quando DESC', [tabella, id])).rows;
  });
}
