// MyPlateReport — Cloudflare Worker.
// Public:  /                    home page
//          /r/<id>              private report link (interactive)
//          /r/<id>/pdf          PDF of that report
//          /api/reports/<id>    report data for the report page
// Admin (behind Cloudflare Access on /admin):
//          /admin/              send a report        /admin/umpires/   umpire roster
//          /admin/api/...       admin API

import '../public/js/engine.js';
import { reportEmail } from './email.js';

const E = globalThis.UmpEngine;
const FROM = 'MyPlateReport <reports@myplatereport.com>';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const now = () => new Date().toISOString();
const validEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s || '');
const token = (n = 18) => {
  const a = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

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
    db.prepare(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`)
  ]);
  // Columns added after the first release
  const row = await db.prepare(`SELECT v FROM meta WHERE k = 'schema'`).first();
  const ver = row ? Number(row.v) : 1;
  if (ver < 2) {
    const add = [
      `ALTER TABLE umpires ADD COLUMN phone TEXT`,
      `ALTER TABLE umpires ADD COLUMN active INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE umpires ADD COLUMN notes TEXT`,
      `ALTER TABLE games ADD COLUMN adj REAL`, `ALTER TABLE games ADD COLUMN raw REAL`,
      `ALTER TABLE games ADD COLUMN decisions INTEGER`, `ALTER TABLE games ADD COLUMN misses INTEGER`, `ALTER TABLE games ADD COLUMN edge REAL`,
      `ALTER TABLE reports ADD COLUMN pdf_status TEXT`
    ];
    for (const q of add) { try { await db.prepare(q).run(); } catch (e) { /* column already exists */ } }
    await db.prepare(`INSERT INTO meta (k, v) VALUES ('schema', '2') ON CONFLICT(k) DO UPDATE SET v = '2'`).run();
  }
  if (ver < 3) {
    try { await db.prepare(`ALTER TABLE umpires ADD COLUMN tags TEXT`).run(); } catch (e) { /* already there */ }
    await db.prepare(`INSERT INTO meta (k, v) VALUES ('schema', '3') ON CONFLICT(k) DO UPDATE SET v = '3'`).run();
  }
  schemaReady = true;
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
  if (env.PDFS) { await env.PDFS.put(pdfKey(id), r.body, { metadata: { created: now() } }); return true; }
  await r.body?.cancel();
  return false;
}

async function servePdf(id, env, origin) {
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(id) || !env.DB) return new Response('Not found', { status: 404 });
  await ensureSchema(env.DB);
  const rep = await env.DB.prepare(`SELECT r.id, g.date, u.name FROM reports r JOIN games g ON g.id = r.game_id JOIN umpires u ON u.id = r.umpire_id WHERE r.id = ?`).bind(id).first();
  if (!rep) return new Response('Not found', { status: 404 });
  const headers = {
    'content-type': 'application/pdf',
    'content-disposition': `inline; filename="Plate Report - ${safeName(rep.name)} - ${rep.date}.pdf"`,
    'cache-control': 'private, max-age=3600'
  };
  if (env.PDFS) {
    const cached = await env.PDFS.get(pdfKey(id), 'stream');
    if (cached) return new Response(cached, { headers });
  }
  try {
    const r = await renderPdf(env, origin, id);
    if (env.PDFS) {
      const [a, b] = r.body.tee();
      env.PDFS.put(pdfKey(id), b).catch(() => {});
      return new Response(a, { headers });
    }
    return new Response(r.body, { headers });
  } catch (e) {
    return new Response(`The PDF could not be created right now. Open the online report instead.`, { status: 503 });
  }
}

/* ---------------- save + email ---------------- */
async function saveReport(request, env, ctx) {
  if (!env.DB) return json({ error: 'The database is not connected yet.' }, 503);
  const admin = request.headers.get('cf-access-authenticated-user-email');
  if (!admin) return json({ error: 'Sign in through Cloudflare Access to send reports.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'The upload could not be read.' }, 400); }
  const ump = body.umpire || {}, rep = body.report || {};
  const name = (ump.name || '').trim(), email = (ump.email || '').trim().toLowerCase();
  if (!name || !validEmail(email)) return json({ error: 'Enter the umpire’s name and a valid email.' }, 400);
  const g = (rep.games || [])[0];
  if (!g || !Array.isArray(g.pitches) || !Array.isArray(rep.fields)) return json({ error: 'The report data is missing.' }, 400);
  if (g.pitches.length > 2000) return json({ error: 'That file has too many pitches for one game.' }, 400);

  const A = E.analyzeGame({ ...g, umpire: name }, rep.fields, E.ZONES.nsi2027);
  const s = A.summary;

  const db = env.DB; await ensureSchema(db);
  const t = now();
  let umpire = await db.prepare('SELECT id FROM umpires WHERE email = ?').bind(email).first();
  if (!umpire) { umpire = { id: token(9) }; await db.prepare('INSERT INTO umpires (id, name, email, created_at) VALUES (?, ?, ?, ?)').bind(umpire.id, name, email, t).run(); }
  else await db.prepare('UPDATE umpires SET name = ? WHERE id = ?').bind(name, umpire.id).run();

  const teamStmts = Object.entries(rep.teams || {}).map(([code, v]) =>
    db.prepare('INSERT INTO teams (code, short_name, full_name, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET short_name = excluded.short_name, full_name = excluded.full_name, updated_at = excluded.updated_at')
      .bind(code, String(v[0] || code).slice(0, 80), String(v[1] || code).slice(0, 120), t));
  if (teamStmts.length) await db.batch(teamStmts);

  const gameKey = g.GameID || `${g.Date}|${g.HomeTeam}|${g.AwayTeam}`;
  const existing = await db.prepare('SELECT id FROM games WHERE umpire_id = ? AND game_key = ?').bind(umpire.id, gameKey).first();
  const gameId = existing ? existing.id : token(9);
  await db.prepare(`INSERT INTO games (id, umpire_id, game_key, date, home, away, stadium, level, file, fields_json, pitches_json, created_at, adj, raw, decisions, misses, edge)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET date = excluded.date, home = excluded.home, away = excluded.away, stadium = excluded.stadium, level = excluded.level, file = excluded.file,
      fields_json = excluded.fields_json, pitches_json = excluded.pitches_json, adj = excluded.adj, raw = excluded.raw, decisions = excluded.decisions, misses = excluded.misses, edge = excluded.edge`)
    .bind(gameId, umpire.id, gameKey, g.Date, g.HomeTeam, g.AwayTeam, g.Stadium, g.Level, g.file, JSON.stringify(rep.fields), JSON.stringify(g.pitches), t,
      s.adj, s.raw, s.decisions, s.missN, s.edgeAcc).run();

  const reportId = token();
  await db.prepare('INSERT INTO reports (id, game_id, umpire_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)').bind(reportId, gameId, umpire.id, admin, t).run();
  const origin = new URL(request.url).origin;
  const url = `${origin}/r/${reportId}`;

  // PDF first, so the email can attach it
  let pdf = false, pdfNote = null;
  if (body.attachPdf !== false) {
    try { pdf = await buildAndStorePdf(env, origin, reportId); if (!pdf) pdfNote = 'PDF storage is not connected'; }
    catch (e) { pdfNote = e.message; }
  }
  await db.prepare('UPDATE reports SET pdf_status = ? WHERE id = ?').bind(pdf ? 'ready' : `skipped: ${pdfNote || 'off'}`, reportId).run();

  if (!env.RESEND_API_KEY) {
    await db.prepare('UPDATE reports SET email_status = ? WHERE id = ?').bind('not_configured', reportId).run();
    return json({ ok: true, url, emailed: false, pdf, note: 'Report saved. Email is not set up yet (RESEND_API_KEY is missing).' });
  }
  const teams = rep.teams || {};
  const tname = c => (teams[c] && teams[c][1]) || c;
  const msg = reportEmail({ name, url, pdf, game: { date: g.Date, home: tname(g.HomeTeam), away: tname(g.AwayTeam) }, s, hbp: A.hbp.length });
  const payload = { from: FROM, to: [email], reply_to: env.REPLY_TO || admin, subject: msg.subject, html: msg.html, text: msg.text };
  if (pdf) payload.attachments = [{ filename: `Plate Report - ${safeName(name)} - ${g.Date}.pdf`, path: `${url}/pdf` }];
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(payload)
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) {
    await db.prepare('UPDATE reports SET email_status = ? WHERE id = ?').bind(`error ${r.status}`, reportId).run();
    return json({ ok: false, url, emailed: false, pdf, error: `Report saved, but the email failed: ${out.message || r.status}` }, 502);
  }
  await db.prepare('UPDATE reports SET email_status = ?, email_id = ?, emailed_at = ? WHERE id = ?').bind('sent', out.id || null, now(), reportId).run();
  return json({ ok: true, url, emailed: true, pdf, pdfNote });
}

/* ---------------- report data ---------------- */
async function getReport(id, env) {
  if (!env.DB || !/^[A-Za-z0-9_-]{16,40}$/.test(id)) return json({ error: 'Report not found.' }, 404);
  await ensureSchema(env.DB);
  const rep = await env.DB.prepare(`SELECT r.id, r.game_id, g.date, u.id AS umpire_id, u.name AS umpire FROM reports r
    JOIN games g ON g.id = r.game_id JOIN umpires u ON u.id = r.umpire_id WHERE r.id = ?`).bind(id).first();
  if (!rep) return json({ error: 'Report not found.' }, 404);
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

/* ---------------- umpires (admin) ---------------- */
async function listUmpires(env) {
  const { results } = await env.DB.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.active, u.notes, u.tags, u.created_at,
      (SELECT COUNT(*) FROM games g WHERE g.umpire_id = u.id) AS games,
      (SELECT MAX(date) FROM games g WHERE g.umpire_id = u.id) AS last_game,
      (SELECT AVG(adj) FROM games g WHERE g.umpire_id = u.id AND adj IS NOT NULL) AS avg_adj,
      (SELECT adj FROM games g WHERE g.umpire_id = u.id ORDER BY date DESC, created_at DESC LIMIT 1) AS last_adj
    FROM umpires u ORDER BY u.active DESC, u.name COLLATE NOCASE`).all();
  return json({ umpires: results.map(u => ({ ...u, tags: parseTags(u.tags) })) });
}

