// Permissions test: master vs. coordinators at each tier, conference boundaries, sign-in flow.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from '../src/index.js';
const T = (await import('../public/js/trackman-csv.js')).default;
const sql = new DatabaseSync(':memory:');
const norm = a => a.map(v => v === undefined ? null : v);
const stmt = (q, args = []) => ({ bind: (...a) => stmt(q, norm(a)), first: async () => sql.prepare(q).get(...args) ?? null, run: async () => (sql.prepare(q).run(...args), {}), all: async () => ({ results: sql.prepare(q).all(...args) }) });
const mails = [];
globalThis.fetch = async (u, o) => { const b = JSON.parse(o.body); mails.push(b); return new Response(JSON.stringify({ id: 'em' }), { status: 200 }); };
const env = { DB: { prepare: q => stmt(q), batch: async l => { for (const s of l) await s.run(); } }, ASSETS: { fetch: async r => new Response('asset ' + new URL(r.url).pathname) }, RESEND_API_KEY: 'x', REPLY_TO: 'bohearn3@gmail.com' };
const ORIGIN = 'https://myplatereport.com';
const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
  const r = await worker.fetch(new Request(ORIGIN + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }), env);
  let j = null; try { j = await r.clone().json(); } catch { }
  return { status: r.status, j, r };
};
const M = { 'cf-access-authenticated-user-email': 'brooks@shamrockhomes.us' };
let pass = 0, fail = 0;
const check = (label, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };

// --- master sets up roster + coordinators
await call('/admin/api/umpires/import', { method: 'POST', headers: M, body: { tag: 'WCC', rows: [{ name: 'Scott Jones', email: 'scott@x.com' }, { name: 'Pete Saucedo', email: 'pete@x.com' }] } });
await call('/admin/api/umpires/import', { method: 'POST', headers: M, body: { tag: 'RMAC', rows: [{ name: 'Cory Monroe', email: 'cory@x.com' }, { name: 'Pete Saucedo', email: 'pete@x.com' }] } });
const mk = async (name, email, conf, tier) => (await call('/admin/api/coordinators', { method: 'POST', headers: M, body: { name, email, conferences: conf, tier } })).j.id;
const viewId = await mk('Vera View', 'vera@x.com', ['wcc'], 'view');
const sendId = await mk('Sam Send', 'sam@x.com', ['WCC'], 'send');
const fullId = await mk('Fran Full', 'fran@x.com', ['RMAC'], 'full');
let r = await call('/admin/api/coordinators', { headers: M });
check('master lists 3 coordinators', r.j.coordinators.length === 3, r.j.coordinators.map(c => `${c.name}:${c.tier}:${c.conferences}`).join(', '));
check('conference spelling matched to roster (wcc -> WCC)', r.j.coordinators.find(c => c.name === 'Vera View').conferences[0] === 'WCC');
r = await call('/admin/api/coordinators/' + viewId + '/invite', { method: 'POST', headers: M });
check('invite email sent', r.status === 200 && mails.at(-1).to[0] === 'vera@x.com' && mails.at(-1).html.includes('/coord/login?email=vera%40x.com'));

// --- sign-in flow
const signIn = async (email) => {
  await call('/coord/api/login/start', { method: 'POST', body: { email } });
  const code = mails.at(-1).subject.match(/(\d{6})/)[1];
  const v = await call('/coord/api/login/verify', { method: 'POST', body: { email, code } });
  const ck = v.r.headers.get('set-cookie'); return { cookie: ck.split(';')[0], set: ck };
};
const before = mails.length;
r = await call('/coord/api/login/start', { method: 'POST', body: { email: 'stranger@x.com' } });
check('unknown email gets same answer, no email sent', r.status === 200 && mails.length === before);
await call('/coord/api/login/start', { method: 'POST', body: { email: 'vera@x.com' } });
r = await call('/coord/api/login/verify', { method: 'POST', body: { email: 'vera@x.com', code: '000000' } });
check('wrong code rejected', r.status === 400);
const V = await signIn('vera@x.com'), S = await signIn('sam@x.com'), F = await signIn('fran@x.com');
check('session cookie is HttpOnly, Secure, SameSite=Lax', /HttpOnly/.test(V.set) && /Secure/.test(V.set) && /SameSite=Lax/.test(V.set));
const as = (who) => ({ cookie: who.cookie, origin: ORIGIN });

r = await call('/coord/api/umpires');
check('no session -> 401', r.status === 401);
r = await call('/coord/api/me', { headers: as(V) });
check('me returns view tier + WCC', r.j.tier === 'view' && r.j.conferences.join() === 'WCC');

// --- scope
r = await call('/coord/api/umpires', { headers: as(V) });
check('WCC coordinator sees only WCC umpires', r.j.umpires.map(u => u.name).sort().join() === 'Pete Saucedo,Scott Jones', r.j.umpires.map(u => u.name).join(', '));
r = await call('/coord/api/umpires', { headers: as(F) });
check('RMAC coordinator sees only RMAC umpires', r.j.umpires.map(u => u.name).sort().join() === 'Cory Monroe,Pete Saucedo');
const ids = Object.fromEntries((await call('/admin/api/umpires', { headers: M })).j.umpires.map(u => [u.name, u.id]));
r = await call('/coord/api/umpires/' + ids['Cory Monroe'], { headers: as(V) });
check('WCC coordinator cannot open an RMAC-only umpire', r.status === 404);

