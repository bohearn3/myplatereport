// Email-code sign-in for conference coordinators and for umpires.
// The master admin does not use this; master access comes only from Cloudflare Access on /admin.
// Each kind of user has its own table of codes, its own sessions and its own cookie.

const SESSION_DAYS = 30;
const CODE_MINUTES = 10;
const MAX_CODES_PER_15_MIN = 5;
const MAX_ATTEMPTS = 5;

export const KINDS = {
  coord: { users: 'coordinators', codes: 'login_codes', sessions: 'sessions', idCol: 'coordinator_id', cookie: 'mpr_session', activeSql: 'active = 1' },
  ump: { users: 'umpires', codes: 'ump_codes', sessions: 'ump_sessions', idCol: 'umpire_id', cookie: 'mpr_ump', activeSql: 'active = 1 AND portal = 1' }
};

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
export const sessionCookie = (kind, value, maxAge) =>
  `${KINDS[kind].cookie}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

// Start: the caller answers the same way whether or not the email can sign in.
export async function startLogin(db, kind, email) {
  const K = KINDS[kind];
  const user = await db.prepare(`SELECT id, name, email FROM ${K.users} WHERE email = ? AND ${K.activeSql}`).bind(email).first();
  if (!user) return { send: false };
  const since = new Date(Date.now() - 15 * 60000).toISOString();
  const recent = await db.prepare(`SELECT COUNT(*) AS n FROM ${K.codes} WHERE email = ? AND created_at > ?`).bind(email, since).first();
  if ((recent?.n || 0) >= MAX_CODES_PER_15_MIN) return { send: false, limited: true };
  const code = sixDigits();
  await db.prepare(`DELETE FROM ${K.codes} WHERE email = ? AND used = 0`).bind(email).run();
  await db.prepare(`INSERT INTO ${K.codes} (email, code_hash, created_at, expires_at, attempts, used) VALUES (?, ?, ?, ?, 0, 0)`)
    .bind(email, await sha256(`${kind}:${email}:${code}`), new Date().toISOString(), isoIn(CODE_MINUTES * 60000)).run();
  return { send: true, code, user };
}

export async function verifyLogin(db, kind, email, code, userAgent) {
  const K = KINDS[kind];
  const row = await db.prepare(`SELECT rowid AS rid, code_hash, expires_at, attempts FROM ${K.codes} WHERE email = ? AND used = 0 ORDER BY created_at DESC LIMIT 1`).bind(email).first();
  if (!row || row.expires_at < new Date().toISOString()) return { error: 'That code has expired. Request a new one.' };
  if (row.attempts >= MAX_ATTEMPTS) return { error: 'Too many tries. Request a new code.' };
  if ((await sha256(`${kind}:${email}:${String(code || '').trim()}`)) !== row.code_hash) {
    await db.prepare(`UPDATE ${K.codes} SET attempts = attempts + 1 WHERE rowid = ?`).bind(row.rid).run();
    return { error: 'That code is not right. Check the email and try again.' };
  }
  const user = await db.prepare(`SELECT id FROM ${K.users} WHERE email = ? AND ${K.activeSql}`).bind(email).first();
  if (!user) return { error: 'This account is not active.' };
  await db.prepare(`UPDATE ${K.codes} SET used = 1 WHERE rowid = ?`).bind(row.rid).run();
  const tok = randomToken();
  await db.prepare(`INSERT INTO ${K.sessions} (id_hash, ${K.idCol}, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)`)
    .bind(await sha256(tok), user.id, new Date().toISOString(), isoIn(SESSION_DAYS * 86400000), String(userAgent || '').slice(0, 200)).run();
  await db.prepare(`UPDATE ${K.users} SET last_login = ? WHERE id = ?`).bind(new Date().toISOString(), user.id).run();
  return { token: tok, maxAge: SESSION_DAYS * 86400 };
}

export async function sessionUser(db, kind, request) {
  const K = KINDS[kind];
  const tok = readCookie(request, K.cookie);
  if (!tok) return null;
  return await db.prepare(`SELECT u.* FROM ${K.sessions} s JOIN ${K.users} u ON u.id = s.${K.idCol}
    WHERE s.id_hash = ? AND s.expires_at > ? AND u.${K.activeSql.replace(/ AND /g, ' AND u.')}`).bind(await sha256(tok), new Date().toISOString()).first() || null;
}

export async function endSession(db, kind, request) {
  const K = KINDS[kind];
  const tok = readCookie(request, K.cookie);
  if (tok) await db.prepare(`DELETE FROM ${K.sessions} WHERE id_hash = ?`).bind(await sha256(tok)).run();
}
