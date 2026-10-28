// Local test: runs the Worker against an in-memory SQLite stand-in for D1 and a fake Resend.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from '../src/index.js';
const T = (await import('../public/js/trackman-csv.js')).default;

const sql = new DatabaseSync(':memory:');
const stmt = (q, args = []) => ({
  bind: (...a) => stmt(q, a),
  first: async () => sql.prepare(q).get(...args) ?? null,
  run: async () => (sql.prepare(q).run(...args), { success: true }),
  all: async () => ({ results: sql.prepare(q).all(...args) })
});
const DB = { prepare: q => stmt(q), batch: async list => { for (const s of list) await s.run(); return []; } };
const sent = [];
globalThis.fetch = async (u, o) => { sent.push({ u, body: JSON.parse(o.body) }); return new Response(JSON.stringify({ id: 'em_123' }), { status: 200 }); };
const ASSETS = { fetch: async r => new Response('asset ' + new URL(r.url).pathname) };
const env = { DB, ASSETS, RESEND_API_KEY: 'test', REPLY_TO: 'brooks@shamrockhomes.us' };

const csv = fs.readFileSync(process.argv[2], 'utf8');
const r = T.parseTrackman(csv, 'g.csv');
const teams = { PAC_TIG: ['Pacific', 'Pacific Tigers'], SEA_RED: ['Seattle U', 'Seattle University Redhawks'] };
const body = { umpire: { name: "Brooks O'Hearn", email: 'Brooks@Example.com' }, report: { fields: r.fields, currentFile: 'g.csv', games: [r.game], teams } };
const post = (b, hdr = { 'cf-access-authenticated-user-email': 'brooks@shamrockhomes.us' }) =>
  worker.fetch(new Request('https://myplatereport.com/admin/api/reports', { method: 'POST', headers: { 'content-type': 'application/json', ...hdr }, body: JSON.stringify(b) }), env);

let res = await post(body, {}); console.log('no access header ->', res.status);
res = await post(body); const j = await res.json(); console.log('save ->', res.status, j);
console.log('email to', sent[0].body.to, 'reply_to', sent[0].body.reply_to, '| subject:', sent[0].body.subject);
fs.writeFileSync(process.argv[3], sent[0].body.html);
// second upload of same game: should replace game, new report link
res = await post(body); const j2 = await res.json();
console.log('games rows', sql.prepare('SELECT COUNT(*) c FROM games').get().c, 'reports rows', sql.prepare('SELECT COUNT(*) c FROM reports').get().c);
const id = j.url.split('/r/')[1];
res = await worker.fetch(new Request('https://myplatereport.com/api/reports/' + id), env); const d = await res.json();
console.log('get ->', res.status, 'games', d.games.length, 'umpire', d.games[0].umpire, 'teams', d.teams, 'pitches', d.games[0].pitches.length);
const E = globalThis.UmpEngine; const A = E.analyzeGame(d.games[0], d.fields, E.ZONES.nsi2027); console.log('rescored adj', A.summary.adj.toFixed(4));
res = await worker.fetch(new Request('https://myplatereport.com/api/reports/bogus'), env); console.log('bad id ->', res.status);
res = await worker.fetch(new Request('https://myplatereport.com/r/' + id), env); console.log('/r/ ->', await res.text());
