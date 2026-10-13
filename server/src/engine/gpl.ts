import { RegoleGpl, Riga, r2, r3 } from './types.js';
import { mesiPeriodo, ParametroLookup } from './common.js';

export const mcToSmc = (mc: number, c: number) => r3(mc * c);

export interface GplInput {
  regole: RegoleGpl;
  periodo_da: string; periodo_a: string;
  consumo_mc: number;
  coeff_c: number;
  zona_montana: boolean;
  iva_pct: number;                 // 10% cottura/ACS, 22% riscaldamento (dato in fornitura)
  param: ParametroLookup;
}

export function calcolaGpl(i: GplInput): Riga[] {
  const smc = mcToSmc(i.consumo_mc, i.coeff_c);
  const righe: Riga[] = [];
  const comp = { competenza_da: i.periodo_da, competenza_a: i.periodo_a };
  righe.push({
    tipo_riga: 'consumo', descrizione: `Consumo GPL ${i.consumo_mc} mc × C ${i.coeff_c} = ${smc} Smc`,
    quantita: smc, um: 'Smc', prezzo: i.regole.prezzo_smc, imponibile: r2(smc * i.regole.prezzo_smc), iva_pct: i.iva_pct, ...comp,
    dettaglio: { mc: i.consumo_mc, coeff_c: i.coeff_c },
  });
  const mesi = mesiPeriodo(i.periodo_da, i.periodo_a);
  if (mesi > 0 && i.regole.quota_fissa_mese > 0) {
    righe.push({
      tipo_riga: 'quota_fissa', descrizione: `Quota fissa mensile (${mesi} mesi)`, quantita: mesi, um: 'mese',
      prezzo: i.regole.quota_fissa_mese, imponibile: r2(mesi * i.regole.quota_fissa_mese), iva_pct: i.iva_pct, ...comp,
    });
  }
  // Accisa: valore unitario definito dall'Agenzia × Smc fatturati
  const accisa = i.param(i.regole.parametro_accisa, i.periodo_a);
  if (accisa && smc > 0) {
    righe.push({
      tipo_riga: 'accisa', descrizione: 'Accisa', quantita: smc, um: 'Smc', prezzo: accisa,
      imponibile: r2(smc * accisa), iva_pct: i.iva_pct, ...comp, dettaglio: { parametro: i.regole.parametro_accisa },
    });
  }
  // Sconto zone montane: valore base × Smc, fuori campo IVA
  if (i.zona_montana && smc > 0) {
    const sc = i.param(i.regole.parametro_sconto_montano, i.periodo_a);
    if (sc) {
      righe.push({
        tipo_riga: 'sconto_zone_montane', descrizione: 'Sconto zone montane (F.C. IVA)', quantita: smc, um: 'Smc', prezzo: -sc,
        imponibile: -r2(smc * sc), iva_pct: 0, fuori_campo_iva: true, ...comp,
      });
    }
  }
  return righe;
}
