// Weekly staff email (Wednesdays). One for each coordinator (their conferences), one for the master admin (every conference).
// "This week" = games uploaded in the last 7 days whose game date is within the last 14 days, so a late upload from the weekend
// still shows up but a season import of old games does not.
import '../public/js/staff-stats.js';
import { shell, esc } from './email.js';
const S = globalThis.StaffStats;

const pct = v => v == null ? '–' : (v * 100).toFixed(1) + '%';
const pts = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(1);
const fmt = d => { const [y, m, day] = String(d).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); };
const title = g => g.home === g.away ? `${g.home_name || g.home} intrasquad` : `${g.away_name || g.away} at ${g.home_name || g.home}`;
const iso = ms => new Date(ms).toISOString();

// Pick this week's games. In a preview with nothing recent, fall back to the latest 7 days of games so the email can still be seen.
export function weekWindow(games, nowIso, preview) {
  const now = Date.parse(nowIso);
  const upFrom = iso(now - 7 * 86400000), dateFrom = iso(now - 14 * 86400000).slice(0, 10);
  let week = games.filter(g => (g.created_at || '') >= upFrom && g.date >= dateFrom);
  let sample = null;
  if (!week.length && preview && games.length) {
    const last = games.map(g => g.date).sort().at(-1);
    const from = iso(Date.parse(last + 'T12:00:00Z') - 6 * 86400000).slice(0, 10);
    week = games.filter(g => g.date >= from && g.date <= last);
    sample = { from, to: last };
  }
  return { week, sample, from: sample ? sample.from : iso(now - 7 * 86400000).slice(0, 10), to: sample ? sample.to : iso(now - 86400000).slice(0, 10) };
}

const stat = (label, value, sub = '') => `<td style="padding:12px 8px;text-align:center;border:1px solid #D9E1E8;border-radius:8px;background:#FFFFFF;width:33%">
  <div style="font:800 24px/1 Arial Narrow,Arial,sans-serif;color:#0D1117">${value}</div>
  <div style="font:12px/1.4 Arial,sans-serif;color:#5A6573;margin-top:4px">${esc(label)}</div>${sub ? `<div style="font:12px/1.4 Arial,sans-serif;color:#5A6573">${sub}</div>` : ''}</td>`;
const h = t => `<p style="margin:22px 0 8px;font:700 12px/1.3 Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#5A6573">${esc(t)}</p>`;
const rowsTable = rows => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font:14px/1.45 Arial,sans-serif">${rows.map(([l, r], i) =>
  `<tr><td style="padding:7px 0;${i ? 'border-top:1px solid #E6ECF1;' : ''}">${l}</td><td align="right" style="padding:7px 0 7px 10px;white-space:nowrap;${i ? 'border-top:1px solid #E6ECF1;' : ''}">${r}</td></tr>`).join('')}</table>`;
const button = (url, text) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px"><tr><td style="background:#0D1117;border-radius:10px">
  <a href="${esc(url)}" style="display:inline-block;padding:13px 22px;font:700 15px Arial,sans-serif;color:#FFFFFF;text-decoration:none">${esc(text)}</a></td></tr></table>`;

