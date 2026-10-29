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
await call('/admin/api/umpires/import', { method: 'POST', headers: M, body: { tag: 'WCC', rows: [{ name: "Brooks O'Hearn", email: 'bohearn3@gmail.com' }, { name: 'Heath Jones', email: 'heath@x.com' }] } });
await call('/admin/api/umpires/import', { method: 'POST', headers: M, body: { tag: 'RMAC', rows: [{ name: 'Cory Monroe', email: 'cory@x.com' }] } });
const ids = Object.fromEntries((await call('/admin/api/umpires', { headers: M })).j.umpires.map(u => [u.name, u.id]));
const B = ids["Brooks O'Hearn"], H = ids['Heath Jones'];
const p = T.parseTrackman(fs.readFileSync(process.argv[2], 'utf8'), 'g.csv');
const teams = { PAC_TIG: ['Pacific', 'Pacific Tigers'], SEA_RED: ['Seattle U', 'Seattle University Redhawks'] };
await call('/admin/api/reports', { method: 'POST', headers: M, body: { umpire: { name: "Brooks O'Hearn", email: 'bohearn3@gmail.com' }, report: { fields: p.fields, games: [p.game], teams }, attachPdf: false } });
await call('/admin/api/reports', { method: 'POST', headers: M, body: { umpire: { name: 'Heath Jones', email: 'heath@x.com' }, report: { fields: p.fields, games: [p.game], teams }, attachPdf: false } });
// a silent-import style game for Brooks with no live link
const g2 = { ...p.game, Date: '2026-03-29', GameID: 'other-game' };
r0: { const r = await call('/admin/api/games/import', { method: 'POST', headers: M, body: { umpireId: B, fields: p.fields, game: g2, teams } }); console.log('import', r.status, r.j?.error || ''); }
sql.prepare(`UPDATE reports SET revoked_at = 'x' WHERE game_id IN (SELECT id FROM games WHERE date = '2026-03-29')`).run();

