import { r3 } from './types.js';
import { diffDays } from './common.js';

export interface Lett { id?: number; data: string; valore: number; tipo?: string }

/** Consumo tra due letture, con gestione del giro del contatore (cifre). */
export function consumo(prec: number, att: number, cifre?: number | null): { consumo: number; giro: boolean } {
  if (att >= prec) return { consumo: r3(att - prec), giro: false };
  if (cifre && prec - att > Math.pow(10, cifre) / 2) return { consumo: r3(att + Math.pow(10, cifre) - prec), giro: true };
  return { consumo: r3(att - prec), giro: false }; // negativo -> anomalia
}

export function rilevaAnomalia(cons: number, giorni: number, mediaGiornaliera?: number, sogliaX = 3): string | undefined {
  if (cons < 0) return 'consumo_negativo';
  if (mediaGiornaliera && mediaGiornaliera > 0 && giorni > 0) {
    const atteso = mediaGiornaliera * giorni;
    if (cons > atteso * sogliaX && cons - atteso > 50) return 'consumo_elevato';
    if (cons === 0) return 'consumo_nullo';
  }
  return undefined;
}

/** Stima per lettura mancante: media giornaliera storica × giorni. */
export function stimaConsumo(mediaGiornaliera: number, da: string, a: string): number {
  return r3(mediaGiornaliera * Math.max(0, diffDays(da, a)));
}
