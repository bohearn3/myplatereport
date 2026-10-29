// Trend tiles and line charts for one umpire's games. Used by the roster card (admin/coordinators) and the umpire portal.
// games: newest first, each { id, date, home, away, home_name, away_name, level, adj, raw, misses, edge }
// reports: { gameId: reportId } so a dot can open that game's report.
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pct = v => v == null ? '–' : (v * 100).toFixed(1) + '%';
  const fmtDate = s => { if (!s) return '–'; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
  const isScrim = g => (g.home && g.home === g.away) || /exclusive|undefined/i.test(g.level || '');
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const title = g => g.home === g.away ? `${g.home_name || g.home} intrasquad` : `${g.away_name || g.away} at ${g.home_name || g.home}`;

  function lineChart(games, key, o) {
    const pts = games.map((g, i) => ({ g, i, v: g[key] })).filter(p => p.v != null);
    if (pts.length < 1) return '';
    const W = 380, H = 128, L = 34, R = 10, T = 12, B = 22;
    const vals = pts.map(p => p.v); let lo = Math.min(...vals), hi = Math.max(...vals);
    if (o.pct) { lo = Math.max(0, lo - .02); hi = Math.min(1, hi + .02); } else { lo = Math.max(0, lo - 2); hi = hi + 2; }
    if (hi - lo < (o.pct ? .04 : 4)) { const m = (hi + lo) / 2, h = o.pct ? .02 : 2; lo = m - h; hi = m + h; }
    const n = games.length, x = i => L + (n === 1 ? (W - L - R) / 2 : i * (W - L - R) / (n - 1)), y = v => T + (hi - v) * (H - T - B) / (hi - lo);
    const fmt = v => o.pct ? (v * 100).toFixed(o.dp ?? 0) + '%' : (Number.isInteger(v) ? v : v.toFixed(1));
    let g = '';
    for (let k = 0; k <= 3; k++) {
      const v = lo + (hi - lo) * k / 3, yy = y(v).toFixed(1);
      g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="var(--line)" stroke-width="1"/><text x="${L - 6}" y="${(+yy + 3.5).toFixed(1)}" text-anchor="end">${fmt(v)}</text>`;
    }
    const mean = avg(vals); g += `<line x1="${L}" x2="${W - R}" y1="${y(mean).toFixed(1)}" y2="${y(mean).toFixed(1)}" stroke="var(--muted)" stroke-dasharray="4 4" stroke-width="1"/>`;
    let lastM = ''; games.forEach((gm, i) => { const mo = new Date(gm.date + 'T12:00').toLocaleDateString('en-US', { month: 'short' }); if (mo !== lastM) { lastM = mo; g += `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${mo}</text>`; } });
    const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    if (pts.length > 1) g += `<path d="${d}" fill="none" stroke="var(--deep)" stroke-width="2" stroke-linejoin="round"/>`;
    if (o.second) { const p2 = games.map((gm, i) => ({ i, v: gm[o.second] })).filter(p => p.v != null); if (p2.length > 1) g += `<path d="${p2.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join('')}" fill="none" stroke="var(--powder)" stroke-width="1.5" stroke-dasharray="2 3"/>`; }
    pts.forEach(p => {
      const rep = o.reports[p.g.id], tip = `${p.g.date} · ${title(p.g)}: ${fmt(p.v)}`;
      const dot = `<circle cx="${x(p.i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4.2" fill="${isScrim(p.g) ? 'var(--surface)' : 'var(--deep)'}" stroke="var(--deep)" stroke-width="2"><title>${esc(tip)}</title></circle>`;
      g += rep ? `<a href="/r/${esc(rep)}" target="_blank" rel="noopener">${dot}</a>` : dot;
    });
    return `<div class="chart"><div class="ct">${o.title}<span>${o.note || ''}</span></div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title)} by game">${g}</svg></div>`;
  }

  // Returns { tiles, charts } as HTML, or null when there are no games.
  function render(gamesDesc, reports, opts = {}) {
    const games = [...gamesDesc].reverse();
    if (!games.length) return null;
    const their = opts.you ? 'your' : 'their';
    const adj = games.map(g => g.adj).filter(v => v != null), mis = games.map(g => g.misses).filter(v => v != null);
    const seasonAdj = avg(adj), last5 = avg(adj.slice(-5)), delta = last5 != null && seasonAdj != null ? last5 - seasonAdj : null;
    const scr = games.filter(isScrim).length, best = adj.length ? Math.max(...adj) : null;
    const arrow = delta == null || adj.length < 3 ? '' : Math.abs(delta) < .0025 ? ' <span class="d">steady</span>' : delta > 0 ? ` <span class="up">▲ ${(delta * 100).toFixed(1)}</span>` : ` <span class="down">▼ ${(Math.abs(delta) * 100).toFixed(1)}</span>`;
    const tiles = [
      ['Games tracked', games.length, scr ? `${games.length - scr} regular, ${scr} scrimmage` : `${fmtDate(games[0].date)} – ${fmtDate(games[games.length - 1].date)}`],
      ['Average adjusted', pct(seasonAdj), `Best ${pct(best)}`],
      ['Last 5 games', pct(last5) + arrow, adj.length >= 3 ? `vs. ${their} overall average` : 'More games needed for a trend'],
      ['Missed calls per game', mis.length ? avg(mis).toFixed(1) : '–', mis.length ? `Fewest ${Math.min(...mis)}, most ${Math.max(...mis)}` : '']
    ].map(([k, v, d]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join('');
    const charts =
      lineChart(games, 'adj', { title: 'Adjusted accuracy', note: 'dotted: raw', pct: true, dp: 0, second: 'raw', reports }) +
      lineChart(games, 'misses', { title: 'Missed calls', note: 'lower is better', reports }) +
      lineChart(games, 'edge', { title: 'Edge accuracy', note: 'pitches within 2" of the edge', pct: true, reports });
    return { tiles, charts };
  }

  window.MPRTrends = { render, isScrim, title, pct, fmtDate };
})();
