// School directory (D1 + D2, conference by season) and matching Trackman team codes to schools.
// Season = the spring season year: games from August on count toward the next season (fall scrimmages use next year's conferences).
import DIR from './data/schools.json' with { type: 'json' };

export const SEASONS = DIR.seasons.map(Number);
export const CONFERENCES = DIR.conferences;
export const SCHOOLS = DIR.schools;
const byShort = new Map(SCHOOLS.map(s => [s.short, s]));
export const schoolByShort = short => byShort.get(short) || null;

export function seasonYear(date) {
  const [y, m] = String(date || '').split('-').map(Number);
  return m >= 8 ? y + 1 : y;
}
// The directory season to use for a game year: exact, else the closest one we have.
function dirSeason(year) {
  if (SEASONS.includes(year)) return String(year);
  return String(year > Math.max(...SEASONS) ? Math.max(...SEASONS) : Math.min(...SEASONS));
}
export function schoolSeason(short, year) {
  const s = byShort.get(short); if (!s) return null;
  return s.seasons[dirSeason(year)] || null; // { conf, div }
}

const norm = s => String(s || '').toLowerCase()
  .replace(/[’'`.]/g, '').replace(/&/g, ' and ').replace(/[–—-]/g, ' ').replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\bsaint\b/g, 'st').replace(/\s+/g, ' ').trim();
const variantsOf = s => {
  const v = new Set([s.short, ...(s.aliases || []), s.name]);
  const n = s.name.replace(/^(The )?University of (the )?/, '').replace(/ (University|College)$/, '').replace(/^(The )/, '');
  v.add(n);
  return [...v].map(norm).filter(x => x.length >= 3);
};
// Former names Trackman still uses in team codes or names.
const FORMER = { 'Utah Tech': ['Dixie State', 'Dixie'] };
// Trackman codes that don't follow the school + nickname pattern.
const CODE_ALIASES = { DIX_STE: 'Utah Tech' };
const GENERIC = new Set(['california', 'colorado', 'texas', 'florida', 'georgia', 'missouri', 'oklahoma', 'washington', 'pennsylvania', 'virginia', 'minnesota', 'michigan']);
const INDEX = SCHOOLS.map(s => ({ s, vars: [...variantsOf(s), ...(FORMER[s.short] || []).map(norm)], nick: s.nickname ? norm(s.nickname) : null }));

// Returns { short, how } or null. how: 'name' (team name matched a school name + nickname), 'prefix' (name starts with a school name), 'code'.
export function matchSchool({ code, short_name, full_name } = {}) {
  const names = [full_name, short_name].map(norm).filter(Boolean);
  let best = null, tie = false;
  const offer = (s, score, how) => { if (!best || score > best.score) { best = { s, score, how }; tie = false; } else if (score === best.score && best.s !== s) tie = true; };
  for (const f of names) {
    for (const { s, vars, nick } of INDEX) {
      for (const v of vars) {
        if (nick && (f === `${v} ${nick}`)) offer(s, 1000 + v.length, 'name');
        else if (f === v) offer(s, 900 + v.length, 'name');
        // Name starts with a school name: for D1 (nickname known) the nickname must match too; for D2 the school name must be distinctive.
        else if (f.startsWith(v + ' ')) {
          if (nick) { if (f.endsWith(' ' + nick)) offer(s, 800 + v.length, 'prefix'); }
          else if (v.length >= 5 && !GENERIC.has(v)) offer(s, 500 + v.length, 'prefix');
        }
      }
    }
    if (best && !tie) return { short: best.s.short, how: best.how };
  }
  const known = CODE_ALIASES[String(code || '').toUpperCase().replace(/\d+$/, '')];
  if (known && byShort.has(known)) return { short: known, how: 'code' };
  // Trackman codes look like SAN_TOR: first letters of the school + first letters of the nickname.
  const m = String(code || '').toLowerCase().match(/^([a-z]{2,6})_([a-z]{2,4})$/);
  if (m) {
    const hits = INDEX.filter(({ vars, nick }) => nick && nick.replace(/ /g, '').startsWith(m[2]) && vars.some(v => v.replace(/ /g, '').startsWith(m[1])));
    if (hits.length === 1) return { short: hits[0].s.short, how: 'code' };
  }
  return null;
}
