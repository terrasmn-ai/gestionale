-- Le letture dei contatori non fatturabili (padre del defalco) non hanno un documento:
-- si marcano come "consumate" dal run che le ha usate, così il periodo successivo parte dall'ultima.
ALTER TABLE fatturazione_run ADD COLUMN letture_ids bigint[] NOT NULL DEFAULT '{}';
ALTER TABLE lettura ADD COLUMN run_id int REFERENCES fatturazione_run(id) ON DELETE SET NULL;