// data = dashboard payload for this person's scope. Returns null when there is nothing to report.
export function buildDigest({ data, name, confs, master, origin, nowIso, preview }) {
  const first = String(name || '').split(' ')[0] || 'Hi';
  const label = master ? 'All conferences' : confs.join(' · ');
  const scopeGames = S.selectGames(data.games, data.umpires, { confs: master ? null : confs }).games;
  const W = weekWindow(scopeGames, nowIso, preview);
  if (!W.week.length) return null;
  const season = S.seasonOf(W.week.map(g => g.date).sort().at(-1));
  const sel = S.selectGames(data.games, data.umpires, { season, confs: master ? null : confs });
  const seasonSum = S.summarize(sel.games, sel.byId, { trackSince: data.trackSince, now: nowIso });
  const weekIds = new Set(W.week.map(g => g.id));
  const weekGames = sel.games.filter(g => weekIds.has(g.id));
  const weekSum = S.summarize(weekGames, sel.byId, { trackSince: data.trackSince, now: nowIso });
  const nm = id => (sel.byId[id] || {}).name || 'Umpire';
  const range = `${fmt(W.from)}–${fmt(W.to)}`;

  let body = `<p style="margin:0 0 6px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#5A6573">Weekly staff report · ${esc(label)}</p>
    <h1 style="margin:0 0 4px;font:800 26px/1.1 Arial Narrow,Arial,sans-serif;text-transform:uppercase">Week of ${esc(range)}</h1>
    ${W.sample ? `<p style="margin:0 0 10px;color:#C7791A;font-size:13px">Preview: no games came in during the last 7 days, so this uses the latest week with games.</p>` : ''}
    <p style="margin:10px 0 16px">${esc(first)}, here's how your staff did. ${weekGames.length} new game${weekGames.length === 1 ? '' : 's'} from ${weekSum.umpires} umpire${weekSum.umpires === 1 ? '' : 's'} came in this week.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="6"><tr>
      ${stat('Adjusted this week', pct(weekSum.staffAdj), `Season ${pct(seasonSum.staffAdj)}`)}
      ${stat('Missed calls / game', weekSum.misses?.toFixed(1) ?? '–', `Season ${seasonSum.misses?.toFixed(1) ?? '–'}`)}
      ${stat('2-strike accuracy', pct(weekSum.twoStrike), `Season ${pct(seasonSum.twoStrike)}`)}
    </tr></table>`;

  // Master: conference by conference
  if (master) {
    const cs = [...new Map(data.umpires.flatMap(u => u.tags).map(t => [t.toLowerCase(), t])).values()].sort();
    const rows = cs.map(c => {
      const s2 = S.selectGames(data.games, data.umpires, { season, confs: [c] });
      const wk = s2.games.filter(g => weekIds.has(g.id));
      return { c, wk: wk.length, wAdj: S.avg(wk.map(g => g.adj)), sAdj: S.summarize(s2.games, s2.byId).staffAdj };
    }).filter(r => r.wk);
    if (rows.length) body += h('Conferences this week') + rowsTable([[`<b>Conference</b>`, `<b>Games · this week · season</b>`], ...rows.map(r => [esc(r.c), `${r.wk} · ${pct(r.wAdj)} · ${pct(r.sAdj)}`])]);
  }

  // Goals
  const goals = (data.goals || []).filter(g => master || confs.some(c => c.toLowerCase() === g.conference.toLowerCase()));
  if (goals.length) {
    body += h(`Goals · ${season} so far`) + rowsTable(goals.map(g => {
      const s2 = S.selectGames(data.games, data.umpires, { season, confs: [g.conference] });
      const p = S.goalProgress(g, S.summarize(s2.games, s2.byId));
      const status = p.cur == null ? 'No games yet' : p.met ? '<b style="color:#1F8A5B">✓ Reached</b>' : p.M.unit === '%' ? `${(p.gap * 100).toFixed(1)} pts to go` : `${p.gap.toFixed(1)} fewer per game to go`;
      return [`${esc(g.conference)} · ${esc(p.M.label)}<br><span style="color:#5A6573;font-size:12px">Goal ${p.M.fmt(p.target)} · now ${p.cur == null ? '–' : p.M.fmt(p.cur)}</span>`, status];
    }));
  }

  // Best games this week
  const best = [...weekGames].sort((a, b) => b.adj - a.adj).slice(0, 3);
  body += h('Best games this week') + rowsTable(best.map(g => [`<b>${esc(nm(g.umpire_id))}</b><br><span style="color:#5A6573;font-size:12px">${esc(title(g))} · ${fmt(g.date)}</span>`, `<b>${pct(g.adj)}</b>`]));

  // Improvers (season) and check-ins (this week's games)
  const imp = (seasonSum.spot?.improvers || []).slice(0, 3);
  if (imp.length) body += h(`On the rise · ${season}`) + rowsTable(imp.map(r => [`<b>${esc(r.u.name)}</b><br><span style="color:#5A6573;font-size:12px">Last ${r.recentN}: ${pct(r.recent)} · before: ${pct(r.before)} · ${r.n} games</span>`, `<b style="color:#1F8A5B">${pts(r.gain)}</b>`]));
  const watch = (seasonSum.spot?.watch || []).filter(r => weekIds.has(r.last.id)).slice(0, 4);
  if (watch.length) body += h('Worth a check-in') + rowsTable(watch.map(r => [`<b>${esc(r.u.name)}</b><br><span style="color:#5A6573;font-size:12px">${esc(title(r.last))} · ${fmt(r.last.date)}${r.drop <= -0.005 ? ` · ${pts(r.drop)} vs. their average` : ''}</span>`, pct(r.last.adj)]));

  // Where the misses happened this week
  if (weekSum.missMap && weekSum.missMap.total) {
    const M = weekSum.missMap, top = [...M.regions].sort((a, b) => b.share - a.share)[0];
    const worst = (weekSum.situations || []).filter(s => s.n >= 20).sort((a, b) => a.acc - b.acc)[0];
    body += h('Where the misses happened') + `<p style="margin:0">${M.total} missed calls this week: ${Math.round(M.scb / M.total * 100)}% strikes called balls, ${Math.round(M.bcs / M.total * 100)}% balls called strikes.
      The most came at the <b>${esc(top.label.toLowerCase())}</b> (${Math.round(top.share * 100)}%).${worst ? ` Toughest count: <b>${esc(worst.label.toLowerCase())}</b> at ${pct(worst.acc)}.` : ''}</p>`;
  }

  // Engagement for this week's emailed reports
  const sent = weekGames.filter(g => g.report && g.report.emailed_at && (!data.trackSince || g.report.emailed_at >= data.trackSince));
  if (sent.length) {
    const opened = sent.filter(g => g.report.first_opened_at);
    const not = sent.filter(g => !g.report.first_opened_at).slice(0, 5);
    body += h('Reports opened') + `<p style="margin:0">${opened.length} of ${sent.length} reports emailed this week have been opened.${not.length ? ` Not yet: ${not.map(g => esc(nm(g.umpire_id))).join(', ')}.` : ''}</p>`;
  }

  const dash = `${origin}${master ? '/admin/dashboard/' : '/coord/'}`;
  body += button(dash, 'Open the full dashboard');
  body += `<p style="margin:18px 0 0;font-size:12px;color:#5A6573">You get this every Wednesday when your staff has new games. ${master ? 'Coordinators get the same email for their own conferences.' : 'Ask the site admin to turn it off.'}</p>`;

  const subject = `${preview ? '[Preview] ' : ''}${label} weekly report: ${weekGames.length} game${weekGames.length === 1 ? '' : 's'}, ${pct(weekSum.staffAdj)} adjusted`;
  const text = `${label} weekly staff report, week of ${range}${W.sample ? ' (preview using the latest week with games)' : ''}

${weekGames.length} new games from ${weekSum.umpires} umpires.
Adjusted accuracy this week: ${pct(weekSum.staffAdj)} (season ${pct(seasonSum.staffAdj)})
Missed calls per game: ${weekSum.misses?.toFixed(1) ?? '–'} (season ${seasonSum.misses?.toFixed(1) ?? '–'})

Best games this week:
${best.map(g => `- ${nm(g.umpire_id)}, ${title(g)} (${fmt(g.date)}): ${pct(g.adj)}`).join('\n')}
${imp.length ? `\nOn the rise:\n${imp.map(r => `- ${r.u.name}: ${pts(r.gain)} (last ${r.recentN} vs. before)`).join('\n')}\n` : ''}${watch.length ? `\nWorth a check-in:\n${watch.map(r => `- ${r.u.name}: ${pct(r.last.adj)} on ${fmt(r.last.date)}`).join('\n')}\n` : ''}
Full dashboard: ${dash}`;
  return { subject, html: shell(body), text, games: weekGames.length };
}
