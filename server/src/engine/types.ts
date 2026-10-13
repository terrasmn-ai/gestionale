import { z } from 'zod';

// ---------- Regole tariffarie (JSON in tariffa_versione.regole) ----------
export const ScaglioneSchema = z.object({ fino_a: z.number().positive().nullable(), prezzo: z.number().nonnegative() });
export const QuotaFissaPortataSchema = z.object({ portata_fino_a_kw: z.number().positive().nullable(), importo_mese: z.number().nonnegative() });

export const RegoleTlrSchema = z.object({
  servizio: z.literal('TLR'),
  /** 'periodo': scaglioni applicati al consumo del periodo; 'annuo': progressivi sull'anno solare */
  scaglioni_base: z.enum(['periodo', 'annuo']).default('periodo'),
  scaglioni: z.array(ScaglioneSchema).min(1),
  quota_fissa: z.array(QuotaFissaPortataSchema).min(1),
  /** codici in `parametro` (€/kWh) dei crediti d'imposta da applicare in fattura (valore negativo in riga) */
  crediti_imposta: z.array(z.object({ codice_parametro: z.string(), descrizione: z.string() })).default([]),
  acconto_pct: z.number().min(0).max(100).default(0),
});

export const RegoleGplSchema = z.object({
  servizio: z.literal('GPL'),
  prezzo_smc: z.number().nonnegative(),
  /** la tariffa uso pubblico ha lo sconto incorporato nel prezzo; qui solo informativo */
  sconto_incluso_pct: z.number().min(0).max(100).default(0),
  quota_fissa_mese: z.number().nonnegative(),
  /** parametri accisa / sconto montano (codici in tabella parametro) */
  parametro_accisa: z.string().default('accisa_gpl_smc'),
  parametro_sconto_montano: z.string().default('sconto_zone_montane_smc'),
  acconto_pct: z.number().min(0).max(100).default(0),
});

export const RegoleSchema = z.discriminatedUnion('servizio', [RegoleTlrSchema, RegoleGplSchema]);
export type RegoleTlr = z.infer<typeof RegoleTlrSchema>;
export type RegoleGpl = z.infer<typeof RegoleGplSchema>;
export type Regole = z.infer<typeof RegoleSchema>;

// ---------- Output del motore ----------
export type TipoRiga =
  | 'consumo' | 'quota_fissa' | 'accisa' | 'sconto_zone_montane' | 'credito_imposta'
  | 'bonus_sociale' | 'acconto' | 'scomputo_acconto' | 'mora' | 'addebito' | 'accredito' | 'preventivo' | 'nota';

export interface Riga {
  tipo_riga: TipoRiga;
  descrizione: string;
  quantita?: number; um?: string; prezzo?: number;
  imponibile: number;
  iva_pct: number;
  fuori_campo_iva?: boolean;
  competenza_da?: string; competenza_a?: string;
  dettaglio?: unknown;
}

export const r2 = (n: number) => Math.round((n + Math.sign(n) * Number.EPSILON) * 100) / 100;
export const r3 = (n: number) => Math.round((n + Math.sign(n) * Number.EPSILON) * 1000) / 1000;
