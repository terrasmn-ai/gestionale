ALTER TABLE documento
  ADD COLUMN letture_ids bigint[] NOT NULL DEFAULT '{}',
  ADD COLUMN partite_ids int[] NOT NULL DEFAULT '{}',
  ADD COLUMN dettaglio jsonb,
  ADD COLUMN mora_addebitata numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN stampato_il timestamptz;

CREATE TABLE impostazione (
  chiave text PRIMARY KEY,
  valore jsonb NOT NULL
);
-- Componenti del tasso di mora per servizio (codici in `parametro`):
--  TLR: BCE + 3,5   GPL: interesse legale + maggiorazione (modificabile da UI)
INSERT INTO impostazione(chiave, valore) VALUES
 ('mora_componenti_TLR', '["tasso_bce","maggiorazione_mora"]'),
 ('mora_componenti_GPL', '["interesse_legale","maggiorazione_mora"]'),
 ('giorni_tolleranza_mora', '0'),
 ('soglia_anomalia_consumo_x', '3'),
 ('cedente', '{"denominazione":"","partita_iva":"","codice_fiscale":"","indirizzo":"","cap":"","comune":"","provincia":"","regime_fiscale":"RF01","iban":"","creditor_id_sepa":""}'),
 ('giorni_primo_sollecito', '15');

CREATE VIEW v_documento_residuo AS
-- residuo = totale − incassi allocati − note di credito emesse a storno (importi negativi)
SELECT d.*, d.totale
  - COALESCE((SELECT sum(importo) FROM incasso_alloc a WHERE a.documento_id = d.id), 0)
  + COALESCE((SELECT sum(n.totale) FROM documento n WHERE n.documento_origine_id = d.id AND n.stato='emesso' AND n.tipo='nota_credito'), 0) AS residuo
FROM documento d;
