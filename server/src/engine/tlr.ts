import { RegoleTlr, Riga, r2, r3 } from './types.js';
import { mesiPeriodo, ParametroLookup } from './common.js';

export interface TlrInput {
  regole: RegoleTlr;
  periodo_da: string; periodo_a: string;
  consumo_kwh: number;
  /** kWh già fatturati nell'anno solare (per scaglioni 'annuo') */
  consumo_anno_precedente: number;
  portata_kw: number;
  iva_pct: number;
  param: ParametroLookup;
  bonus?: { importo_totale: number; valido_dal: string; valido_al: string }[];
}

/** Applica scaglioni progressivi a `kwh`, partendo da `gia` kWh già consumati. */
export function applicaScaglioni(scaglioni: RegoleTlr['scaglioni'], kwh: number, gia: number) {
  const out: { da: number; a: number; kwh: number; prezzo: number; importo: number }[] = [];
  let lower = 0, rimanente = kwh, pos = gia;
  for (const s of scaglioni) {
    const upper = s.fino_a ?? Infinity;
    if (pos < upper && rimanente > 0) {
      const start = Math.max(pos, lower);
      const q = Math.min(rimanente, upper - start);
      if (q > 0) { out.push({ da: start, a: start + q, kwh: r3(q), prezzo: s.prezzo, importo: r2(q * s.prezzo) }); rimanente -= q; pos += q; }
    }
    lower = upper;
  }
  return out;
}

export function quotaFissaMensile(q: RegoleTlr['quota_fissa'], portata: number): number {
  const sorted = [...q].sort((a, b) => (a.portata_fino_a_kw ?? Infinity) - (b.portata_fino_a_kw ?? Infinity));
  const hit = sorted.find(x => x.portata_fino_a_kw === null || portata <= x.portata_fino_a_kw);
  return (hit ?? sorted[sorted.length - 1]).importo_mese;
}

export function calcolaTlr(i: TlrInput): Riga[] {
  const righe: Riga[] = [];
  const base = i.regole.scaglioni_base === 'annuo' ? i.consumo_anno_precedente : 0;
  const rip = applicaScaglioni(i.regole.scaglioni, i.consumo_kwh, base);
  for (const s of rip) {
    righe.push({
      tipo_riga: 'consumo', descrizione: `Consumo teleriscaldamento kWh ${s.da.toFixed(0)}–${s.a.toFixed(0)}`,
      quantita: s.kwh, um: 'kWh', prezzo: s.prezzo, imponibile: s.importo, iva_pct: i.iva_pct,
      competenza_da: i.periodo_da, competenza_a: i.periodo_a,
    });
  }
  const mesi = mesiPeriodo(i.periodo_da, i.periodo_a);
  const qf = quotaFissaMensile(i.regole.quota_fissa, i.portata_kw);
  if (mesi > 0 && qf > 0) {
    righe.push({
      tipo_riga: 'quota_fissa', descrizione: `Quota fissa potenza ${i.portata_kw} kW (${mesi} mesi)`,
      quantita: mesi, um: 'mese', prezzo: qf, imponibile: r2(mesi * qf), iva_pct: i.iva_pct,
      competenza_da: i.periodo_da, competenza_a: i.periodo_a, dettaglio: { portata_kw: i.portata_kw },
    });
  }
  // Crediti d'imposta (due algoritmi): €/kWh fatturati, valore negativo in fattura
  for (const c of i.regole.crediti_imposta) {
    const rate = i.param(c.codice_parametro, i.periodo_a);
    if (rate && i.consumo_kwh > 0) {
      righe.push({
        tipo_riga: 'credito_imposta', descrizione: c.descrizione, quantita: i.consumo_kwh, um: 'kWh', prezzo: -rate,
        imponibile: -r2(i.consumo_kwh * rate), iva_pct: i.iva_pct, competenza_da: i.periodo_da, competenza_a: i.periodo_a,
        dettaglio: { codice_parametro: c.codice_parametro, rate },
      });
    }
  }
  // Bonus sociale (dal 2027): importo riconosciuto ripartito pro-rata sui giorni di sovrapposizione col periodo
  for (const b of i.bonus ?? []) {
    const da = b.valido_dal > i.periodo_da ? b.valido_dal : i.periodo_da;
    const a = b.valido_al < i.periodo_a ? b.valido_al : i.periodo_a;
    if (a < da) continue;
    const gg = (new Date(a).getTime() - new Date(da).getTime()) / 86400000 + 1;
    const ggTot = (new Date(b.valido_al).getTime() - new Date(b.valido_dal).getTime()) / 86400000 + 1;
    righe.push({
      tipo_riga: 'bonus_sociale', descrizione: `Bonus sociale teleriscaldamento (${da} – ${a})`,
      imponibile: -r2(b.importo_totale * gg / ggTot), iva_pct: i.iva_pct, competenza_da: da, competenza_a: a,
      dettaglio: { importo_totale: b.importo_totale, giorni: gg, giorni_totali: ggTot },
    });
  }
  return righe;
}

// ---------- Defalco padre / figli ----------
export interface DefalcoFiglio { contatore_id: number; consumo: number }
export interface DefalcoRisultato {
  differenza: number;
  anomalia?: string;
  figli: { contatore_id: number; consumo_proprio: number; quota_ripartita: number; consumo_fatturato: number }[];
}
/**
 * Differenza (padre − Σ figli) ripartita ai figli in proporzione ai loro consumi.
 * Il padre non viene fatturato. Se la differenza è negativa (figli > padre) non si ripartisce nulla e si segnala l'anomalia.
 */
export function calcolaDefalco(consumoPadre: number, figli: DefalcoFiglio[]): DefalcoRisultato {
  const tot = figli.reduce((s, f) => s + f.consumo, 0);
  const diff = r3(consumoPadre - tot);
  let anomalia: string | undefined;
  if (diff < 0) anomalia = 'Somma consumi figli superiore al padre';
  else if (tot === 0 && diff > 0) anomalia = 'Consumi figli nulli: differenza non ripartibile';
  const rip = diff > 0 && tot > 0 ? diff : 0;
  const out = figli.map(f => ({ contatore_id: f.contatore_id, consumo_proprio: f.consumo, quota_ripartita: r3(rip * f.consumo / (tot || 1)), consumo_fatturato: 0 }));
  // assegna il resto di arrotondamento all'ultimo figlio con consumo > 0 in modo che Σ quote = differenza
  if (rip > 0) {
    const resto = r3(rip - out.reduce((s, x) => s + x.quota_ripartita, 0));
    const idx = [...out].reverse().findIndex(x => x.consumo_proprio > 0);
    if (idx >= 0) out[out.length - 1 - idx].quota_ripartita = r3(out[out.length - 1 - idx].quota_ripartita + resto);
  }
  for (const x of out) x.consumo_fatturato = r3(x.consumo_proprio + x.quota_ripartita);
  return { differenza: diff, anomalia, figli: out };
}