// --- tiers
const csv = fs.readFileSync(process.argv[2], 'utf8'); const p = T.parseTrackman(csv, 'g.csv');
const rep = (name, email) => ({ umpire: { name, email }, report: { fields: p.fields, currentFile: 'g.csv', games: [p.game], teams: {} }, attachPdf: false });
r = await call('/coord/api/reports', { method: 'POST', headers: as(V), body: rep('Scott Jones', 'scott@x.com') });
check('view tier cannot send', r.status === 403, r.j.error);
r = await call('/coord/api/reports', { method: 'POST', headers: as(S), body: rep('Scott Jones', 'scott@x.com') });
check('send tier can send to own umpire', r.status === 200 && r.j.emailed, '');
check('reply-to is the coordinator', mails.at(-1).reply_to === 'sam@x.com');
r = await call('/coord/api/reports', { method: 'POST', headers: as(S), body: rep('Cory Monroe', 'cory@x.com') });
check('send tier cannot send to another conference umpire', r.status === 403, r.j.error);
r = await call('/coord/api/reports', { method: 'POST', headers: as(S), body: rep('New Person', 'new@x.com') });
check('send tier cannot create a new umpire by sending', r.status === 403);
r = await call('/coord/api/umpires', { method: 'POST', headers: as(S), body: { name: 'X', email: 'x1@x.com' } });
check('send tier cannot add umpires', r.status === 403);
r = await call('/coord/api/umpires', { method: 'POST', headers: as(F), body: { name: 'Rhea New', email: 'rhea@x.com', tags: ['WCC', 'RMAC'] } });
let rhea = (await call('/admin/api/umpires', { headers: M })).j.umpires.find(u => u.email === 'rhea@x.com');
check('full tier adds umpire, only their conference tag kept', r.status === 200 && rhea.tags.join() === 'RMAC', rhea.tags.join());
r = await call('/coord/api/umpires/' + ids['Pete Saucedo'], { method: 'PUT', headers: as(F), body: { name: 'Pete Saucedo', email: 'pete@x.com', tags: [], active: true } });
let pete = (await call('/admin/api/umpires', { headers: M })).j.umpires.find(u => u.email === 'pete@x.com');
check('full tier removing their tag leaves other conference tags alone', pete.tags.join() === 'WCC', pete.tags.join());
r = await call('/coord/api/umpires/' + ids['Scott Jones'], { method: 'PUT', headers: as(F), body: { name: 'Hacked', email: 'scott@x.com', tags: ['RMAC'] } });
check('full tier cannot edit an umpire outside their conference', r.status === 404);
r = await call('/coord/api/umpires/import', { method: 'POST', headers: as(F), body: { tag: 'WCC', rows: [{ name: 'Scott Jones', email: 'scott@x.com' }] } });
let scott = (await call('/admin/api/umpires', { headers: M })).j.umpires.find(u => u.email === 'scott@x.com');
check('full tier import of an existing WCC umpire only adds RMAC, keeps name', scott.tags.join() === 'WCC,RMAC' && scott.name === 'Scott Jones', scott.tags.join());
r = await call('/coord/api/umpires/' + ids['Scott Jones'], { headers: as(F) });
check('…and now that coordinator sees all of his games', r.status === 200 && r.j.games.length === 1);

// --- master-only
r = await call('/coord/api/coordinators', { headers: as(F) });
check('coordinator cannot manage coordinators', r.status === 403);
r = await call('/coord/api/games/import', { method: 'POST', headers: as(F), body: {} });
check('coordinator cannot run season import', r.status === 403);

// --- CSRF + revoke
r = await call('/coord/api/umpires', { method: 'POST', headers: { cookie: F.cookie, origin: 'https://evil.example' }, body: { name: 'Z', email: 'z@x.com' } });
check('cross-site POST blocked', r.status === 403);
await call('/admin/api/coordinators/' + sendId, { method: 'PUT', headers: M, body: { name: 'Sam Send', email: 'sam@x.com', conferences: ['WCC'], tier: 'send', active: false } });
r = await call('/coord/api/me', { headers: as(S) });
check('turning a coordinator off signs them out', r.status === 401);
r = await call('/coord/api/logout', { method: 'POST', headers: as(V) });
r = await call('/coord/api/me', { headers: as(V) });
check('sign out ends the session', r.status === 401);

// --- pages
r = await worker.fetch(new Request(ORIGIN + '/coord/'), env); check('/coord/ serves the umpires page', (await r.text()) === 'asset /admin/umpires/');
r = await worker.fetch(new Request(ORIGIN + '/coord/send/'), env); check('/coord/send/ serves the send page', (await r.text()) === 'asset /admin/');
r = await worker.fetch(new Request(ORIGIN + '/coord/login?email=a'), env); check('/coord/login serves the sign-in page', (await r.text()) === 'asset /coord-login');
console.log(`\n${pass} passed, ${fail} failed`);
