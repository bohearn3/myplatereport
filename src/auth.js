// Coordinator sign-in: 6-digit email codes and session cookies.
// The master admin does not use this; master access comes only from Cloudflare Access on /admin.

export const COOKIE = 'mpr_session';
const SESSION_DAYS = 30;
const CODE_MINUTES = 10;
const MAX_CODES_PER_15_MIN = 5;
const MAX_ATTEMPTS = 5;

const enc = new TextEncoder();
export async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const randomToken = (n = 32) => {
  const a = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const sixDigits = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
const isoIn = ms => new Date(Date.now() + ms).toISOString();

export function readCookie(request, name) {
  const h = request.headers.get('cookie') || '';
  for (const part of h.split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return v.join('='); }
  return null;
}
export const sessionCookie = (value, maxAge) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

// Start: always answers the same way, whether or not the email belongs to a coordinator.
export async function startLogin(db, email) {
  const c = await db.prepare('SELECT id, name, email FROM coordinators WHERE email = ? AND active = 1').bind(email).first();
  if (!c) return { send: false };
  const since = new Date(Date.now() - 15 * 60000).toISOString();
  const recent = await db.prepare('SELECT COUNT(*) AS n FROM login_codes WHERE email = ? AND created_at > ?').bind(email, since).first();
  if ((recent?.n || 0) >= MAX_CODES_PER_15_MIN) return { send: false, limited: true };
  const code = sixDigits();
  await db.prepare('DELETE FROM login_codes WHERE email = ? AND used = 0').bind(email).run();
  await db.prepare('INSERT INTO login_codes (email, code_hash, created_at, expires_at, attempts, used) VALUES (?, ?, ?, ?, 0, 0)')
    .bind(email, await sha256(`${email}:${code}`), new Date().toISOString(), isoIn(CODE_MINUTES * 60000)).run();
  return { send: true, code, coordinator: c };
}

export async function verifyLogin(db, email, code, userAgent) {
  const row = await db.prepare('SELECT rowid AS rid, code_hash, expires_at, attempts FROM login_codes WHERE email = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').bind(email).first();
  if (!row) return { error: 'That code has expired. Request a new one.' };
  if (row.expires_at < new Date().toISOString()) return { error: 'That code has expired. Request a new one.' };
  if (row.attempts >= MAX_ATTEMPTS) return { error: 'Too many tries. Request a new code.' };
  if ((await sha256(`${email}:${String(code || '').trim()}`)) !== row.code_hash) {
    await db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE rowid = ?').bind(row.rid).run();
    return { error: 'That code is not right. Check the email and try again.' };
  }
  const c = await db.prepare('SELECT id FROM coordinators WHERE email = ? AND active = 1').bind(email).first();
  if (!c) return { error: 'This account is not active.' };
  await db.prepare('UPDATE login_codes SET used = 1 WHERE rowid = ?').bind(row.rid).run();
  const tok = randomToken();
  await db.prepare('INSERT INTO sessions (id_hash, coordinator_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(tok), c.id, new Date().toISOString(), isoIn(SESSION_DAYS * 86400000), String(userAgent || '').slice(0, 200)).run();
  await db.prepare('UPDATE coordinators SET last_login = ? WHERE id = ?').bind(new Date().toISOString(), c.id).run();
  return { token: tok, maxAge: SESSION_DAYS * 86400 };
}

export async function sessionCoordinator(db, request) {
  const tok = readCookie(request, COOKIE);
  if (!tok) return null;
  const c = await db.prepare(`SELECT c.id, c.name, c.email, c.tier, c.conferences FROM sessions s JOIN coordinators c ON c.id = s.coordinator_id
    WHERE s.id_hash = ? AND s.expires_at > ? AND c.active = 1`).bind(await sha256(tok), new Date().toISOString()).first();
  return c || null;
}

export async function endSession(db, request) {
  const tok = readCookie(request, COOKIE);
  if (tok) await db.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256(tok)).run();
}
