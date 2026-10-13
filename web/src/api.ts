let token = localStorage.getItem('token') ?? '';
export const sessione = { get token() { return token; }, set(t: string, ruolo: string, user: string) { token = t; localStorage.setItem('token', t); localStorage.setItem('ruolo', ruolo); localStorage.setItem('user', user); }, clear() { token = ''; localStorage.clear(); } };

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 401 && !url.endsWith('/login')) { sessione.clear(); location.reload(); }
  const ct = r.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(typeof data === 'object' ? (data.errore ?? JSON.stringify(data)) + (data.dettagli ? ' — ' + JSON.stringify(data.dettagli) : '') : String(data));
  return data as T;
}
/** Scarica un file protetto da token (CSV/XML). */
export async function scarica(method: string, url: string, body?: unknown, nome = 'export') {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({ errore: r.statusText }))).errore);
  const cd = r.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ?? nome;
  const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = cd; a.click();
}
/** Apre una pagina protetta (stampa HTML) in nuova scheda. */
export async function apriStampa(url: string) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  window.open(URL.createObjectURL(new Blob([await r.text()], { type: 'text/html' })), '_blank');
}