async function getUmpire(id, env) {
  const u = await env.DB.prepare(`SELECT id, name, email, phone, active, notes, tags, created_at FROM umpires WHERE id = ?`).bind(id).first();
  if (!u) return json({ error: 'Umpire not found.' }, 404);
  const games = (await env.DB.prepare(`SELECT g.id, g.date, g.home, g.away, g.stadium, g.adj, g.raw, g.decisions, g.misses, g.edge,
      th.full_name AS home_name, ta.full_name AS away_name
    FROM games g LEFT JOIN teams th ON th.code = g.home LEFT JOIN teams ta ON ta.code = g.away
    WHERE g.umpire_id = ? ORDER BY g.date DESC, g.created_at DESC`).bind(id).all()).results;
  const reports = (await env.DB.prepare(`SELECT id, game_id, created_at, created_by, email_status, emailed_at, pdf_status FROM reports WHERE umpire_id = ? ORDER BY created_at DESC`).bind(id).all()).results;
  return json({ umpire: { ...u, tags: parseTags(u.tags) }, games, reports });
}

// Tags (conferences): stored as a JSON array, case-insensitive unique, max 12 per umpire
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
// Match new tags to the spelling already in use (so "wcc" becomes "WCC")
async function tagSpellings(env) {
  const m = new Map();
  for (const r of (await env.DB.prepare('SELECT tags FROM umpires WHERE tags IS NOT NULL').all()).results)
    for (const t of parseTags(r.tags)) if (!m.has(t.toLowerCase())) m.set(t.toLowerCase(), t);
  return m;
}
const canon = (tags, m) => cleanTags(tags.map(t => { const k = t.toLowerCase(); if (!m.has(k)) m.set(k, t); return m.get(k); }));
function cleanUmpire(o) {
  const name = String(o.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const email = String(o.email || '').trim().toLowerCase().slice(0, 200);
  const phone = String(o.phone || '').trim().slice(0, 40) || null;
  const notes = String(o.notes || '').trim().slice(0, 500) || null;
  return { name, email, phone, notes, tags: cleanTags(o.tags) };
}

async function upsertUmpire(env, o, spell) {
  const u = cleanUmpire(o);
  u.tags = canon(u.tags, spell || await tagSpellings(env));
  if (!u.name || !validEmail(u.email)) return { error: `Missing name or valid email${u.name ? ` for ${u.name}` : ''}.` };
  const ex = await env.DB.prepare('SELECT id, tags FROM umpires WHERE email = ?').bind(u.email).first();
  if (ex) {
    const tags = cleanTags([...parseTags(ex.tags), ...u.tags]); // add new conferences, keep existing ones
    await env.DB.prepare('UPDATE umpires SET name = ?, phone = COALESCE(?, phone), notes = COALESCE(?, notes), tags = ?, active = 1 WHERE id = ?').bind(u.name, u.phone, u.notes, JSON.stringify(tags), ex.id).run();
    return { id: ex.id, updated: true };
  }
  const id = token(9);
  await env.DB.prepare('INSERT INTO umpires (id, name, email, phone, notes, tags, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)').bind(id, u.name, u.email, u.phone, u.notes, JSON.stringify(u.tags), now()).run();
  return { id, created: true };
}

async function adminApi(request, env, path) {
  if (!env.DB) return json({ error: 'The database is not connected yet.' }, 503);
  if (!request.headers.get('cf-access-authenticated-user-email')) return json({ error: 'Sign in through Cloudflare Access.' }, 401);
  await ensureSchema(env.DB);
  const m = request.method;
  let body = null;
  if (m === 'POST' || m === 'PUT') { try { body = await request.json(); } catch { return json({ error: 'The request could not be read.' }, 400); } }

  if (path === '/admin/api/umpires' && m === 'GET') return listUmpires(env);
  if (path === '/admin/api/umpires' && m === 'POST') {
    const r = await upsertUmpire(env, body || {});
    return r.error ? json(r, 400) : json({ ok: true, ...r });
  }
  if (path === '/admin/api/umpires/import' && m === 'POST') {
    const rows = Array.isArray(body?.rows) ? body.rows.slice(0, 1000) : [];
    const rosterTags = cleanTags(body?.tag);
    const spell = await tagSpellings(env);
    let created = 0, updated = 0; const errors = [];
    for (const row of rows) {
      const r = await upsertUmpire(env, { ...row, tags: [...cleanTags(row.tags), ...rosterTags] }, spell);
      if (r.error) errors.push(r.error); else if (r.created) created++; else updated++;
    }
    return json({ ok: true, created, updated, errors });
  }
  const um = path.match(/^\/admin\/api\/umpires\/([A-Za-z0-9_-]+)$/);
  if (um && m === 'GET') return getUmpire(um[1], env);
  if (um && m === 'PUT') {
    const u = cleanUmpire(body || {});
    if (!u.name || !validEmail(u.email)) return json({ error: 'Enter a name and a valid email.' }, 400);
    u.tags = canon(u.tags, await tagSpellings(env));
    const clash = await env.DB.prepare('SELECT id FROM umpires WHERE email = ? AND id <> ?').bind(u.email, um[1]).first();
    if (clash) return json({ error: 'Another umpire already uses that email.' }, 409);
    await env.DB.prepare('UPDATE umpires SET name = ?, email = ?, phone = ?, notes = ?, tags = ?, active = ? WHERE id = ?')
      .bind(u.name, u.email, u.phone, u.notes, JSON.stringify(u.tags), body.active === false || body.active === 0 ? 0 : 1, um[1]).run();
    return json({ ok: true });
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
      if (p === '/admin/api/reports' && request.method === 'POST') return await saveReport(request, env, ctx);
      if (p.startsWith('/admin/api/')) return await adminApi(request, env, p);
    } catch (e) {
      return json({ error: `Something went wrong: ${e.message}` }, 500);
    }

    const m = p.match(/^\/api\/reports\/([A-Za-z0-9_-]+)$/);
    if (m && request.method === 'GET') return getReport(m[1], env);

    const pdf = p.match(/^\/r\/([A-Za-z0-9_-]+)\/pdf$/);
    if (pdf) return servePdf(pdf[1], env, url.origin);

    if (p.startsWith('/r/')) return env.ASSETS.fetch(new Request(new URL('/report', url), request));

    return env.ASSETS.fetch(request);
  }
};
