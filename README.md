# Gestionale TLR + GPL

Web app (Node/TypeScript + React) su PostgreSQL. **Un solo codice, istanze separate**: `SERVIZI=TLR`, `SERVIZI=GPL` o `BOTH`
restringono menu e API; le differenze tra i due servizi sono **configurazione** (tariffe, parametri, cicli, categorie), non codice duplicato.
Le specifiche di partenza sono in `docs/`.

## Avvio

```bash
npm install
# PostgreSQL 14+ raggiungibile via DATABASE_URL (default postgres://gest:gest@localhost:5432/gestionale)
npm run build            # frontend
npm -w server run seed   # migrazioni + configurazione base + dati demo (aggiungere -- --no-demo per solo configurazione)
npm -w server start      # http://localhost:3000   utente admin / password admin (variabile ADMIN_PASSWORD)
npm test                 # 15 test del motore + 11 end-to-end su Postgres reale (TEST_DATABASE_URL, db gestionale_test)
```
Sviluppo: `npm run dev:server` e `npm run dev:web` (proxy su :3000). Produzione: `docker compose up` (due istanze + un Postgres; richiede `JWT_SECRET`, `ADMIN_PASSWORD`, `DB_PASSWORD`).

## Cosa copre (dai due documenti)

| Area | Implementato |
|---|---|
| Anagrafiche, utenze | clienti (privato/azienda/condominio/ente), recapiti, forniture multiple, stati, codici univoci, **storico variazioni** (trigger `audit_log`), domiciliazioni SEPA con mandato |
| Contratti | nuovo, voltura, subentro, cessazione, riattivazione, sospensione; «Applica evento» aggiorna la fornitura e registra la lettura di passaggio |
| Tecnico/sportello | ODI (apertura→pianificazione→chiusura→rendiconto), pratiche, sopralluoghi, preventivi da **listino** → approvazione → fattura |
| Letture | inserimento manuale, import massivo CSV (con elenco utenze attive da scaricare), intermedie, rettifica (annullo + audit), giro contatore, anomalie (negativo / elevato / nullo), stima delle mancanti, report letture da fatturare |
| Fatturazione | **prova → effettivo**, massiva per ciclo e puntuale da sportello, note di credito, partite add./accr. anche massive, scadenze per categoria (override per fornitura), insoluti esposti in fattura, note in bolletta, acconti + scomputo, stampa HTML/PDF, **flusso stampatore (STABO)**, **FatturaPA XML**, **SEPA pain.008** |
| TLR | kWh, scaglioni (su periodo o progressivi sull'anno), quota fissa per fascia di portata, **2 crediti d'imposta** su kWh, **bonus sociale** (flusso CSV con verifica CF, pro-rata giorni, rendicontazione), **defalco padre/figli** (differenza ripartita in proporzione, padre non fatturato, report di verifica), mora BCE+3,5% con esenzione per categoria, dichiarazione annuale |
| GPL | mc→Smc con **coefficiente C per comune** (storicizzato), tariffa uso/pubblico (15% incorporato), IVA per fornitura (10%/22%), cicli mensile/quadrimestrale, quota fissa mensile, **accisa** e **sconto zone montane F.C. IVA**, mora (interesse legale + maggiorazione), **accise mensili** (Smc per comune → kg) e **annuali Dogane** (per fornitura) |
| Crediti | import Poste (txt) e banca (csv) con **abbinamento automatico**, abbinamento manuale, mazzette e riepilogo, estratto conto, insoluti, solleciti progressivi, mora su partita |
| Contabilità | piano dei conti parametrico → **file SAP** emesso (con giornale) e incassi/mazzette; marcatura «contabilizzato» |
| Report | elenco fatture, prospetto rendite, consumi/QF per competenza, verifica IVA, giornale IVA, quadratura incassi (tutti anche CSV per Excel) |

Le **regole tariffarie** (scaglioni, quote fisse, crediti d'imposta, prezzi, acconto) sono JSON versionato con data di decorrenza, validato lato server e
modificabile da *Configurazione → Regole tariffarie*: nessuno sviluppo per cambiare un prezzo. Idem i parametri a validità temporale (BCE, accise, sconto montano, kg/Smc, crediti d'imposta).

## Ipotesi da confermare (interpretazioni dei documenti)

1. **Accisa GPL / sconto montano**: accisa = valore unitario × Smc (imponibile IVA); sconto zone montane = valore unitario × Smc, riga negativa **fuori campo IVA** (natura N2.2 in XML). Da verificare con l'ufficio fiscale.
2. **Mora GPL**: «interesse legale + maggiorazione» (componenti configurabili in `impostazione.mora_componenti_GPL`; TLR: BCE + maggiorazione 3,5). Interesse semplice giornaliero su base 365 dalla scadenza; addebitata come partita fuori campo IVA.
3. **Bonus sociale TLR**: il formato del flusso non è noto; ipotizzato CSV (`codice_fiscale;codice_fornitura;valido_dal;valido_al;importo;protocollo`), importo ripartito pro-rata sui giorni del periodo.
4. **Crediti d'imposta** TLR: modellati come €/kWh letti da `parametro`; se l'algoritmo reale è diverso (es. % sul corrispettivo) va cambiata `calcolaTlr` (un solo punto).
5. **Quota fissa** per periodo = mesi tra letture (mesi interi + frazione a 30 gg).
6. **Defalco**: se Σ figli > padre o i figli hanno consumo zero, nulla viene ripartito e viene segnalata un'anomalia nel run.
7. **Valori numerici del seed** (tariffe, accisa, crediti, kg/Smc, conti SAP) sono **segnaposto**.
8. Importi `numeric` a 2 decimali per riga, arrotondamento half-up per riga.

## Da definire con voi (non blocca lo sviluppo, ma serve per andare in esercizio)

- **Struttura del DB attuale**: oggi lo schema è nuovo (`db/migrations`). Con la vostra struttura si scrive una migrazione di import/mappatura.
- Tracciati reali: file **STABO** dello stampatore, **file SAP** (oggi CSV generico), flussi **bancari** (CBI/CAMT) e **Poste**, flusso bonus sociale.
- Dati cedente (P.IVA, IBAN, Creditor ID SEPA) via `PUT /api/impostazione/cedente` (non c'è ancora una pagina UI per le impostazioni); l'XML FatturaPA va validato con l'XSD AdE / il vostro intermediario prima dell'invio.
- **Telematizzazione accise**: oggi si produce il dato (mensile e annuale, CSV); l'invio telematico alle Dogane non è implementato.
- PagoPA, autenticazione aziendale (SSO/LDAP), permessi di dettaglio oltre ai 5 ruoli, migrazione dello storico.
