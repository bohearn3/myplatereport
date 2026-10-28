import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from '../src/index.js';
const T = (await import('../public/js/trackman-csv.js')).default;
const sql = new DatabaseSync(':memory:');
const norm = a => a.map(v => v === undefined ? null : v);
const stmt = (q, args = []) => ({ bind: (...a) => stmt(q, norm(a)), first: async () => sql.prepare(q).get(...args) ?? null, run: async () => (sql.prepare(q).run(...args), {}), all: async () => ({ results: sql.prepare(q).all(...args) }) });
const mails = []; globalThis.fetch = async (u, o) => { mails.push(JSON.parse(o.body)); return new Response('{"id":"em"}'); };
const kv = new Map(); let pdfs = 0;
const env = { DB: { prepare: q => stmt(q), batch: async l => { for (const s of l) await s.run(); } }, ASSETS: { fetch: async () => new Response('') }, RESEND_API_KEY: 'x', REPLY_TO: 'bohearn3@gmail.com',
  PDFS: { put: async (k, v) => { kv.set(k, await new Response(v).arrayBuffer()); }, get: async k => kv.has(k) ? new Response(kv.get(k)).body : null, delete: async k => kv.delete(k) },
  BROWSER: { quickAction: async () => { pdfs++; return new Response(new Uint8Array([37, 80, 68, 70])); } } };
const O = 'https://myplatereport.com';
const call = async (path, { method = 'GET', body, headers = {} } = {}) => { const r = await worker.fetch(new Request(O + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }), env); let j = null; try { j = await r.clone().json(); } catch { } return { status: r.status, j }; };
const M = { 'cf-access-authenticated-user-email': 'brooks@shamrockhomes.us' };
let pass = 0, fail = 0; const check = (l, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? '  ' + x : ''}`); };
await call('/admin/api/umpires/import', { method: 'POST', headers: M, body: { tag: 'WCC', rows: [{ name: 'Scott Jones', email: 'scott@x.com' }, { name: 'Heath Jones', email: 'heath@x.com' }] } });
await call('/admin/api/umpires/import', { method: 'POST', headers: M, body: { tag: 'RMAC', rows: [{ name: 'Cory Monroe', email: 'cory@x.com' }] } });
const ids = Object.fromEntries((await call('/admin/api/umpires', { headers: M })).j.umpires.map(u => [u.name, u.id]));
const p = T.parseTrackman(fs.readFileSync(process.argv[2], 'utf8'), 'g.csv');
// Oops: game sent to Heath instead of Scott
let r = await call('/admin/api/reports', { method: 'POST', headers: M, body: { umpire: { name: 'Heath Jones', email: 'heath@x.com' }, report: { fields: p.fields, games: [p.game], teams: { PAC_TIG: ['Pacific', 'Pacific Tigers'], SEA_RED: ['Seattle U', 'Seattle University Redhawks'] } } } });
const oldId = r.j.url.split('/r/')[1];
check('wrong umpire got the email', mails.at(-1).to[0] === 'heath@x.com' && kv.size === 1);
let d = await call('/admin/api/umpires/' + ids['Heath Jones'], { headers: M }); const gid = d.j.games[0].id;
r = await call(`/admin/api/games/${gid}/move`, { method: 'POST', headers: M, body: { toUmpireId: ids['Scott Jones'], notify: true } });
check('move succeeds and emails the right umpire', r.status === 200 && r.j.emailed && mails.at(-1).to[0] === 'scott@x.com', `revoked ${r.j.revoked}, pdf ${r.j.pdf}`);
check('email subject names the real game', /Seattle University Redhawks at Pacific Tigers/.test(mails.at(-1).subject), mails.at(-1).subject);
check('PDF attached for the new link', mails.at(-1).attachments?.[0]?.path?.includes(r.j.url.split('/r/')[1]));
r = await call('/api/reports/' + oldId); check('old link no longer opens', r.status === 404);
r = await call(`/r/${oldId}/pdf`); check('old PDF no longer opens', r.status === 404);
check('old cached PDF deleted', !kv.has(`report/${oldId}.pdf`));
d = await call('/admin/api/umpires/' + ids['Heath Jones'], { headers: M }); check('game gone from Heath', d.j.games.length === 0 && d.j.reports.length === 0);
d = await call('/admin/api/umpires/' + ids['Scott Jones'], { headers: M }); check('game now under Scott with one live link', d.j.games.length === 1 && d.j.reports.length === 1, d.j.reports.map(x => x.email_status).join());
const newId = d.j.reports[0].id; r = await call('/api/reports/' + newId); check('new link shows Scott', r.j.games[0].umpire === 'Scott Jones');
// duplicate protection
await call('/admin/api/reports', { method: 'POST', headers: M, body: { umpire: { name: 'Heath Jones', email: 'heath@x.com' }, report: { fields: p.fields, games: [p.game], teams: {} }, attachPdf: false } });
d = await call('/admin/api/umpires/' + ids['Heath Jones'], { headers: M });
r = await call(`/admin/api/games/${d.j.games[0].id}/move`, { method: 'POST', headers: M, body: { toUmpireId: ids['Scott Jones'] } });
check('moving onto an umpire who already has the game is refused', r.status === 409, r.j.error);
r = await call(`/admin/api/games/${d.j.games[0].id}`, { method: 'DELETE', headers: M });
d = await call('/admin/api/umpires/' + ids['Heath Jones'], { headers: M }); check('remove game works', r.status === 200 && d.j.games.length === 0);
// coordinators
await call('/admin/api/coordinators', { method: 'POST', headers: M, body: { name: 'F', email: 'f@x.com', conferences: ['WCC'], tier: 'full' } });
await call('/admin/api/coordinators', { method: 'POST', headers: M, body: { name: 'S', email: 's@x.com', conferences: ['WCC'], tier: 'send' } });
const signIn = async e => { await call('/coord/api/login/start', { method: 'POST', body: { email: e } }); const code = mails.at(-1).subject.match(/(\d{6})/)[1]; const w = await worker.fetch(new Request(O + '/coord/api/login/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, code }) }), env); return { cookie: w.headers.get('set-cookie').split(';')[0], origin: O }; };
const F = await signIn('f@x.com'), S = await signIn('s@x.com');
d = await call('/admin/api/umpires/' + ids['Scott Jones'], { headers: M }); const sg = d.j.games[0].id;
r = await call(`/coord/api/games/${sg}/move`, { method: 'POST', headers: S, body: { toUmpireId: ids['Heath Jones'] } }); check('send tier cannot move games', r.status === 403);
r = await call(`/coord/api/games/${sg}/move`, { method: 'POST', headers: F, body: { toUmpireId: ids['Cory Monroe'] } }); check('full tier cannot move to another conference umpire', r.status === 404);
r = await call(`/coord/api/games/${sg}/move`, { method: 'POST', headers: F, body: { toUmpireId: ids['Heath Jones'], notify: false } }); check('full tier can move within their conference', r.status === 200 && !r.j.emailed);
r = await call(`/coord/api/games/${sg}`, { method: 'DELETE', headers: { ...F, 'content-type': 'text/plain' } }); check('delete without JSON header blocked', r.status === 415);
const audit = sql.prepare('SELECT actor, action FROM audit').all(); check('every change is logged (blocked requests are not)', audit.length === 3, audit.map(a => `${a.actor}:${a.action}`).join(', '));
console.log(`\n${pass} passed, ${fail} failed`);
