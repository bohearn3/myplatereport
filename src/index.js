// MyPlateReport — Cloudflare Worker.
// Public:  /                    home page
//          /r/<id>              private report link (interactive)      /r/<id>/pdf   PDF of that report
//          /api/reports/<id>    report data for the report page
// Master admin (Cloudflare Access on /admin):
//          /admin/ ...          send, umpires, season import, coordinators      /admin/api/...
// Conference coordinators (site sign-in with email codes):
//          /coord/login         sign in        /coord/  umpires        /coord/send/  send a report
//          /coord/api/...       same API as admin, limited by tier and conference
// Umpires (site sign-in with email codes, only when their portal access is on):
//          /portal/login        sign in        /portal/  their own reports and trends      /portal/api/...

import '../public/js/engine.js';
import { reportEmail, codeEmail, inviteEmail, portalInviteEmail } from './email.js';
import { startLogin, verifyLogin, sessionUser, endSession, sessionCookie } from './auth.js';

const E = globalThis.UmpEngine;
const FROM = 'MyPlateReport <reports@myplatereport.com>';
const TIERS = ['view', 'send', 'full'];

const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'cache-control': 'no-store', ...headers } });
const now = () => new Date().toISOString();
const validEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s || '');
const token = (n = 18) => {
  const a = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

/* ---------------- schema ---------------- */
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS umpires (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS teams (code TEXT PRIMARY KEY, short_name TEXT, full_name TEXT, updated_at TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, umpire_id TEXT NOT NULL, game_key TEXT, date TEXT, home TEXT, away TEXT, stadium TEXT, level TEXT, file TEXT, fields_json TEXT NOT NULL, pitches_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (umpire_id, game_key))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, umpire_id TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, email_status TEXT, email_id TEXT, emailed_at TEXT)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS games_umpire_date ON games (umpire_id, date)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS coordinators (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, conferences TEXT NOT NULL DEFAULT '[]', tier TEXT NOT NULL DEFAULT 'view', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_login TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS login_codes (email TEXT NOT NULL, code_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS login_codes_email ON login_codes (email, created_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY, coordinator_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, user_agent TEXT)`)
  ]);
  const row = await db.prepare(`SELECT v FROM meta WHERE k = 'schema'`).first();
  const ver = row ? Number(row.v) : 1;
  if (ver < 2) {
    const add = [
      `ALTER TABLE umpires ADD COLUMN phone TEXT`, `ALTER TABLE umpires ADD COLUMN active INTEGER NOT NULL DEFAULT 1`, `ALTER TABLE umpires ADD COLUMN notes TEXT`,
      `ALTER TABLE games ADD COLUMN adj REAL`, `ALTER TABLE games ADD COLUMN raw REAL`, `ALTER TABLE games ADD COLUMN decisions INTEGER`,
      `ALTER TABLE games ADD COLUMN misses INTEGER`, `ALTER TABLE games ADD COLUMN edge REAL`, `ALTER TABLE reports ADD COLUMN pdf_status TEXT`
    ];
    for (const q of add) { try { await db.prepare(q).run(); } catch (e) { /* column already exists */ } }
    await db.prepare(`INSERT INTO meta (k, v) VALUES ('schema', '2') ON CONFLICT(k) DO UPDATE SET v = '2'`).run();
  }
  if (ver < 3) {
    try { await db.prepare(`ALTER TABLE umpires ADD COLUMN tags TEXT`).run(); } catch (e) { /* already there */ }
    await db.prepare(`INSERT INTO meta (k, v) VALUES ('schema', '3') ON CONFLICT(k) DO UPDATE SET v = '3'`).run();
  }
  if (ver < 4) {
    try { await db.prepare(`ALTER TABLE reports ADD COLUMN revoked_at TEXT`).run(); } catch (e) { /* already there */ }
    await db.prepare(`CREATE TABLE IF NOT EXISTS audit (at TEXT NOT NULL, actor TEXT, action TEXT NOT NULL, details TEXT)`).run();
    await db.prepare(`INSERT INTO meta (k, v) VALUES ('schema', '4') ON CONFLICT(k) DO UPDATE SET v = '4'`).run();
  }
  if (ver < 5) {
    // Umpire portal: off for everyone until an admin turns it on.
    for (const q of [`ALTER TABLE umpires ADD COLUMN portal INTEGER NOT NULL DEFAULT 0`, `ALTER TABLE umpires ADD COLUMN last_login TEXT`]) { try { await db.prepare(q).run(); } catch (e) { /* already there */ } }
    await db.prepare(`CREATE TABLE IF NOT EXISTS ump_codes (email TEXT NOT NULL, code_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS ump_codes_email ON ump_codes (email, created_at)`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS ump_sessions (id_hash TEXT PRIMARY KEY, umpire_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, user_agent TEXT)`).run();
    await db.prepare(`INSERT INTO meta (k, v) VALUES ('schema', '5') ON CONFLICT(k) DO UPDATE SET v = '5'`).run();
  }
  schemaReady = true;
}

/* ---------------- who is asking ---------------- */
// actor = { kind: 'master', email }  or  { kind: 'coord', id, name, email, tier, conferences }
const lc = s => String(s || '').toLowerCase();
const isMaster = a => a.kind === 'master';
const tierAtLeast = (a, t) => isMaster(a) || TIERS.indexOf(a.tier) >= TIERS.indexOf(t);
const confSet = a => new Set((a.conferences || []).map(lc));
const inScope = (a, tags) => isMaster(a) || tags.some(t => confSet(a).has(lc(t)));
function need(a, tier) {
  if (!tierAtLeast(a, tier)) throw new HttpError(403, tier === 'send' ? 'Your access is view only. Ask the site admin for send access.' : 'Your access does not include managing the roster.');
}
async function umpireInScope(env, a, id) {
  const u = await env.DB.prepare('SELECT * FROM umpires WHERE id = ?').bind(id).first();
  if (!u || !inScope(a, parseTags(u.tags))) throw new HttpError(404, 'Umpire not found.');
  return u;
}

/* ---------------- PDF ---------------- */
const pdfKey = id => `report/${id}.pdf`;
const safeName = s => String(s || '').replace(/[^\w .'-]+/g, '').trim();

async function renderPdf(env, origin, id) {
  if (!env.BROWSER) throw new Error('PDF service is not connected');
  const res = await env.BROWSER.quickAction('pdf', {
    url: `${origin}/r/${id}?pdf=1`,
    gotoOptions: { waitUntil: 'networkidle0', timeout: 30000 },
    waitForSelector: { selector: 'body[data-ready="1"]', timeout: 20000 },
    pdfOptions: { format: 'letter', printBackground: true, preferCSSPageSize: true, scale: 0.78 }
  });
  const r = res instanceof Response ? res : new Response(res);
  if (!r.ok) throw new Error(`PDF service returned ${r.status}`);
  return r;
}
async function buildAndStorePdf(env, origin, id) {
  if (!env.PDFS) return false;
  const r = await renderPdf(env, origin, id);
  await env.PDFS.put(pdfKey(id), r.body, { metadata: { created: now() } });
  return true;
}
async function servePdf(id, env, origin) {
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(id) || !env.DB) return new Response('Not found', { status: 404 });
  await ensureSchema(env.DB);
  const rep = await env.DB.prepare(`SELECT r.id, r.revoked_at, g.date, u.name FROM reports r JOIN games g ON g.id = r.game_id JOIN umpires u ON u.id = r.umpire_id WHERE r.id = ?`).bind(id).first();
  if (!rep || rep.revoked_at) return new Response('Not found', { status: 404 });
  const headers = { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="Plate Report - ${safeName(rep.name)} - ${rep.date}.pdf"`, 'cache-control': 'private, max-age=3600' };
  if (env.PDFS) { const cached = await env.PDFS.get(pdfKey(id), 'stream'); if (cached) return new Response(cached, { headers }); }
  try {
    const r = await renderPdf(env, origin, id);
    if (env.PDFS) { const [a, b] = r.body.tee(); env.PDFS.put(pdfKey(id), b).catch(() => {}); return new Response(a, { headers }); }
    return new Response(r.body, { headers });
  } catch (e) { return new Response('The PDF could not be created right now. Open the online report instead.', { status: 503 }); }
}

/* ---------------- game storage ---------------- */
async function saveTeams(db, teams, t) {
  const stmts = Object.entries(teams || {}).map(([code, v]) =>
    db.prepare('INSERT INTO teams (code, short_name, full_name, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET short_name = excluded.short_name, full_name = excluded.full_name, updated_at = excluded.updated_at')
      .bind(code, String(v[0] || code).slice(0, 80), String(v[1] || code).slice(0, 120), t));
  if (stmts.length) await db.batch(stmts);
}
// Same umpire + same Trackman game replaces the stored copy instead of duplicating it.
async function saveGame(db, umpireId, g, fields, s, t) {
  const gameKey = g.GameID || `${g.Date}|${g.HomeTeam}|${g.AwayTeam}`;
  const existing = await db.prepare('SELECT id FROM games WHERE umpire_id = ? AND game_key = ?').bind(umpireId, gameKey).first();
  const gameId = existing ? existing.id : token(9);
  await db.prepare(`INSERT INTO games (id, umpire_id, game_key, date, home, away, stadium, level, file, fields_json, pitches_json, created_at, adj, raw, decisions, misses, edge)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET date = excluded.date, home = excluded.home, away = excluded.away, stadium = excluded.stadium, level = excluded.level, file = excluded.file,
      fields_json = excluded.fields_json, pitches_json = excluded.pitches_json, adj = excluded.adj, raw = excluded.raw, decisions = excluded.decisions, misses = excluded.misses, edge = excluded.edge`)
    .bind(gameId, umpireId, gameKey, g.Date, g.HomeTeam, g.AwayTeam, g.Stadium, g.Level, g.file, JSON.stringify(fields), JSON.stringify(g.pitches), t,
      s.adj, s.raw, s.decisions, s.missN, s.edgeAcc).run();
  return gameId;
}

// Silent import (master only): stores a game for an existing roster umpire. No email, no PDF.
async function importGame(env, a, body) {
  const g = body?.game, fields = body?.fields;
  if (!body?.umpireId || !g || !Array.isArray(g.pitches) || !Array.isArray(fields)) return json({ error: 'Missing umpire or game data.' }, 400);
  if (g.pitches.length > 2000) return json({ error: 'Too many pitches for one game.' }, 400);
  const u = await env.DB.prepare('SELECT id, name FROM umpires WHERE id = ?').bind(body.umpireId).first();
  if (!u) return json({ error: 'That umpire is not on the roster.' }, 404);
  const A = E.analyzeGame({ ...g, umpire: u.name }, fields, E.ZONES.nsi2027);
  const t = now();
  await saveTeams(env.DB, body.teams, t);
  const gameId = await saveGame(env.DB, u.id, g, fields, A.summary, t);
  let rep = await env.DB.prepare('SELECT id FROM reports WHERE game_id = ? ORDER BY created_at LIMIT 1').bind(gameId).first();
  if (!rep) {
    rep = { id: token() };
    await env.DB.prepare('INSERT INTO reports (id, game_id, umpire_id, created_by, created_at, email_status, pdf_status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(rep.id, gameId, u.id, a.email, t, 'imported (not emailed)', 'on request').run();
  }
  return json({ ok: true, gameId, reportId: rep.id, adj: A.summary.adj, misses: A.summary.missN });
}

/* ---------------- save + email ---------------- */
async function saveReport(request, env, a, body) {
  need(a, 'send');
  const ump = body.umpire || {}, rep = body.report || {};
  const name = (ump.name || '').trim(), email = (ump.email || '').trim().toLowerCase();
  if (!name || !validEmail(email)) return json({ error: 'Enter the umpire’s name and a valid email.' }, 400);
  const g = (rep.games || [])[0];
  if (!g || !Array.isArray(g.pitches) || !Array.isArray(rep.fields)) return json({ error: 'The report data is missing.' }, 400);
  if (g.pitches.length > 2000) return json({ error: 'That file has too many pitches for one game.' }, 400);

  const db = env.DB, t = now();
  let umpire = await db.prepare('SELECT id, tags FROM umpires WHERE email = ?').bind(email).first();
  if (umpire) {
    if (!inScope(a, parseTags(umpire.tags))) return json({ error: 'That umpire is not on your conference roster.' }, 403);
    await db.prepare('UPDATE umpires SET name = ? WHERE id = ?').bind(name, umpire.id).run();
  } else {
    if (!isMaster(a) && !tierAtLeast(a, 'full')) return json({ error: 'Pick an umpire from your roster. Ask the site admin to add new umpires.' }, 403);
    umpire = { id: token(9) };
    const tags = isMaster(a) ? [] : (a.conferences || []);
    await db.prepare('INSERT INTO umpires (id, name, email, tags, active, created_at) VALUES (?, ?, ?, ?, 1, ?)').bind(umpire.id, name, email, JSON.stringify(tags), t).run();
  }

  const A = E.analyzeGame({ ...g, umpire: name }, rep.fields, E.ZONES.nsi2027);
  const s = A.summary;
  await saveTeams(db, rep.teams, t);
  const gameId = await saveGame(db, umpire.id, g, rep.fields, s, t);
  const reportId = token();
  await db.prepare('INSERT INTO reports (id, game_id, umpire_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)').bind(reportId, gameId, umpire.id, a.email, t).run();
  const origin = new URL(request.url).origin;
  const url = `${origin}/r/${reportId}`;

  const teams = rep.teams || {};
  const out = await deliverReport(env, a, origin, reportId, { name, email }, g, c => (teams[c] && teams[c][1]) || c, s, A.hbp.length, body.attachPdf !== false);
  return json(out.body, out.status);
}

// Build the PDF (if wanted) and email the report link. Used for new reports and for games moved to the right umpire.
async function deliverReport(env, a, origin, reportId, ump, g, tname, s, hbpN, wantPdf) {
  const db = env.DB, url = `${origin}/r/${reportId}`;
  let pdf = false, pdfNote = null;
  if (wantPdf) {
    try { pdf = await buildAndStorePdf(env, origin, reportId); if (!pdf) pdfNote = 'PDF storage is not connected'; }
    catch (e) { pdfNote = e.message; }
  }
  await db.prepare('UPDATE reports SET pdf_status = ? WHERE id = ?').bind(pdf ? 'ready' : `skipped: ${pdfNote || 'off'}`, reportId).run();
  if (!env.RESEND_API_KEY) {
    await db.prepare('UPDATE reports SET email_status = ? WHERE id = ?').bind('not_configured', reportId).run();
    return { status: 200, body: { ok: true, url, emailed: false, pdf, note: 'Report saved. Email is not set up yet (RESEND_API_KEY is missing).' } };
  }
  const msg = reportEmail({ name: ump.name, url, pdf, game: { date: g.Date, home: tname(g.HomeTeam), away: tname(g.AwayTeam), intra: g.HomeTeam && g.HomeTeam === g.AwayTeam }, s, hbp: hbpN });
  // Replies go to the coordinator who sent it; the master admin's reports reply to REPLY_TO.
  const replyTo = isMaster(a) ? (env.REPLY_TO || a.email) : a.email;
  const payload = { from: FROM, to: [ump.email], reply_to: replyTo, subject: msg.subject, html: msg.html, text: msg.text };
  if (pdf) payload.attachments = [{ filename: `Plate Report - ${safeName(ump.name)} - ${g.Date}.pdf`, path: `${url}/pdf` }];
  const out = await sendEmail(env, payload);
  if (!out.ok) {
    await db.prepare('UPDATE reports SET email_status = ? WHERE id = ?').bind(`error ${out.status}`, reportId).run();
    return { status: 502, body: { ok: false, url, emailed: false, pdf, error: `Report saved, but the email failed: ${out.message}` } };
  }
  await db.prepare('UPDATE reports SET email_status = ?, email_id = ?, emailed_at = ? WHERE id = ?').bind('sent', out.id, now(), reportId).run();
  return { status: 200, body: { ok: true, url, emailed: true, pdf, pdfNote } };
}

const audit = (db, a, action, details) => db.prepare('INSERT INTO audit (at, actor, action, details) VALUES (?, ?, ?, ?)').bind(now(), a.email, action, JSON.stringify(details)).run();

// Old links stop working (the wrong umpire may have been emailed one) and cached PDFs are dropped.
async function revokeGameLinks(env, gameId) {
  const { results } = await env.DB.prepare('SELECT id FROM reports WHERE game_id = ? AND revoked_at IS NULL').bind(gameId).all();
  await env.DB.prepare('UPDATE reports SET revoked_at = ? WHERE game_id = ? AND revoked_at IS NULL').bind(now(), gameId).run();
  if (env.PDFS) for (const r of results) { try { await env.PDFS.delete(pdfKey(r.id)); } catch (e) { /* already gone */ } }
  return results.length;
}

// Move a game to the right umpire (master, or full-control coordinators within their conferences).
async function moveGame(request, env, a, gameId, body) {
  need(a, 'full');
  const db = env.DB;
  const g = await db.prepare('SELECT * FROM games WHERE id = ?').bind(gameId).first();
  if (!g) return json({ error: 'Game not found.' }, 404);
  const from = await umpireInScope(env, a, g.umpire_id);
  if (!body?.toUmpireId || body.toUmpireId === from.id) return json({ error: 'Choose a different umpire.' }, 400);
  const to = await umpireInScope(env, a, body.toUmpireId);
  if (await db.prepare('SELECT id FROM games WHERE umpire_id = ? AND game_key = ?').bind(to.id, g.game_key).first())
    return json({ error: `${to.name} already has this game. Remove one of the copies instead.` }, 409);
  const revoked = await revokeGameLinks(env, g.id);
  await db.prepare('UPDATE games SET umpire_id = ? WHERE id = ?').bind(to.id, g.id).run();
  await db.prepare('UPDATE reports SET umpire_id = ? WHERE game_id = ?').bind(to.id, g.id).run();
  const reportId = token();
  await db.prepare('INSERT INTO reports (id, game_id, umpire_id, created_by, created_at, email_status, pdf_status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(reportId, g.id, to.id, a.email, now(), 'moved (not emailed)', 'on request').run();
  await audit(db, a, 'move_game', { game: g.id, date: g.date, home: g.home, away: g.away, from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name }, revoked });
  const origin = new URL(request.url).origin;
  let result = { ok: true, url: `${origin}/r/${reportId}`, emailed: false, revoked };
  if (body.notify) {
    const fields = JSON.parse(g.fields_json), game = { Date: g.date, HomeTeam: g.home, AwayTeam: g.away, Stadium: g.stadium, Level: g.level, pitches: JSON.parse(g.pitches_json) };
    const A = E.analyzeGame({ ...game, umpire: to.name }, fields, E.ZONES.nsi2027);
    const names = {}; for (const r of (await db.prepare('SELECT code, full_name FROM teams WHERE code IN (?, ?)').bind(g.home, g.away).all()).results) names[r.code] = r.full_name;
    const out = await deliverReport(env, a, origin, reportId, { name: to.name, email: to.email }, game, c => names[c] || c, A.summary, A.hbp.length, body.pdf !== false);
    result = { ...out.body, revoked, ok: out.status === 200 };
    if (out.status !== 200) return json(result, out.status);
  }
  return json(result);
}

// Remove a game uploaded by mistake (master, or full-control coordinators within their conferences).
async function removeGame(env, a, gameId) {
  need(a, 'full');
  const g = await env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(gameId).first();
  if (!g) return json({ error: 'Game not found.' }, 404);
  const u = await umpireInScope(env, a, g.umpire_id);
  const revoked = await revokeGameLinks(env, g.id);
  await env.DB.prepare('DELETE FROM games WHERE id = ?').bind(g.id).run();
  await audit(env.DB, a, 'remove_game', { game: g.id, date: g.date, home: g.home, away: g.away, umpire: { id: u.id, name: u.name }, revoked });
  return json({ ok: true, revoked });
}

async function sendEmail(env, payload) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(payload)
  });
  const out = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, id: out.id || null } : { ok: false, status: r.status, message: out.message || String(r.status) };
}

/* ---------------- report data (public by private link) ---------------- */
async function getReport(id, env) {
  if (!env.DB || !/^[A-Za-z0-9_-]{16,40}$/.test(id)) return json({ error: 'Report not found.' }, 404);
  await ensureSchema(env.DB);
  const rep = await env.DB.prepare(`SELECT r.id, r.game_id, r.revoked_at, g.date, u.id AS umpire_id, u.name AS umpire FROM reports r
    JOIN games g ON g.id = r.game_id JOIN umpires u ON u.id = r.umpire_id WHERE r.id = ?`).bind(id).first();
  if (!rep || rep.revoked_at) return json({ error: 'Report not found.' }, 404);
  const { results } = await env.DB.prepare(`SELECT id, date, home, away, stadium, level, fields_json, pitches_json FROM games
    WHERE umpire_id = ? AND (date < ? OR id = ?) ORDER BY date, created_at LIMIT 60`).bind(rep.umpire_id, rep.date, rep.game_id).all();
  const fields = JSON.parse(results.find(r => r.id === rep.game_id).fields_json);
  const games = results.map(r => {
    let pitches = JSON.parse(r.pitches_json);
    const f = JSON.parse(r.fields_json);
    if (f.join() !== fields.join()) pitches = pitches.map(p => fields.map(k => p[f.indexOf(k)] ?? null));
    return { file: r.id, umpire: rep.umpire, Date: r.date, HomeTeam: r.home, AwayTeam: r.away, Stadium: r.stadium, Level: r.level, pitches };
  });
  const codes = [...new Set(games.flatMap(g => [g.HomeTeam, g.AwayTeam]).filter(Boolean))];
  const teams = {};
  if (codes.length) {
    const t = await env.DB.prepare(`SELECT code, short_name, full_name FROM teams WHERE code IN (${codes.map(() => '?').join(',')})`).bind(...codes).all();
    for (const row of t.results) teams[row.code] = [row.short_name, row.full_name];
  }
  return json({ fields, currentFile: rep.game_id, games, teams, reportId: id });
}

/* ---------------- tags (conferences) ---------------- */
function parseTags(v) { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function cleanTags(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(/[,;|]/);
  const out = [], seen = new Set();
  for (const t of list) {
    const tag = String(t || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (tag && !seen.has(tag.toLowerCase())) { seen.add(tag.toLowerCase()); out.push(tag); }
  }
  return out.slice(0, 12);
}
async function tagSpellings(env) {
  const m = new Map();
  for (const r of (await env.DB.prepare('SELECT tags FROM umpires WHERE tags IS NOT NULL').all()).results)
    for (const t of parseTags(r.tags)) if (!m.has(t.toLowerCase())) m.set(t.toLowerCase(), t);
  for (const r of (await env.DB.prepare('SELECT conferences FROM coordinators').all()).results)
    for (const t of parseTags(r.conferences)) if (!m.has(t.toLowerCase())) m.set(t.toLowerCase(), t);
  return m;
}
const canon = (tags, m) => cleanTags(tags.map(t => { const k = t.toLowerCase(); if (!m.has(k)) m.set(k, t); return m.get(k); }));
// A coordinator can only add or remove their own conferences; other conferences' tags are left as they were.
function scopeTags(a, requested, existing = []) {
  if (isMaster(a)) return cleanTags(requested);
  const mine = confSet(a);
  return cleanTags([...existing.filter(t => !mine.has(lc(t))), ...cleanTags(requested).filter(t => mine.has(lc(t)))]);
}

/* ---------------- umpires ---------------- */
async function listUmpires(env, a) {
  const { results } = await env.DB.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.active, u.notes, u.tags, u.created_at,
      (SELECT COUNT(*) FROM games g WHERE g.umpire_id = u.id) AS games,
      (SELECT MAX(date) FROM games g WHERE g.umpire_id = u.id) AS last_game,
      (SELECT AVG(adj) FROM games g WHERE g.umpire_id = u.id AND adj IS NOT NULL) AS avg_adj,
      (SELECT adj FROM games g WHERE g.umpire_id = u.id ORDER BY date DESC, created_at DESC LIMIT 1) AS last_adj
    FROM umpires u ORDER BY u.active DESC, u.name COLLATE NOCASE`).all();
  const list = results.map(u => ({ ...u, tags: parseTags(u.tags) })).filter(u => inScope(a, u.tags));
  return json({ umpires: list });
}
async function getUmpire(id, env, a) {
  const u = await umpireInScope(env, a, id);
  const games = (await env.DB.prepare(`SELECT g.id, g.date, g.home, g.away, g.stadium, g.level, g.adj, g.raw, g.decisions, g.misses, g.edge,
      th.full_name AS home_name, ta.full_name AS away_name
    FROM games g LEFT JOIN teams th ON th.code = g.home LEFT JOIN teams ta ON ta.code = g.away
    WHERE g.umpire_id = ? ORDER BY g.date DESC, g.created_at DESC`).bind(id).all()).results;
  const reports = (await env.DB.prepare(`SELECT id, game_id, created_at, created_by, email_status, emailed_at, pdf_status FROM reports WHERE umpire_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`).bind(id).all()).results;
  const { phone, notes, active, created_at, name, email, portal, last_login } = u;
  return json({ umpire: { id, name, email, phone, notes, active, created_at, portal: portal ? 1 : 0, last_login: last_login || null, tags: parseTags(u.tags) }, games, reports });
}
// Dashboard: one compact row per game for every umpire in scope; the page does the math.
async function dashboard(env, a) {
  const ups = (await env.DB.prepare('SELECT id, name, tags, active, portal FROM umpires ORDER BY name COLLATE NOCASE').all()).results
    .map(u => ({ id: u.id, name: u.name, tags: parseTags(u.tags), active: u.active, portal: u.portal ? 1 : 0 })).filter(u => inScope(a, u.tags));
  const ids = new Set(ups.map(u => u.id));
  const games = (await env.DB.prepare(`SELECT g.id, g.umpire_id, g.date, g.home, g.away, g.level, g.adj, g.raw, g.misses, g.edge, g.decisions,
      th.full_name AS home_name, ta.full_name AS away_name
    FROM games g LEFT JOIN teams th ON th.code = g.home LEFT JOIN teams ta ON ta.code = g.away ORDER BY g.date, g.created_at`).all()).results.filter(g => ids.has(g.umpire_id));
  const reports = {};
  for (const r of (await env.DB.prepare('SELECT id, game_id FROM reports WHERE revoked_at IS NULL ORDER BY created_at DESC').all()).results)
    if (!reports[r.game_id]) reports[r.game_id] = r.id;
  const live = {}; for (const g of games) if (reports[g.id]) live[g.id] = reports[g.id];
  return json({ umpires: ups, games, reports: live });
}
function cleanUmpire(o) {
  return {
    name: String(o.name || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    email: String(o.email || '').trim().toLowerCase().slice(0, 200),
    phone: String(o.phone || '').trim().slice(0, 40) || null,
    notes: String(o.notes || '').trim().slice(0, 500) || null,
    tags: cleanTags(o.tags)
  };
}
async function upsertUmpire(env, a, o, spell) {
  const u = cleanUmpire(o);
  u.tags = canon(u.tags, spell || await tagSpellings(env));
  if (!isMaster(a)) {
    u.tags = scopeTags(a, u.tags);
    if (!u.tags.length) u.tags = cleanTags(a.conferences);
  }
  if (!u.name || !validEmail(u.email)) return { error: `Missing name or valid email${u.name ? ` for ${u.name}` : ''}.` };
  const ex = await env.DB.prepare('SELECT id, tags FROM umpires WHERE email = ?').bind(u.email).first();
  if (ex) {
    const tags = cleanTags([...parseTags(ex.tags), ...u.tags]); // add conferences, never remove on import
    if (!inScope(a, parseTags(ex.tags))) {
      // Umpire already exists in another conference: only add this coordinator's conference, leave their details alone.
      await env.DB.prepare('UPDATE umpires SET tags = ? WHERE id = ?').bind(JSON.stringify(tags), ex.id).run();
    } else {
      await env.DB.prepare('UPDATE umpires SET name = ?, phone = COALESCE(?, phone), notes = COALESCE(?, notes), tags = ?, active = 1 WHERE id = ?').bind(u.name, u.phone, u.notes, JSON.stringify(tags), ex.id).run();
    }
    return { id: ex.id, updated: true };
  }
  const id = token(9);
  await env.DB.prepare('INSERT INTO umpires (id, name, email, phone, notes, tags, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)').bind(id, u.name, u.email, u.phone, u.notes, JSON.stringify(u.tags), now()).run();
  return { id, created: true };
}
async function updateUmpire(env, a, id, body) {
  const cur = await umpireInScope(env, a, id);
  const u = cleanUmpire(body || {});
  if (!u.name || !validEmail(u.email)) return json({ error: 'Enter a name and a valid email.' }, 400);
  const tags = scopeTags(a, canon(u.tags, await tagSpellings(env)), parseTags(cur.tags));
  const clash = await env.DB.prepare('SELECT id FROM umpires WHERE email = ? AND id <> ?').bind(u.email, id).first();
  if (clash) return json({ error: 'Another umpire already uses that email.' }, 409);
  const active = body.active === false || body.active === 0 ? 0 : 1;
  await env.DB.prepare('UPDATE umpires SET name = ?, email = ?, phone = ?, notes = ?, tags = ?, active = ? WHERE id = ?')
    .bind(u.name, u.email, u.phone, u.notes, JSON.stringify(tags), active, id).run();
  // A new email or turning the umpire off signs them out of the portal everywhere.
  if (!active || u.email !== cur.email) await env.DB.prepare('DELETE FROM ump_sessions WHERE umpire_id = ?').bind(id).run();
  return json({ ok: true });
}

/* ---------------- umpire portal access (master + full-control coordinators) ---------------- */
async function setPortal(request, env, a, id, body) {
  need(a, 'full');
  const u = await umpireInScope(env, a, id);
  const on = !!body.on;
  if (on && !u.active) return json({ error: 'Turn this umpire on before giving portal access.' }, 400);
  await env.DB.prepare('UPDATE umpires SET portal = ? WHERE id = ?').bind(on ? 1 : 0, id).run();
  await audit(env.DB, a, on ? 'portal_on' : 'portal_off', { umpire: { id, name: u.name }, invite: !!body.invite });
  if (!on) {
    await env.DB.prepare('DELETE FROM ump_sessions WHERE umpire_id = ?').bind(id).run();
    return json({ ok: true, message: `Portal access turned off. ${u.name} is signed out.` });
  }
  if (!body.invite) return json({ ok: true, message: `Portal access is on. ${u.name} can sign in at /portal.` });
  if (!env.RESEND_API_KEY) return json({ error: 'Portal access is on, but email is not set up, so no invite was sent.' }, 503);
  const origin = new URL(request.url).origin;
  const msg = portalInviteEmail({ name: u.name, url: `${origin}/portal/login?email=${encodeURIComponent(u.email)}` });
  const out = await sendEmail(env, { from: FROM, to: [u.email], reply_to: isMaster(a) ? (env.REPLY_TO || a.email) : a.email, subject: msg.subject, html: msg.html, text: msg.text });
  return out.ok ? json({ ok: true, message: `Portal access is on and an invite went to ${u.email}.` })
    : json({ error: `Portal access is on, but the invite could not be sent: ${out.message}` }, 502);
}

/* ---------------- coordinators (master only) ---------------- */
function cleanCoordinator(o) {
  return {
    name: String(o.name || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    email: String(o.email || '').trim().toLowerCase().slice(0, 200),
    conferences: cleanTags(o.conferences),
    tier: TIERS.includes(o.tier) ? o.tier : 'view',
    active: o.active === false || o.active === 0 ? 0 : 1
  };
}
async function coordinatorsApi(request, env, a, rest, m, body) {
  if (!isMaster(a)) throw new HttpError(403, 'Only the site admin can manage coordinators.');
  const db = env.DB;
  if (rest === '' && m === 'GET') {
    const { results } = await db.prepare('SELECT id, name, email, conferences, tier, active, created_at, last_login FROM coordinators ORDER BY active DESC, name COLLATE NOCASE').all();
    return json({ coordinators: results.map(c => ({ ...c, conferences: parseTags(c.conferences) })) });
  }
  if (rest === '' && m === 'POST') {
    const c = cleanCoordinator(body || {});
    c.conferences = canon(c.conferences, await tagSpellings(env));
    if (!c.name || !validEmail(c.email)) return json({ error: 'Enter a name and a valid email.' }, 400);
    if (!c.conferences.length) return json({ error: 'Pick at least one conference.' }, 400);
    if (await db.prepare('SELECT id FROM coordinators WHERE email = ?').bind(c.email).first()) return json({ error: 'A coordinator with that email already exists.' }, 409);
    const id = token(9);
    await db.prepare('INSERT INTO coordinators (id, name, email, conferences, tier, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, c.name, c.email, JSON.stringify(c.conferences), c.tier, c.active, now()).run();
    return json({ ok: true, id });
  }
  const one = rest.match(/^\/([A-Za-z0-9_-]+)(\/invite)?$/);
  if (one) {
    const cur = await db.prepare('SELECT * FROM coordinators WHERE id = ?').bind(one[1]).first();
    if (!cur) return json({ error: 'Coordinator not found.' }, 404);
    if (!one[2] && m === 'PUT') {
      const c = cleanCoordinator(body || {});
      c.conferences = canon(c.conferences, await tagSpellings(env));
      if (!c.name || !validEmail(c.email)) return json({ error: 'Enter a name and a valid email.' }, 400);
      if (!c.conferences.length) return json({ error: 'Pick at least one conference.' }, 400);
      if (await db.prepare('SELECT id FROM coordinators WHERE email = ? AND id <> ?').bind(c.email, cur.id).first()) return json({ error: 'Another coordinator already uses that email.' }, 409);
      await db.prepare('UPDATE coordinators SET name = ?, email = ?, conferences = ?, tier = ?, active = ? WHERE id = ?')
        .bind(c.name, c.email, JSON.stringify(c.conferences), c.tier, c.active, cur.id).run();
      // Turning someone off, or changing their email, signs them out everywhere.
      if (!c.active || c.email !== cur.email) await db.prepare('DELETE FROM sessions WHERE coordinator_id = ?').bind(cur.id).run();
      return json({ ok: true });
    }
    if (one[2] && m === 'POST') {
      if (!cur.active) return json({ error: 'Turn this coordinator on before sending an invite.' }, 400);
      if (!env.RESEND_API_KEY) return json({ error: 'Email is not set up.' }, 503);
      const origin = new URL(request.url).origin;
      const msg = inviteEmail({ name: cur.name, conferences: parseTags(cur.conferences), tier: cur.tier, url: `${origin}/coord/login?email=${encodeURIComponent(cur.email)}` });
      const out = await sendEmail(env, { from: FROM, to: [cur.email], reply_to: env.REPLY_TO || a.email, subject: msg.subject, html: msg.html, text: msg.text });
      return out.ok ? json({ ok: true }) : json({ error: `The invite could not be sent: ${out.message}` }, 502);
    }
  }
  return json({ error: 'Not found.' }, 404);
}

/* ---------------- shared API (admin + coordinator) ---------------- */
async function api(request, env, a, sub) {
  const db = env.DB, m = request.method;
  let body = null;
  if (m === 'POST' || m === 'PUT') {
    const text = await request.text();
    if (text.trim()) { try { body = JSON.parse(text); } catch { return json({ error: 'The request could not be read.' }, 400); } } else body = {};
  }

  if (sub === '/me' && m === 'GET') return json(isMaster(a) ? { role: 'master', email: a.email } : { role: 'coordinator', name: a.name, email: a.email, tier: a.tier, conferences: a.conferences });
  if (sub === '/teams' && m === 'GET') return json({ teams: (await db.prepare('SELECT code, short_name, full_name FROM teams').all()).results });
  if (sub === '/reports' && m === 'POST') return saveReport(request, env, a, body || {});
  if (sub === '/umpires' && m === 'GET') return listUmpires(env, a);
  if (sub === '/dashboard' && m === 'GET') return dashboard(env, a);
  if (sub === '/umpires' && m === 'POST') {
    need(a, 'full');
    const r = await upsertUmpire(env, a, body || {});
    return r.error ? json(r, 400) : json({ ok: true, ...r });
  }
  if (sub === '/umpires/import' && m === 'POST') {
    need(a, 'full');
    const rows = Array.isArray(body?.rows) ? body.rows.slice(0, 1000) : [];
    let rosterTags = cleanTags(body?.tag);
    if (!isMaster(a)) {
      rosterTags = scopeTags(a, rosterTags);
      if (!rosterTags.length) { if (a.conferences.length === 1) rosterTags = cleanTags(a.conferences); else return json({ error: 'Choose which of your conferences this roster is for.' }, 400); }
    }
    const spell = await tagSpellings(env);
    let created = 0, updated = 0; const errors = [];
    for (const row of rows) {
      const r = await upsertUmpire(env, a, { ...row, tags: [...cleanTags(row.tags), ...rosterTags] }, spell);
      if (r.error) errors.push(r.error); else if (r.created) created++; else updated++;
    }
    return json({ ok: true, created, updated, errors });
  }
  const um = sub.match(/^\/umpires\/([A-Za-z0-9_-]+)$/);
  if (um && m === 'GET') return getUmpire(um[1], env, a);
  if (um && m === 'PUT') { need(a, 'full'); return updateUmpire(env, a, um[1], body); }
  const pm = sub.match(/^\/umpires\/([A-Za-z0-9_-]+)\/portal$/);
  if (pm && m === 'POST') return setPortal(request, env, a, pm[1], body || {});
  const gm = sub.match(/^\/games\/([A-Za-z0-9_-]+)(\/move)?$/);
  if (gm && gm[2] && m === 'POST') return moveGame(request, env, a, gm[1], body);
  if (gm && !gm[2] && m === 'DELETE') return removeGame(env, a, gm[1]);

  // Master only
  if (sub === '/games/import' && m === 'POST') { if (!isMaster(a)) throw new HttpError(403, 'Only the site admin can import seasons.'); return importGame(env, a, body); }
  if (sub === '/coordinators' || sub.startsWith('/coordinators/')) return coordinatorsApi(request, env, a, sub.slice('/coordinators'.length), m, body);
  return json({ error: 'Not found.' }, 404);
}

/* ---------------- sign-in (coordinators and umpires) ---------------- */
async function loginApi(request, env, kind, sub) {
  const db = env.DB;
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const email = String(body.email || '').trim().toLowerCase();
  if (sub === '/login/start') {
    if (!validEmail(email)) return json({ error: 'Enter a valid email address.' }, 400);
    const r = await startLogin(db, kind, email);
    if (r.send && env.RESEND_API_KEY) {
      const msg = codeEmail({ name: r.user.name, code: r.code });
      await sendEmail(env, { from: FROM, to: [email], subject: msg.subject, html: msg.html, text: msg.text });
    }
    // Same answer either way, so the form can't be used to find out who has access.
    return json({ ok: true, message: `If that email has ${kind === 'ump' ? 'portal' : 'coordinator'} access, a 6-digit code is on its way.` });
  }
  if (sub === '/login/verify') {
    const r = await verifyLogin(db, kind, email, body.code, request.headers.get('user-agent'));
    if (r.error) return json({ error: r.error }, 400);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(kind, r.token, r.maxAge) });
  }
  if (sub === '/logout') {
    await endSession(db, kind, request);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(kind, '', 0) });
  }
  return json({ error: 'Not found.' }, 404);
}

/* ---------------- umpire portal API: only the signed-in umpire's own data ---------------- */
async function portalApi(request, env, u, sub) {
  const db = env.DB, m = request.method;
  if (sub === '/me' && m === 'GET') {
    const games = (await db.prepare(`SELECT g.id, g.date, g.home, g.away, g.stadium, g.level, g.adj, g.raw, g.decisions, g.misses, g.edge,
        th.full_name AS home_name, ta.full_name AS away_name
      FROM games g LEFT JOIN teams th ON th.code = g.home LEFT JOIN teams ta ON ta.code = g.away
      WHERE g.umpire_id = ? ORDER BY g.date DESC, g.created_at DESC`).bind(u.id).all()).results;
    const reports = {};
    for (const r of (await db.prepare(`SELECT id, game_id FROM reports WHERE umpire_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`).bind(u.id).all()).results)
      if (!reports[r.game_id]) reports[r.game_id] = r.id;
    return json({ umpire: { name: u.name, email: u.email, conferences: parseTags(u.tags) }, games, reports });
  }
  // A game with no live report link (e.g. a silent import whose link was turned off) gets a fresh one when the umpire opens it.
  const om = sub.match(/^\/games\/([A-Za-z0-9_-]+)\/open$/);
  if (om && m === 'POST') {
    const g = await db.prepare('SELECT id FROM games WHERE id = ? AND umpire_id = ?').bind(om[1], u.id).first();
    if (!g) return json({ error: 'Game not found.' }, 404);
    const ex = await db.prepare('SELECT id FROM reports WHERE game_id = ? AND umpire_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1').bind(g.id, u.id).first();
    if (ex) return json({ ok: true, reportId: ex.id });
    const id = token();
    await db.prepare('INSERT INTO reports (id, game_id, umpire_id, created_by, created_at, email_status, pdf_status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, g.id, u.id, 'portal', now(), 'opened in portal', null).run();
    return json({ ok: true, reportId: id });
  }
  return json({ error: 'Not found.' }, 404);
}

/* ---------------- router ---------------- */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/api/health') return json({ ok: true, db: !!env.DB, email: !!env.RESEND_API_KEY, pdf: !!env.BROWSER, pdfStore: !!env.PDFS, time: now() });

    try {
      // Master admin: Cloudflare Access on /admin adds this header after sign-in.
      if (p.startsWith('/admin/api/')) {
        if (!env.DB) return json({ error: 'The database is not connected yet.' }, 503);
        const email = request.headers.get('cf-access-authenticated-user-email');
        if (!email) return json({ error: 'Sign in through Cloudflare Access.' }, 401);
        await ensureSchema(env.DB);
        return await api(request, env, { kind: 'master', email: email.toLowerCase() }, p.slice('/admin/api'.length));
      }
      // Coordinators: site sign-in.
      if (p.startsWith('/coord/api/')) {
        if (!env.DB) return json({ error: 'The database is not connected yet.' }, 503);
        await ensureSchema(env.DB);
        if (request.method !== 'GET') {
          const origin = request.headers.get('origin');
          if (origin && origin !== url.origin) return json({ error: 'Request blocked.' }, 403);
          if (!(request.headers.get('content-type') || '').includes('application/json')) return json({ error: 'Request blocked.' }, 415);
        }
        const sub = p.slice('/coord/api'.length);
        if (sub.startsWith('/login/') || sub === '/logout') return await loginApi(request, env, 'coord', sub);
        const c = await sessionUser(env.DB, 'coord', request);
        if (!c) return json({ error: 'Please sign in.' }, 401);
        return await api(request, env, { kind: 'coord', id: c.id, name: c.name, email: c.email, tier: c.tier, conferences: parseTags(c.conferences) }, sub);
      }
      // Umpires: site sign-in, their own data only.
      if (p.startsWith('/portal/api/')) {
        if (!env.DB) return json({ error: 'The database is not connected yet.' }, 503);
        await ensureSchema(env.DB);
        if (request.method !== 'GET') {
          const origin = request.headers.get('origin');
          if (origin && origin !== url.origin) return json({ error: 'Request blocked.' }, 403);
          if (!(request.headers.get('content-type') || '').includes('application/json')) return json({ error: 'Request blocked.' }, 415);
        }
        const sub = p.slice('/portal/api'.length);
        if (sub.startsWith('/login/') || sub === '/logout') return await loginApi(request, env, 'ump', sub);
        const u = await sessionUser(env.DB, 'ump', request);
        if (!u) return json({ error: 'Please sign in.' }, 401);
        return await portalApi(request, env, u, sub);
      }
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      return json({ error: `Something went wrong: ${e.message}` }, 500);
    }

    const m = p.match(/^\/api\/reports\/([A-Za-z0-9_-]+)$/);
    if (m && request.method === 'GET') return getReport(m[1], env);
    const pdf = p.match(/^\/r\/([A-Za-z0-9_-]+)\/pdf$/);
    if (pdf) return servePdf(pdf[1], env, url.origin);
    if (p.startsWith('/r/')) return env.ASSETS.fetch(new Request(new URL('/report', url), request));

    // Coordinator pages reuse the admin page files; each page asks /coord/api/me what this person may do.
    if (p === '/coord' || p === '/coord/') return env.ASSETS.fetch(new Request(new URL('/admin/dashboard/', url), request));
    if (p === '/coord/umpires' || p === '/coord/umpires/') return env.ASSETS.fetch(new Request(new URL('/admin/umpires/', url), request));
    if (p === '/coord/send' || p === '/coord/send/') return env.ASSETS.fetch(new Request(new URL('/admin/', url), request));
    if (p === '/coord/login' || p === '/coord/login/') return env.ASSETS.fetch(new Request(new URL('/coord-login', url), request));
    if (p === '/portal' || p === '/portal/') return env.ASSETS.fetch(new Request(new URL('/portal-home', url), request));
    if (p === '/portal/login' || p === '/portal/login/') return env.ASSETS.fetch(new Request(new URL('/portal-login', url), request));

    return env.ASSETS.fetch(request);
  }
};
