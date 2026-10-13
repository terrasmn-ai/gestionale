-- Gestionale TLR + GPL — schema iniziale (PostgreSQL 14+)
-- Un'unica base dati per istanza; il campo `servizio` separa TLR e GPL.
CREATE TYPE servizio AS ENUM ('TLR','GPL');

-- ============ Utenti e audit ============
CREATE TABLE utente (
  id serial PRIMARY KEY,
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  ruolo text NOT NULL DEFAULT 'sportello' CHECK (ruolo IN ('admin','sportello','fatturazione','amministrazione','tecnico')),
  attivo boolean NOT NULL DEFAULT true
);

-- Storicizzazione variazioni: ogni UPDATE/DELETE sulle tabelle marcate conserva la riga precedente
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  tabella text NOT NULL,
  riga_id text,
  azione text NOT NULL,
  prima jsonb,
  dopo jsonb,
  quando timestamptz NOT NULL DEFAULT now(),
  utente text
);
CREATE INDEX ON audit_log (tabella, riga_id);
CREATE FUNCTION audit_trg() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log(tabella, riga_id, azione, prima, dopo, utente)
  VALUES (TG_TABLE_NAME,
          COALESCE((CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)->>'id',''),
          TG_OP,
          CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,
          current_setting('app.utente', true));
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

-- ============ Anagrafiche ============
CREATE TABLE categoria_cliente (
  id serial PRIMARY KEY,
  codice text UNIQUE NOT NULL,
  descrizione text NOT NULL,
  giorni_scadenza int NOT NULL DEFAULT 20,      -- privati 20, PA 30/90
  esente_mora boolean NOT NULL DEFAULT false,   -- es. enti pubblici
  pubblica_amministrazione boolean NOT NULL DEFAULT false -- split payment / codice IPA
);

CREATE TABLE anagrafica (
  id serial PRIMARY KEY,
  codice text UNIQUE NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('privato','azienda','condominio','ente_pubblico')),
  denominazione text NOT NULL,
  cognome text, nome text,
  codice_fiscale text, partita_iva text, codice_destinatario text, codice_ipa text,
  categoria_id int NOT NULL REFERENCES categoria_cliente(id),
  telefono text, email text, pec text,
  ind_via text, ind_civico text, ind_cap text, ind_comune text, ind_prov text,        -- fatturazione
  rec_presso text, rec_via text, rec_civico text, rec_cap text, rec_comune text, rec_prov text, -- recapito
  note text,
  creato_il timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON anagrafica (denominazione);
CREATE INDEX ON anagrafica (codice_fiscale);

CREATE TABLE domiciliazione (
  id serial PRIMARY KEY,
  anagrafica_id int NOT NULL REFERENCES anagrafica(id),
  iban text NOT NULL,
  intestatario text,
  mandato_sepa text, data_mandato date,
  valido_dal date NOT NULL DEFAULT current_date,
  valido_al date,
  attivo boolean NOT NULL DEFAULT true
);

-- ============ Territorio / parametri ============
CREATE TABLE comune (
  id serial PRIMARY KEY,
  codice_istat text UNIQUE NOT NULL,
  nome text NOT NULL,
  provincia text,
  zona_montana boolean NOT NULL DEFAULT false,
  altitudine int
);
-- Coefficiente C (GPL) per comune, con storico di validità
CREATE TABLE coefficiente_c (
  id serial PRIMARY KEY,
  comune_id int NOT NULL REFERENCES comune(id),
  valido_dal date NOT NULL,
  valore numeric(8,5) NOT NULL,
  UNIQUE (comune_id, valido_dal)
);
-- Parametri a validità temporale: tasso BCE, interesse legale, accisa, sconto montano, kg/Smc, crediti d'imposta...
CREATE TABLE parametro (
  id serial PRIMARY KEY,
  codice text NOT NULL,
  valido_dal date NOT NULL,
  valore numeric(14,6) NOT NULL,
  note text,
  UNIQUE (codice, valido_dal)
);

