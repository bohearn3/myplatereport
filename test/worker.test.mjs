// Local test: runs the Worker against an in-memory SQLite stand-in for D1, a fake KV, a fake PDF service and a fake Resend.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from '../src/index.js';
const T = (await import('../public/js/trackman-csv.js')).default;

const sql = new DatabaseSync(':memory:');
const norm = a => a.map(v => v === undefined ? null : v);
const stmt = (q, args = []) => ({
  bind: (...a) => stmt(q, norm(a)),
  first: async () => sql.prepare(q).get(...args) ?? null,
  run: async () => (sql.prepare(q).run(...args), { success: true }),
  all: async () => ({ results: sql.prepare(q).all(...args) })
});
const DB = { prepare: q => stmt(q), batch: async list => { for (const s of list) await s.run(); return []; } };
const kv = new Map();
const PDFS = { put: async (k, v) => { kv.set(k, new Uint8Array(await new Response(v).arrayBuffer())); }, get: async (k) => kv.has(k) ? new Response(kv.get(k)).body : null };
let pdfCalls = 0;
const BROWSER = { quickAction: async (kind, opts) => { pdfCalls++; if (kind !== 'pdf' || !opts.url.includes('?pdf=1')) throw new Error('bad call'); return new Response(new Uint8Array([37,80,68,70,45]), { headers: { 'content-type': 'application/pdf' } }); } };
const sent = [];
globalThis.fetch = async (u, o) => { sent.push({ u, body: JSON.parse(o.body) }); return new Response(JSON.stringify({ id: 'em_123' }), { status: 200 }); };
const ASSETS = { fetch: async r => new Response('asset ' + new URL(r.url).pathname) };
const env = { DB, ASSETS, BROWSER, PDFS, RESEND_API_KEY: 'test', REPLY_TO: 'bohearn3@gmail.com' };
const H = { 'cf-access-authenticated-user-email': 'brooks@shamrockhomes.us', 'content-type': 'application/json' };
const req = (path, method = 'GET', body, hdr = H) => worker.fetch(new Request('https://myplatereport.com' + path, { method, headers: hdr, body: body ? JSON.stringify(body) : undefined }), env);

// roster import
let r = await req('/admin/api/umpires/import', 'POST', { rows: [{ name: "Brooks O'Hearn", email: 'BROOKS@example.com', phone: '808-555-0100' }, { name: 'Scott Jones', email: 'scott@example.com' }, { name: 'No Email', email: '' }] });
console.log('import ->', r.status, await r.json());
r = await req('/admin/api/umpires/import', 'POST', { rows: [{ name: 'Scott A. Jones', email: 'scott@example.com' }] });
console.log('re-import ->', await r.json());
r = await req('/admin/api/umpires'); let L = (await r.json()).umpires; console.log('list ->', L.map(u => [u.name, u.email, u.phone, u.active, u.games]));
r = await req('/admin/api/umpires', 'GET', null, {}); console.log('no access ->', r.status);

// send a report
const csv = fs.readFileSync(process.argv[2], 'utf8');
const p = T.parseTrackman(csv, 'g.csv');
const teams = { PAC_TIG: ['Pacific', 'Pacific Tigers'], SEA_RED: ['Seattle U', 'Seattle University Redhawks'] };
r = await req('/admin/api/reports', 'POST', { umpire: { name: "Brooks O'Hearn", email: 'brooks@example.com' }, report: { fields: p.fields, currentFile: 'g.csv', games: [p.game], teams } });
const j = await r.json(); console.log('send ->', r.status, j);
const em = sent[0].body; console.log('attachments', em.attachments, '| pdf calls', pdfCalls, '| html mentions PDF:', em.html.includes('PDF copy is attached'));
const id = j.url.split('/r/')[1];
r = await req(`/r/${id}/pdf`); console.log('pdf ->', r.status, r.headers.get('content-type'), r.headers.get('content-disposition'), (await r.arrayBuffer()).byteLength, 'bytes | pdf calls', pdfCalls);
r = await req(`/api/reports/${id}`); const d = await r.json(); console.log('report data reportId', d.reportId === id, 'games', d.games.length);

// umpire detail + edit
const bid = L.find(u => u.email === 'brooks@example.com').id;
r = await req('/admin/api/umpires/' + bid); const det = await r.json();
console.log('detail ->', det.umpire.name, 'games', det.games.map(g => [g.date, g.home_name, g.away_name, g.adj?.toFixed(4), g.misses]), 'reports', det.reports.map(x => [x.email_status, x.pdf_status]));
r = await req('/admin/api/umpires/' + bid, 'PUT', { name: "Brooks O'Hearn", email: 'scott@example.com', active: true }); console.log('email clash ->', r.status, (await r.json()).error);
r = await req('/admin/api/umpires/' + bid, 'PUT', { name: "Brooks O'Hearn", email: 'brooks@example.com', active: false }); console.log('deactivate ->', r.status);
r = await req('/admin/api/umpires'); L = (await r.json()).umpires; console.log('after ->', L.map(u => [u.name, u.active, u.games, u.last_adj && u.last_adj.toFixed(4)]));
r = await req('/api/health'); console.log('health', await r.json());
