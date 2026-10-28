// MyPlateReport — Cloudflare Worker.
// Public:  /            home page          /r/<id>            private report link
//          /api/reports/<id>   report data for the report page
// Admin (behind Cloudflare Access on /admin):
//          /admin/                upload page   POST /admin/api/reports   save + email

import '../public/js/engine.js';
import { reportEmail } from './email.js';

const E = globalThis.UmpEngine;
const FROM = 'MyPlateReport <reports@myplatereport.com>';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS umpires (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS teams (code TEXT PRIMARY KEY, short_name TEXT, full_name TEXT, updated_at TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, umpire_id TEXT NOT NULL, game_key TEXT, date TEXT, home TEXT, away TEXT, stadium TEXT, level TEXT, file TEXT, fields_json TEXT NOT NULL, pitches_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (umpire_id, game_key))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, umpire_id TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, email_status TEXT, email_id TEXT, emailed_at TEXT)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS games_umpire_date ON games (umpire_id, date)`)
  ]);
  schemaReady = true;
}

const token = (n = 18) => {
  const a = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const now = () => new Date().toISOString();
const validEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s || '');

async function saveReport(request, env) {
  if (!env.DB) return json({ error: 'The database is not connected yet.' }, 503);
  // Cloudflare Access adds this header after a successful sign-in.
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

  // Score on the server too, so the email numbers come from the same engine.
  const A = E.analyzeGame({ ...g, umpire: name }, rep.fields, E.ZONES.nsi2027);

  const db = env.DB; await ensureSchema(db);
  const t = now();
  let umpire = await db.prepare('SELECT id FROM umpires WHERE email = ?').bind(email).first();
  if (!umpire) { umpire = { id: token(9) }; await db.prepare('INSERT INTO umpires (id, name, email, created_at) VALUES (?, ?, ?, ?)').bind(umpire.id, name, email, t).run(); }
  else await db.prepare('UPDATE umpires SET name = ? WHERE id = ?').bind(name, umpire.id).run();

  const teamStmts = Object.entries(rep.teams || {}).map(([code, v]) =>
    db.prepare('INSERT INTO teams (code, short_name, full_name, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET short_name = excluded.short_name, full_name = excluded.full_name, updated_at = excluded.updated_at')
      .bind(code, String(v[0] || code).slice(0, 80), String(v[1] || code).slice(0, 120), t));
  if (teamStmts.length) await db.batch(teamStmts);

  // Re-uploading the same game for the same umpire replaces it rather than duplicating it.
  const gameKey = g.GameID || `${g.Date}|${g.HomeTeam}|${g.AwayTeam}`;
  const existing = await db.prepare('SELECT id FROM games WHERE umpire_id = ? AND game_key = ?').bind(umpire.id, gameKey).first();
  const gameId = existing ? existing.id : token(9);
  await db.prepare(`INSERT INTO games (id, umpire_id, game_key, date, home, away, stadium, level, file, fields_json, pitches_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET date = excluded.date, home = excluded.home, away = excluded.away, stadium = excluded.stadium, level = excluded.level, file = excluded.file, fields_json = excluded.fields_json, pitches_json = excluded.pitches_json`)
    .bind(gameId, umpire.id, gameKey, g.Date, g.HomeTeam, g.AwayTeam, g.Stadium, g.Level, g.file, JSON.stringify(rep.fields), JSON.stringify(g.pitches), t).run();

  const reportId = token();
  await db.prepare('INSERT INTO reports (id, game_id, umpire_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)').bind(reportId, gameId, umpire.id, admin, t).run();
  const url = new URL(`/r/${reportId}`, request.url).toString();

  // Email
  if (!env.RESEND_API_KEY) {
    await db.prepare('UPDATE reports SET email_status = ? WHERE id = ?').bind('not_configured', reportId).run();
    return json({ ok: true, url, emailed: false, note: 'Report saved. Email is not set up yet (RESEND_API_KEY is missing).' });
  }
  const teams = rep.teams || {};
  const tname = c => (teams[c] && teams[c][1]) || c;
  const msg = reportEmail({ name, url, game: { date: g.Date, home: tname(g.HomeTeam), away: tname(g.AwayTeam) }, s: A.summary, hbp: A.hbp.length });
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [email], reply_to: env.REPLY_TO || admin, subject: msg.subject, html: msg.html, text: msg.text })
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) {
    await db.prepare('UPDATE reports SET email_status = ? WHERE id = ?').bind(`error ${r.status}`, reportId).run();
    return json({ ok: false, url, emailed: false, error: `Report saved, but the email failed: ${out.message || r.status}` }, 502);
  }
  await db.prepare('UPDATE reports SET email_status = ?, email_id = ?, emailed_at = ? WHERE id = ?').bind('sent', out.id || null, now(), reportId).run();
  return json({ ok: true, url, emailed: true });
}

async function getReport(id, env) {
  if (!env.DB || !/^[A-Za-z0-9_-]{16,40}$/.test(id)) return json({ error: 'Report not found.' }, 404);
  await ensureSchema(env.DB);
  const rep = await env.DB.prepare(`SELECT r.id, r.game_id, g.date, u.id AS umpire_id, u.name AS umpire FROM reports r
    JOIN games g ON g.id = r.game_id JOIN umpires u ON u.id = r.umpire_id WHERE r.id = ?`).bind(id).first();
  if (!rep) return json({ error: 'Report not found.' }, 404);
  // This umpire's games up to and including this one, oldest first (season trends).
  const { results } = await env.DB.prepare(`SELECT id, game_key, date, home, away, stadium, level, file, fields_json, pitches_json FROM games
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
  return json({ fields, currentFile: rep.game_id, games, teams });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/api/health') return json({ ok: true, db: !!env.DB, email: !!env.RESEND_API_KEY, time: now() });

    if (p === '/admin/api/reports' && request.method === 'POST') {
      try { return await saveReport(request, env); }
      catch (e) { return json({ error: `Something went wrong saving the report: ${e.message}` }, 500); }
    }

    const m = p.match(/^\/api\/reports\/([A-Za-z0-9_-]+)$/);
    if (m && request.method === 'GET') return getReport(m[1], env);

    if (p.startsWith('/r/')) return env.ASSETS.fetch(new Request(new URL('/report', url), request));

    return env.ASSETS.fetch(request);
  }
};
