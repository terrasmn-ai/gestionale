import { r2 } from './types.js';
import { diffDays, ParametroLookup } from './common.js';

/**
 * Mora = interesse semplice giornaliero su importo scaduto.
 * Tasso = somma dei componenti (es. BCE + 3,5 oppure interesse legale + 3,5), letti da `parametro` alla data di scadenza.
 */
export function tassoMora(componenti: string[], data: string, param: ParametroLookup): number {
  return componenti.reduce((s, c) => s + (param(c, data) ?? 0), 0);
}
export function calcolaMora(importoResiduo: number, scadenza: string, alla_data: string, tassoPct: number): number {
  const gg = diffDays(scadenza, alla_data);
  if (gg <= 0 || importoResiduo <= 0) return 0;
  return r2(importoResiduo * (tassoPct / 100) * gg / 365);
}
