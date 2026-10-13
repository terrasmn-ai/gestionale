import { describe, it, expect } from 'vitest';
import { applicaScaglioni, calcolaDefalco, calcolaTlr, quotaFissaMensile } from '../src/engine/tlr.js';
import { calcolaGpl, mcToSmc } from '../src/engine/gpl.js';
import { calcolaMora, tassoMora } from '../src/engine/mora.js';
import { consumo } from '../src/engine/letture.js';
import { makeParametroLookup, mesiPeriodo, totali } from '../src/engine/common.js';
import { RegoleGplSchema, RegoleTlrSchema } from '../src/engine/types.js';

const param = makeParametroLookup([
  { codice: 'accisa_gpl_smc', valido_dal: '2024-01-01', valore: 0.0 },
  { codice: 'accisa_gpl_smc', valido_dal: '2025-01-01', valore: 0.18 },
  { codice: 'sconto_zone_montane_smc', valido_dal: '2025-01-01', valore: 0.05 },
  { codice: 'ci_1', valido_dal: '2025-01-01', valore: 0.01 },
  { codice: 'ci_2', valido_dal: '2025-01-01', valore: 0.005 },
  { codice: 'bce', valido_dal: '2025-01-01', valore: 2.15 },
  { codice: 'spread', valido_dal: '2025-01-01', valore: 3.5 },
]);

const tlr = RegoleTlrSchema.parse({
  servizio: 'TLR', scaglioni_base: 'annuo',
  scaglioni: [{ fino_a: 10000, prezzo: 0.1 }, { fino_a: null, prezzo: 0.08 }],
  quota_fissa: [{ portata_fino_a_kw: 20, importo_mese: 10 }, { portata_fino_a_kw: 50, importo_mese: 25 }, { portata_fino_a_kw: null, importo_mese: 60 }],
  crediti_imposta: [{ codice_parametro: 'ci_1', descrizione: 'Credito imposta 1' }, { codice_parametro: 'ci_2', descrizione: 'Credito imposta 2' }],
});

describe('TLR', () => {
  it('scaglioni progressivi a cavallo', () => {
    const r = applicaScaglioni(tlr.scaglioni, 4000, 8000);
    expect(r.map(x => [x.kwh, x.prezzo, x.importo])).toEqual([[2000, 0.1, 200], [2000, 0.08, 160]]);
  });
  it('quota fissa per portata', () => {
    expect(quotaFissaMensile(tlr.quota_fissa, 15)).toBe(10);
    expect(quotaFissaMensile(tlr.quota_fissa, 20)).toBe(10);
    expect(quotaFissaMensile(tlr.quota_fissa, 35)).toBe(25);
    expect(quotaFissaMensile(tlr.quota_fissa, 500)).toBe(60);
  });
  it('fattura completa con crediti d\'imposta e bonus', () => {
    const righe = calcolaTlr({ regole: tlr, periodo_da: '2027-01-01', periodo_a: '2027-03-01', consumo_kwh: 3000, consumo_anno_precedente: 0, portata_kw: 30, iva_pct: 10, param,
      bonus: [{ importo_totale: 90, valido_dal: '2027-01-01', valido_al: '2027-03-31' }] });
    const t = totali(righe);
    const by = (k: string) => righe.filter(r => r.tipo_riga === k).reduce((s, r) => s + r.imponibile, 0);
    expect(by('consumo')).toBe(300);
    expect(by('quota_fissa')).toBe(50);           // 2 mesi × 25
    expect(by('credito_imposta')).toBe(-45);      // 3000 × (0.01+0.005)
    expect(by('bonus_sociale')).toBeCloseTo(-60, 0); // 60 giorni / 90 (31+28+31)... pro-rata
    expect(t.totale).toBeCloseTo(t.imponibile * 1.1, 2);
  });
  it('defalco: differenza ripartita ai figli in proporzione', () => {
    const d = calcolaDefalco(1000, [{ contatore_id: 1, consumo: 300 }, { contatore_id: 2, consumo: 100 }]);
    expect(d.differenza).toBe(600);
    expect(d.figli.map(f => f.quota_ripartita)).toEqual([450, 150]);
    expect(d.figli.map(f => f.consumo_fatturato)).toEqual([750, 250]);
    expect(d.figli.reduce((s, f) => s + f.consumo_fatturato, 0)).toBe(1000);
  });
  it('defalco: arrotondamenti non perdono kWh', () => {
    const d = calcolaDefalco(100, [{ contatore_id: 1, consumo: 10 }, { contatore_id: 2, consumo: 10 }, { contatore_id: 3, consumo: 10 }]);
    expect(d.figli.reduce((s, f) => s + f.consumo_fatturato, 0)).toBeCloseTo(100, 3);
  });
  it('defalco: figli > padre → anomalia, nessuna ripartizione', () => {
    const d = calcolaDefalco(100, [{ contatore_id: 1, consumo: 80 }, { contatore_id: 2, consumo: 40 }]);
    expect(d.anomalia).toBeDefined();
    expect(d.figli.map(f => f.quota_ripartita)).toEqual([0, 0]);
  });
});

describe('GPL', () => {
  const g = RegoleGplSchema.parse({ servizio: 'GPL', prezzo_smc: 1.2, quota_fissa_mese: 4 });
  it('mc → Smc con coefficiente C', () => expect(mcToSmc(100, 1.0345)).toBe(103.45));
  it('fattura con accisa e sconto montano FC IVA', () => {
    const righe = calcolaGpl({ regole: g, periodo_da: '2025-05-01', periodo_a: '2025-09-01', consumo_mc: 100, coeff_c: 1.0, zona_montana: true, iva_pct: 10, param });
    const t = totali(righe);
    expect(righe.find(r => r.tipo_riga === 'consumo')!.imponibile).toBe(120);
    expect(righe.find(r => r.tipo_riga === 'quota_fissa')!.imponibile).toBe(16);
    expect(righe.find(r => r.tipo_riga === 'accisa')!.imponibile).toBe(18);
    expect(righe.find(r => r.tipo_riga === 'sconto_zone_montane')!.imponibile).toBe(-5);
    expect(t.imponibile).toBe(154);               // 120+16+18
    expect(t.fuori_campo_iva).toBe(-5);
    expect(t.iva).toBe(15.4);
    expect(t.totale).toBe(164.4);
  });
  it('niente sconto montano fuori zona', () => {
    const righe = calcolaGpl({ regole: g, periodo_da: '2025-05-01', periodo_a: '2025-06-01', consumo_mc: 10, coeff_c: 1, zona_montana: false, iva_pct: 22, param });
    expect(righe.some(r => r.tipo_riga === 'sconto_zone_montane')).toBe(false);
  });
});

describe('mora, letture, utilità', () => {
  it('tasso BCE + 3,5', () => expect(tassoMora(['bce', 'spread'], '2025-06-01', param)).toBeCloseTo(5.65, 4));
  it('mora interesse semplice', () => expect(calcolaMora(1000, '2025-01-01', '2025-04-11', 5.65)).toBe(15.48));
  it('nessuna mora se non scaduto', () => expect(calcolaMora(1000, '2025-02-01', '2025-01-01', 5)).toBe(0));
  it('giro contatore', () => expect(consumo(99990, 15, 5)).toEqual({ consumo: 25, giro: true }));
  it('consumo negativo senza cifre', () => expect(consumo(100, 90).consumo).toBe(-10));
  it('mesi periodo', () => { expect(mesiPeriodo('2025-01-01', '2025-05-01')).toBe(4); expect(mesiPeriodo('2025-01-01', '2025-01-16')).toBe(0.5); });
});
