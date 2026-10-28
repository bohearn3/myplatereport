import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from '../src/index.js';
const sql = new DatabaseSync(':memory:');
const norm = a => a.map(v => v === undefined ? null : v);
const stmt = (q, args = []) => ({ bind: (...a) => stmt(q, norm(a)), first: async () => sql.prepare(q).get(...args) ?? null, run: async () => (sql.prepare(q).run(...args), {}), all: async () => ({ results: sql.prepare(q).all(...args) }) });
let mails = 0; globalThis.fetch = async () => { mails++; return new Response('{}'); };
const env = { DB: { prepare: q => stmt(q), batch: async l => { for (const s of l) await s.run(); } }, ASSETS: { fetch: async () => new Response('') }, RESEND_API_KEY: 'x' };
const H = { 'cf-access-authenticated-user-email': 'a@b.c', 'content-type': 'application/json' };
const req = (path, method = 'GET', body) => worker.fetch(new Request('https://x.com' + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined }), env);
const B = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
await req('/admin/api/umpires/import', 'POST', { tag: 'WCC', rows: [{ name: "Brooks O'Hearn", email: 'b@x.com' }, { name: 'Scott Jones', email: 's@x.com' }, { name: 'Heath Jones', email: 'h@x.com' }] });
const L = (await (await req('/admin/api/umpires')).json()).umpires;
const id = n => L.find(u => u.name === n).id;
const pick = B.games.filter(g => ['Scott Jones', 'Heath Jones', "Brooks O'Hearn"].includes(g.umpireName));
let t0 = Date.now();
for (const g of pick) { const { umpireName, ...game } = g; const r = await req('/admin/api/games/import', 'POST', { umpireId: id(umpireName), fields: B.fields, game, teams: { [g.HomeTeam]: B.teams[g.HomeTeam] || [g.HomeTeam, g.HomeTeam] } }); const j = await r.json(); console.log(r.status, g.Date, umpireName, j.adj?.toFixed(3), j.misses); }
// re-import same games -> no duplicates
for (const g of pick) { const { umpireName, ...game } = g; await req('/admin/api/games/import', 'POST', { umpireId: id(umpireName), fields: B.fields, game }); }
console.log('games', sql.prepare('SELECT COUNT(*) c FROM games').get().c, 'reports', sql.prepare('SELECT COUNT(*) c FROM reports').get().c, 'emails sent', mails, 'ms', Date.now() - t0);
console.log((await (await req('/admin/api/umpires')).json()).umpires.map(u => [u.name, u.games, u.last_game, u.avg_adj?.toFixed(3)]));
const det = await (await req('/admin/api/umpires/' + id('Scott Jones'))).json(); console.log(det.reports.map(r => r.email_status));
let r = await req('/admin/api/games/import', 'POST', { umpireId: 'nope', fields: B.fields, game: pick[0] }); console.log('bad umpire ->', r.status);
// a trend report for Scott's latest game now includes earlier games
const last = det.reports[0].id; const rd = await (await req('/api/reports/' + last)).json(); console.log('report games for trends', rd.games.length, rd.games.map(g => g.Date));
