import { r2, Riga } from './types.js';

export const parseD = (s: string) => new Date(s + 'T00:00:00Z');
export const fmtD = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => { const d = parseD(s); d.setUTCDate(d.getUTCDate() + n); return fmtD(d); };
export const diffDays = (a: string, b: string) => Math.round((parseD(b).getTime() - parseD(a).getTime()) / 86400000);

/** Mesi (anche frazionari) tra due date, per rapportare la quota fissa mensile al periodo. */
export function mesiPeriodo(da: string, a: string): number {
  const d1 = parseD(da), d2 = parseD(a);
  let mesi = (d2.getUTCFullYear() - d1.getUTCFullYear()) * 12 + (d2.getUTCMonth() - d1.getUTCMonth());
  const giorno = (d: Date) => d.getUTCDate();
  const diff = giorno(d2) - giorno(d1);
  // frazione di mese in giorni commerciali (30)
  const frazione = diff / 30;
  const tot = mesi + frazione;
  return Math.max(0, Math.round(tot * 1000) / 1000);
}

/** Calcolo IVA per riga + totali documento. Le righe fuori campo IVA non generano IVA. */
export function totali(righe: Riga[]) {
  let imponibile = 0, iva = 0, fci = 0;
  const righeIva = righe.map(r => {
    const imp = r2(r.imponibile);
    const ivaR = r.fuori_campo_iva ? 0 : r2(imp * r.iva_pct / 100);
    if (r.fuori_campo_iva) fci += imp; else imponibile += imp;
    iva += ivaR;
    return { ...r, imponibile: imp, iva: ivaR };
  });
  return { righe: righeIva, imponibile: r2(imponibile), iva: r2(iva), fuori_campo_iva: r2(fci), totale: r2(imponibile + iva + fci) };
}

/** Parametro a validità temporale: l'ultimo con valido_dal <= data. */
export type ParametroLookup = (codice: string, data: string) => number | undefined;
export function makeParametroLookup(rows: { codice: string; valido_dal: string; valore: number }[]): ParametroLookup {
  const by = new Map<string, { valido_dal: string; valore: number }[]>();
  for (const r of rows) { (by.get(r.codice) ?? by.set(r.codice, []).get(r.codice)!).push(r); }
  for (const v of by.values()) v.sort((a, b) => a.valido_dal.localeCompare(b.valido_dal));
  return (codice, data) => {
    const v = by.get(codice); if (!v) return undefined;
    let out: number | undefined;
    for (const x of v) if (x.valido_dal <= data) out = x.valore; else break;
    return out;
  };
}
