/** CSV per Excel italiano: separatore `;`, decimale `,`, BOM UTF-8. */
export function toCsv(rows: Record<string, unknown>[], cols?: string[]): string {
  if (!rows.length) return '﻿';
  const keys = cols ?? Object.keys(rows[0]);
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v).replace('.', ',');
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [keys.join(';'), ...rows.map(r => keys.map(k => cell(r[k])).join(';'))].join('\r\n');
}
export const xml = (s: unknown) => String(s ?? '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