-- ============ Tariffe (regole configurabili dall'utente, versionate) ============
CREATE TABLE tariffa (
  id serial PRIMARY KEY,
  servizio servizio NOT NULL,
  codice text UNIQUE NOT NULL,
  descrizione text NOT NULL
);
-- `regole` è un JSON validato lato server (vedi engine/types.ts)
CREATE TABLE tariffa_versione (
  id serial PRIMARY KEY,
  tariffa_id int NOT NULL REFERENCES tariffa(id),
  valido_dal date NOT NULL,
  regole jsonb NOT NULL,
  UNIQUE (tariffa_id, valido_dal)
);

CREATE TABLE ciclo_fatturazione (
  id serial PRIMARY KEY,
  servizio servizio NOT NULL,
  codice text NOT NULL,
  descrizione text NOT NULL,
  mesi_periodo int NOT NULL DEFAULT 1,   -- GPL: ciclo 1 mensili (1), ciclo 2 quadrimestrali (4)
  UNIQUE (servizio, codice)
);

-- ============ Forniture / contatori ============
CREATE TABLE fornitura (
  id serial PRIMARY KEY,
  codice text UNIQUE NOT NULL,                 -- codice servizio/utenza univoco
  servizio servizio NOT NULL,
  anagrafica_id int NOT NULL REFERENCES anagrafica(id),
  stato text NOT NULL DEFAULT 'attiva' CHECK (stato IN ('in_attivazione','attiva','sospesa','cessata')),
  tariffa_id int NOT NULL REFERENCES tariffa(id),
  ciclo_id int NOT NULL REFERENCES ciclo_fatturazione(id),
  comune_id int REFERENCES comune(id),
  ind_via text, ind_civico text, ind_cap text, ind_scala_interno text,
  uso text NOT NULL DEFAULT 'domestico',       -- GPL: cottura_acs | riscaldamento | pubblico ; TLR: domestico | altro
  iva_pct numeric(5,2) NOT NULL DEFAULT 10,    -- GPL 10% cottura/ACS, 22% riscaldamento; TLR da configurare
  portata_kw numeric(10,3),                    -- TLR: portata contrattuale -> quota fissa
  potenza_impianto_kw numeric(10,3),           -- TLR: dichiarazione annuale
  pod_pdr text,
  data_attivazione date, data_cessazione date,
  giorni_scadenza int,                         -- override della categoria
  note_bolletta text,
  creato_il timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON fornitura (anagrafica_id);
CREATE INDEX ON fornitura (servizio, stato);

CREATE TABLE contatore (
  id serial PRIMARY KEY,
  fornitura_id int NOT NULL REFERENCES fornitura(id),
  matricola text NOT NULL,
  um_lettura text NOT NULL DEFAULT 'kWh',      -- kWh | mc
  cifre int,                                   -- per gestione giro contatore
  padre_id int REFERENCES contatore(id),       -- TLR: sottostazione figlia di un contatore padre (defalco)
  fatturabile boolean NOT NULL DEFAULT true,   -- il padre defalco NON viene fatturato
  lettura_iniziale numeric(14,3) NOT NULL DEFAULT 0,
  data_lettura_iniziale date,
  attivo boolean NOT NULL DEFAULT true,
  UNIQUE (matricola)
);
CREATE INDEX ON contatore (fornitura_id);
CREATE INDEX ON contatore (padre_id);

-- ============ Contratti ============
CREATE TABLE contratto (
  id serial PRIMARY KEY,
  fornitura_id int NOT NULL REFERENCES fornitura(id),
  anagrafica_id int NOT NULL REFERENCES anagrafica(id),
  numero text,
  tipo text NOT NULL CHECK (tipo IN ('nuovo','voltura','subentro','cessazione','riattivazione','sospensione')),
  data_evento date NOT NULL,
  data_firma date,
  stato text NOT NULL DEFAULT 'bozza' CHECK (stato IN ('bozza','firmato','efficace','annullato')),
  anagrafica_precedente_id int REFERENCES anagrafica(id),
  lettura_evento numeric(14,3),
  note text,
  creato_il timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON contratto (fornitura_id, data_evento);

-- ============ Letture ============
CREATE TABLE lettura (
  id bigserial PRIMARY KEY,
  contatore_id int NOT NULL REFERENCES contatore(id),
  data_lettura date NOT NULL,
  valore numeric(14,3) NOT NULL,
  tipo text NOT NULL DEFAULT 'effettiva' CHECK (tipo IN ('effettiva','intermedia','stimata','autolettura','rettifica')),
  origine text NOT NULL DEFAULT 'manuale',      -- manuale | import | telelettura
  anomalia text,
  note text,
  documento_id int,                              -- valorizzato quando fatturata
  annullata boolean NOT NULL DEFAULT false,
  creato_il timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON lettura (contatore_id, data_lettura);

-- ============ Documenti ============
CREATE TABLE fatturazione_run (
  id serial PRIMARY KEY,
  servizio servizio NOT NULL,
  ciclo_id int REFERENCES ciclo_fatturazione(id),
  data_documento date NOT NULL,
  data_fino date NOT NULL,                       -- letture considerate fino a questa data
  stato text NOT NULL DEFAULT 'prova' CHECK (stato IN ('prova','effettivo','annullato')),
  n_documenti int NOT NULL DEFAULT 0,
  totale numeric(14,2) NOT NULL DEFAULT 0,
  anomalie jsonb NOT NULL DEFAULT '[]',
  creato_il timestamptz NOT NULL DEFAULT now(),
  confermato_il timestamptz
);

CREATE TABLE documento (
  id serial PRIMARY KEY,
  run_id int REFERENCES fatturazione_run(id),
  servizio servizio NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('fattura','nota_credito','fattura_acconto','fattura_preventivo')),
  stato text NOT NULL DEFAULT 'prova' CHECK (stato IN ('prova','emesso','annullato')),
  anno int, numero int,                          -- assegnati all'emissione
  sezionale text NOT NULL DEFAULT 'A',
  data_documento date NOT NULL,
  anagrafica_id int NOT NULL REFERENCES anagrafica(id),
  fornitura_id int REFERENCES fornitura(id),
  periodo_da date, periodo_a date,
  scadenza date,
  imponibile numeric(14,2) NOT NULL DEFAULT 0,
  iva numeric(14,2) NOT NULL DEFAULT 0,
  totale numeric(14,2) NOT NULL DEFAULT 0,
  fuori_campo_iva numeric(14,2) NOT NULL DEFAULT 0,
  note text,
  insoluti_esposti jsonb,                        -- importi insoluti segnalati in bolletta
  documento_origine_id int REFERENCES documento(id), -- per note di credito
  preventivo_id int,
  sdi_stato text DEFAULT 'da_inviare',
  creato_il timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX documento_numero_uq ON documento (servizio, sezionale, anno, numero) WHERE numero IS NOT NULL;
CREATE INDEX ON documento (anagrafica_id);
CREATE INDEX ON documento (fornitura_id);
CREATE INDEX ON documento (stato, scadenza);
ALTER TABLE lettura ADD FOREIGN KEY (documento_id) REFERENCES documento(id) ON DELETE SET NULL;

CREATE TABLE documento_riga (
  id bigserial PRIMARY KEY,
  documento_id int NOT NULL REFERENCES documento(id) ON DELETE CASCADE,
  ordine int NOT NULL DEFAULT 0,
  tipo_riga text NOT NULL,   -- consumo|quota_fissa|accisa|sconto_zone_montane|credito_imposta|bonus_sociale|acconto|scomputo_acconto|mora|addebito|accredito|preventivo|nota
  descrizione text NOT NULL,
  quantita numeric(14,3), um text, prezzo numeric(14,6),
  imponibile numeric(14,2) NOT NULL,
  iva_pct numeric(5,2) NOT NULL DEFAULT 0,
  iva numeric(14,2) NOT NULL DEFAULT 0,
  fuori_campo_iva boolean NOT NULL DEFAULT false,
  competenza_da date, competenza_a date,
  dettaglio jsonb
);
CREATE INDEX ON documento_riga (documento_id);
CREATE INDEX ON documento_riga (tipo_riga);

-- Ripartizione defalco padre/figli (report di verifica)
CREATE TABLE defalco_ripartizione (
  id bigserial PRIMARY KEY,
  run_id int NOT NULL REFERENCES fatturazione_run(id) ON DELETE CASCADE,
  contatore_padre_id int NOT NULL REFERENCES contatore(id),
  contatore_figlio_id int NOT NULL REFERENCES contatore(id),
  consumo_padre numeric(14,3) NOT NULL,
  consumo_figli_tot numeric(14,3) NOT NULL,
  differenza numeric(14,3) NOT NULL,
  consumo_proprio numeric(14,3) NOT NULL,
  quota_ripartita numeric(14,3) NOT NULL,
  consumo_fatturato numeric(14,3) NOT NULL
);

-- Partite manuali di addebito/accredito (anche massive: es. assicurazione)
CREATE TABLE partita (
  id serial PRIMARY KEY,
  anagrafica_id int NOT NULL REFERENCES anagrafica(id),
  fornitura_id int REFERENCES fornitura(id),
  tipo text NOT NULL CHECK (tipo IN ('addebito','accredito')),
  descrizione text NOT NULL,
  imponibile numeric(14,2) NOT NULL,
  iva_pct numeric(5,2) NOT NULL DEFAULT 22,
  fuori_campo_iva boolean NOT NULL DEFAULT false,
  lotto text,
  documento_id int REFERENCES documento(id),
  creato_il timestamptz NOT NULL DEFAULT now()
);

-- ============ Preventivi ============
CREATE TABLE listino (
  id serial PRIMARY KEY,
  servizio servizio,
  codice text UNIQUE NOT NULL,
  descrizione text NOT NULL,
  um text DEFAULT 'nr',
  prezzo numeric(14,4) NOT NULL,
  iva_pct numeric(5,2) NOT NULL DEFAULT 22,
  attivo boolean NOT NULL DEFAULT true
);
CREATE TABLE preventivo (
  id serial PRIMARY KEY,
  numero text, anno int,
  servizio servizio NOT NULL,
  anagrafica_id int NOT NULL REFERENCES anagrafica(id),
  fornitura_id int REFERENCES fornitura(id),
  data date NOT NULL DEFAULT current_date,
  stato text NOT NULL DEFAULT 'bozza' CHECK (stato IN ('bozza','emesso','approvato','rifiutato','fatturato')),
  note text,
  documento_id int REFERENCES documento(id)
);
CREATE TABLE preventivo_riga (
  id serial PRIMARY KEY,
  preventivo_id int NOT NULL REFERENCES preventivo(id) ON DELETE CASCADE,
  listino_id int REFERENCES listino(id),
  descrizione text NOT NULL,
  quantita numeric(14,3) NOT NULL DEFAULT 1,
  prezzo numeric(14,4) NOT NULL,
  iva_pct numeric(5,2) NOT NULL DEFAULT 22
);
ALTER TABLE documento ADD FOREIGN KEY (preventivo_id) REFERENCES preventivo(id);

-- ============ Tecnico / sportello ============
CREATE TABLE odi (
  id serial PRIMARY KEY,
  servizio servizio NOT NULL,
  tipo text NOT NULL,   -- sopralluogo|allaccio|attivazione|disattivazione|sostituzione_contatore|chiusura_morosita|riapertura|manutenzione|altro
  fornitura_id int REFERENCES fornitura(id),
  anagrafica_id int REFERENCES anagrafica(id),
  stato text NOT NULL DEFAULT 'aperto' CHECK (stato IN ('aperto','pianificato','in_corso','chiuso','annullato')),
  aperto_il date NOT NULL DEFAULT current_date,
  pianificato_il date, chiuso_il date,
  assegnato_a text,
  descrizione text, esito text, rendiconto text,
  lettura_chiusura numeric(14,3)
);
CREATE INDEX ON odi (stato, tipo);
CREATE TABLE pratica (
  id serial PRIMARY KEY,
  servizio servizio NOT NULL,
  anagrafica_id int REFERENCES anagrafica(id),
  fornitura_id int REFERENCES fornitura(id),
  tipo text NOT NULL,
  stato text NOT NULL DEFAULT 'aperta' CHECK (stato IN ('aperta','in_lavorazione','chiusa')),
  descrizione text,
  aperta_il date NOT NULL DEFAULT current_date,
  chiusa_il date
);

-- ============ Incassi / crediti ============
CREATE TABLE mazzetta (
  id serial PRIMARY KEY,
  data date NOT NULL,
  canale text NOT NULL,
  descrizione text,
  stato text NOT NULL DEFAULT 'aperta' CHECK (stato IN ('aperta','verificata','contabilizzata')),
  totale_dichiarato numeric(14,2)
);
CREATE TABLE incasso (
  id serial PRIMARY KEY,
  data_valuta date NOT NULL,
  importo numeric(14,2) NOT NULL,
  canale text NOT NULL CHECK (canale IN ('bonifico','sepa','postale','pagopa','contanti','altro')),
  riferimento text,                 -- causale / n. bolletta
  anagrafica_id int REFERENCES anagrafica(id),
  mazzetta_id int REFERENCES mazzetta(id),
  origine text DEFAULT 'manuale',
  stato text NOT NULL DEFAULT 'da_abbinare' CHECK (stato IN ('da_abbinare','abbinato','parziale','stornato')),
  sap_batch_id int,
  creato_il timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE incasso_alloc (
  id serial PRIMARY KEY,
  incasso_id int NOT NULL REFERENCES incasso(id) ON DELETE CASCADE,
  documento_id int NOT NULL REFERENCES documento(id),
  importo numeric(14,2) NOT NULL
);
CREATE INDEX ON incasso_alloc (documento_id);
CREATE TABLE sollecito (
  id serial PRIMARY KEY,
  anagrafica_id int NOT NULL REFERENCES anagrafica(id),
  livello int NOT NULL DEFAULT 1,
  data date NOT NULL DEFAULT current_date,
  canale text DEFAULT 'lettera',
  documenti jsonb NOT NULL,        -- elenco documenti insoluti oggetto del sollecito
  totale numeric(14,2) NOT NULL,
  testo text
);

-- ============ TLR: bonus sociale e crediti ============
CREATE TABLE bonus_flusso (
  id serial PRIMARY KEY,
  nome_file text, caricato_il timestamptz NOT NULL DEFAULT now(),
  righe_totali int, righe_ok int, righe_scartate int, scarti jsonb
);
CREATE TABLE bonus_sociale (
  id serial PRIMARY KEY,
  fornitura_id int NOT NULL REFERENCES fornitura(id),
  flusso_id int REFERENCES bonus_flusso(id),
  codice_fiscale text,
  valido_dal date NOT NULL,
  valido_al date NOT NULL,
  importo_totale numeric(12,2) NOT NULL,   -- importo riconosciuto per il periodo di validità, ripartito pro-rata giorni
  protocollo text,
  stato text NOT NULL DEFAULT 'valido' CHECK (stato IN ('valido','revocato')),
  note text
);
CREATE INDEX ON bonus_sociale (fornitura_id, valido_dal);

-- ============ Contabilità / SAP ============
CREATE TABLE piano_conti (
  id serial PRIMARY KEY,
  servizio servizio,
  chiave text NOT NULL,          -- tipo_riga (consumo, quota_fissa...), 'iva', 'cliente', 'incasso:<canale>'
  conto_sap text NOT NULL,
  descrizione text,
  UNIQUE (servizio, chiave)
);
CREATE TABLE contabilizzazione (
  id serial PRIMARY KEY,
  tipo text NOT NULL CHECK (tipo IN ('emesso','incassi')),
  servizio servizio, da date, a date,
  creato_il timestamptz NOT NULL DEFAULT now(),
  n_movimenti int, totale numeric(14,2)
);
ALTER TABLE documento ADD COLUMN contabilizzazione_id int REFERENCES contabilizzazione(id);
ALTER TABLE incasso ADD FOREIGN KEY (sap_batch_id) REFERENCES contabilizzazione(id);

-- ============ Audit su tabelle principali ============
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['anagrafica','domiciliazione','fornitura','contatore','contratto','lettura','tariffa_versione','parametro','partita','bonus_sociale','incasso','odi']
  LOOP EXECUTE format('CREATE TRIGGER audit_%I AFTER UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_trg()', t, t); END LOOP;
END $$;