let r, d;
const start = async e => { const n = mails.length; const r = await call('/portal/api/login/start', { method: 'POST', body: { email: e } }); return { r, mail: mails.length > n ? mails.at(-1) : null }; };
const verify = async (e, code) => worker.fetch(new Request(O + '/portal/api/login/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, code }) }), env);
r = await call('/portal/api/me'); check('portal API needs sign-in', r.status === 401);
let s = await start('bohearn3@gmail.com'); check('portal off: no code sent, same answer', s.r.status === 200 && !s.mail, s.r.j.message);
d = await call('/admin/api/umpires/' + B, { headers: M }); check('card shows portal off', d.j.umpire.portal === 0);
r = await call(`/admin/api/umpires/${B}/portal`, { method: 'POST', headers: M, body: { on: true, invite: true } });
check('master turns portal on + invite', r.status === 200 && mails.at(-1).to[0] === 'bohearn3@gmail.com' && /portal/i.test(mails.at(-1).subject), r.j.message);
check('invite links to /portal/login with email', mails.at(-1).text.includes('/portal/login?email=bohearn3%40gmail.com'));
check('invite reply-to is Brooks', mails.at(-1).reply_to === 'bohearn3@gmail.com');
s = await start('bohearn3@gmail.com'); const code = s.mail?.subject.match(/(\d{6})/)?.[1]; check('code emailed once portal is on', !!code);
let w = await verify('bohearn3@gmail.com', '000000'); check('wrong code rejected', w.status === 400);
w = await verify('bohearn3@gmail.com', code); const ck = w.headers.get('set-cookie') || '';
check('right code signs in with umpire cookie', w.status === 200 && ck.startsWith('mpr_ump=') && /HttpOnly/.test(ck) && /Secure/.test(ck));
const U = { cookie: ck.split(';')[0], origin: O };
w = await verify('bohearn3@gmail.com', code); check('code works only once', w.status === 400);
d = await call('/portal/api/me', { headers: U });
check('portal shows only his own games', d.status === 200 && d.j.games.length === 2 && d.j.umpire.name === "Brooks O'Hearn", `${d.j.games?.length} games`);
check('one game has a live link, one does not', Object.keys(d.j.reports).length === 1);
const noLink = d.j.games.find(g => !d.j.reports[g.id]);
r = await call(`/portal/api/games/${noLink.id}/open`, { method: 'POST', headers: U }); check('opening a game without a link makes one', r.status === 200 && !!r.j.reportId);
r = await call('/api/reports/' + r.j.reportId); check('that link opens his report', r.status === 200 && r.j.games.at(-1).umpire === "Brooks O'Hearn");
const hg = (await call('/admin/api/umpires/' + H, { headers: M })).j.games[0].id;
r = await call(`/portal/api/games/${hg}/open`, { method: 'POST', headers: U }); check("can't open another umpire's game", r.status === 404);
r = await call('/coord/api/umpires', { headers: U }); check('umpire cookie gives no coordinator access', r.status === 401);
r = await call('/admin/api/umpires', { headers: U }); check('umpire cookie gives no admin access', r.status === 401);
r = await call('/portal/api/me', { headers: { cookie: 'mpr_session=' + U.cookie.split('=')[1] } }); check('cookie names are not interchangeable', r.status === 401);
r = await call('/portal/api/logout', { method: 'POST', headers: { ...U, origin: 'https://evil.example' } }); check('cross-site POST blocked', r.status === 403);
// coordinators
await call('/admin/api/coordinators', { method: 'POST', headers: M, body: { name: 'V', email: 'v@x.com', conferences: ['WCC'], tier: 'view' } });
await call('/admin/api/coordinators', { method: 'POST', headers: M, body: { name: 'F', email: 'f@x.com', conferences: ['RMAC'], tier: 'full' } });
const signIn = async e => { await call('/coord/api/login/start', { method: 'POST', body: { email: e } }); const c = mails.at(-1).subject.match(/(\d{6})/)[1]; const w = await worker.fetch(new Request(O + '/coord/api/login/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, code: c }) }), env); return { cookie: w.headers.get('set-cookie').split(';')[0], origin: O }; };
const V = await signIn('v@x.com'), F = await signIn('f@x.com');
r = await call(`/coord/api/umpires/${H}/portal`, { method: 'POST', headers: V, body: { on: true } }); check('view tier cannot turn on portal', r.status === 403);
r = await call(`/coord/api/umpires/${H}/portal`, { method: 'POST', headers: F, body: { on: true } }); check('other-conference coordinator cannot', r.status === 404);
r = await call(`/coord/api/umpires/${ids['Cory Monroe']}/portal`, { method: 'POST', headers: F, body: { on: true, invite: true } }); check('full tier can for own conference; reply-to is coordinator', r.status === 200 && mails.at(-1).reply_to === 'f@x.com');
// turning off and email change sign out
r = await call(`/admin/api/umpires/${B}/portal`, { method: 'POST', headers: M, body: { on: false } });
r = await call('/portal/api/me', { headers: U }); check('turning portal off signs him out', r.status === 401);
await call(`/admin/api/umpires/${B}/portal`, { method: 'POST', headers: M, body: { on: true } });
s = await start('bohearn3@gmail.com'); w = await verify('bohearn3@gmail.com', s.mail.subject.match(/(\d{6})/)[1]); const U2 = { cookie: w.headers.get('set-cookie').split(';')[0] };
await call('/admin/api/umpires/' + B, { method: 'PUT', headers: M, body: { name: "Brooks O'Hearn", email: 'brooks2@x.com', tags: ['WCC'], active: true } });
r = await call('/portal/api/me', { headers: U2 }); check('changing his email signs him out', r.status === 401);
d = await call('/admin/api/umpires/' + B, { headers: M }); check('card shows last sign-in', !!d.j.umpire.last_login && d.j.umpire.portal === 1);
const au = sql.prepare("SELECT action FROM audit WHERE action LIKE 'portal%'").all().map(a => a.action); check('portal changes logged', au.length === 4, au.join());
console.log(`\n${pass} passed, ${fail} failed`);
