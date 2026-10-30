// Staff-level math shared by the dashboard (browser) and the weekly email (Worker).
// Input: game rows as the /dashboard API returns them (stored per-game numbers only; no pitch data).
// game = { id, umpire_id, date, home, away, level, adj, raw, misses, edge, decisions, stats, home_conf, report }
(function (root) {
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const sd = a => { const m = avg(a); return a.length ? Math.sqrt(avg(a.map(v => (v - m) ** 2))) : null; };
  const MIN_GAMES = 3; // games an umpire needs before appearing in a ranking
  const seasonOf = d => { const [y, m] = String(d).split('-').map(Number); return m >= 8 ? `Fall ${y}` : `Spring ${y}`; };
  const seasonRank = s => { const [k, y] = s.split(' '); return +y * 10 + (k === 'Fall' ? 5 : 1); };
  const isScrim = g => (g.home && g.home === g.away) || /exclusive|undefined/i.test(g.level || '');
  const lc = s => String(s || '').toLowerCase();

  // Conference names: acronyms and full names are the same conference (MWC = Mountain West = Mountain West Conference).
  // confKey() turns any spelling into one comparison key; unknown names compare by their own lowercase spelling.
  const CONF_NAMES = {
    'MWC': ['Mountain West', 'Mountain West Conference', 'MW'], 'WCC': ['West Coast', 'West Coast Conference'],
    'PacWest': ['Pacific West', 'Pacific West Conference', 'Pac West', 'PWC'], 'RMAC': ['Rocky Mountain', 'Rocky Mountain Athletic Conference'],
    'Big West': ['Big West Conference', 'BWC'], 'Pac-12': ['Pac 12', 'Pac12', 'Pacific-12', 'Pacific 12', 'Pac-12 Conference'],
    'ACC': ['Atlantic Coast', 'Atlantic Coast Conference'], 'SEC': ['Southeastern', 'Southeastern Conference'],
    'Big Ten': ['Big 10', 'B1G', 'Big Ten Conference'], 'Big 12': ['Big12', 'Big XII', 'Big 12 Conference'], 'Big East': ['Big East Conference'],
    'Big South': ['Big South Conference'], 'American': ['AAC', 'American Athletic', 'American Athletic Conference', 'American Conference'],
    'America East': ['America East Conference', 'AEC'], 'ASUN': ['Atlantic Sun', 'Atlantic Sun Conference', 'ASUN Conference'],
    'A-10': ['A10', 'Atlantic 10', 'Atlantic Ten', 'Atlantic 10 Conference'], 'CAA': ['Coastal Athletic', 'Coastal Athletic Association', 'Colonial Athletic Association'],
    'C-USA': ['CUSA', 'Conference USA'], 'Horizon': ['Horizon League'], 'Ivy': ['Ivy League'], 'MAAC': ['Metro', 'Metro Atlantic', 'Metro Atlantic Athletic Conference'],
    'MAC': ['Mid-American', 'Mid American', 'Mid-American Conference'], 'MVC': ['Missouri Valley', 'Missouri Valley Conference', 'The Valley'],
    'NEC': ['Northeast Conference'], 'OVC': ['Ohio Valley', 'Ohio Valley Conference'], 'Patriot': ['Patriot League'], 'SoCon': ['Southern', 'Southern Conference'],
    'Southland': ['Southland Conference'], 'SWAC': ['Southwestern Athletic Conference'], 'Summit': ['Summit League', 'The Summit', 'The Summit League'],
    'Sun Belt': ['Sun Belt Conference', 'SBC'], 'UAC': ['United Athletic', 'United Athletic Conference'], 'WAC': ['Western Athletic', 'Western Athletic Conference'],
    'CCAA': ['California Collegiate Athletic Association'], 'GNAC': ['Great Northwest', 'Great Northwest Athletic Conference'],
    'LSC': ['Lone Star', 'Lone Star Conference'], 'GSC': ['Gulf South', 'Gulf South Conference'], 'NSIC': ['Northern Sun', 'Northern Sun Intercollegiate Conference'],
    'PSAC': ['Pennsylvania State Athletic Conference'], 'SAC': ['South Atlantic', 'South Atlantic Conference'], 'SSC': ['Sunshine State', 'Sunshine State Conference'],
    'CACC': ['Central Atlantic Collegiate Conference'], 'MIAA': ['Mid-America Intercollegiate Athletics Association'], 'NE10': ['NE-10', 'Northeast-10', 'Northeast-10 Conference', 'Northeast 10'],
    'G-MAC': ['GMAC', 'Great Midwest', 'Great Midwest Athletic Conference'], 'GLIAC': ['Great Lakes Intercollegiate Athletic Conference'],
    'GLVC': ['Great Lakes Valley', 'Great Lakes Valley Conference'], 'MEC': ['Mountain East', 'Mountain East Conference'], 'ECC': ['East Coast Conference'],
    'CIAA': ['Central Intercollegiate Athletic Association'], 'SIAC': ['Southern Intercollegiate Athletic Conference'], 'PBC': ['Peach Belt', 'Peach Belt Conference'],
    'GAC': ['Great American', 'Great American Conference'], 'Conference Carolinas': ['CC', 'Carolinas'],
    'SCIAC': ['Southern California Intercollegiate Athletic Conference'], 'NWC': ['Northwest Conference'], 'UAA': ['University Athletic Association'],
    'ODAC': ['Old Dominion Athletic Conference'], 'MIAA (Michigan)': ['Michigan Intercollegiate Athletic Association']
  };
  const squash = s => lc(s).replace(/[^a-z0-9]/g, '');
  const CONF_KEY = {};
  Object.entries(CONF_NAMES).forEach(([abbr, names]) => [abbr, ...names].forEach(n => { CONF_KEY[squash(n)] = squash(abbr); }));
  const confKey = s => { const k = squash(s); return CONF_KEY[k] || CONF_KEY[k.replace(/conference$/, '')] || k; };
  const confName = s => { const k = confKey(s); const hit = Object.entries(CONF_NAMES).find(([a]) => squash(a) === k); return hit ? hit[1].find(n => / Conference$| League$| Association$/.test(n)) || hit[1][0] : null; };

  const SITUATIONS = [['first', 'First pitch'], ['ahead', 'Pitcher ahead'], ['even', 'Even count'], ['behind', 'Hitter ahead'], ['two', '2 strikes'], ['three', '3 balls'], ['full', 'Full count']];
  const REGIONS = [['Top', 'Top of the zone'], ['Bottom', 'Bottom of the zone'], ['Inside', 'Inside edge'], ['Outside', 'Outside edge']];
  const METRICS = {
    adj: { label: 'Adjusted accuracy', unit: '%', better: 'higher', fmt: v => (v * 100).toFixed(1) + '%', parse: v => v / 100, show: v => +(v * 100).toFixed(1) },
    misses: { label: 'Missed calls per game', unit: '', better: 'lower', fmt: v => v.toFixed(1), parse: v => v, show: v => +v.toFixed(1) },
    edge: { label: 'Edge accuracy', unit: '%', better: 'higher', fmt: v => (v * 100).toFixed(1) + '%', parse: v => v / 100, show: v => +(v * 100).toFixed(1) },
    two: { label: '2-strike accuracy', unit: '%', better: 'higher', fmt: v => (v * 100).toFixed(1) + '%', parse: v => v / 100, show: v => +(v * 100).toFixed(1) }
  };

  // Which games a view counts. mode 'umpire': every game the roster's umpires worked; 'conference': only games hosted by the conference's teams.
  function selectGames(games, umpires, { season = 'all', scrim = true, confs = null, mode = 'umpire' } = {}) {
    const want = confs && confs.length ? new Set(confs.map(confKey)) : null;
    const ups = umpires.filter(u => !want || (u.tags || []).some(t => want.has(confKey(t))));
    const byId = Object.fromEntries(ups.map(u => [u.id, u]));
    const list = games.filter(g => byId[g.umpire_id] && g.adj != null && (season === 'all' || seasonOf(g.date) === season) && (scrim || !isScrim(g))
      && (mode !== 'conference' || (want ? want.has(confKey(g.home_conf)) : !!g.home_conf)));
    return { games: list, umpires: ups, byId };
  }

  const tallyAdd = (t, b) => { if (!b) return t; t.n += b.n || 0; t.ok += b.ok || 0; t.scb += b.scb || 0; t.bcs += b.bcs || 0; return t; };
  const blank = () => ({ n: 0, ok: 0, scb: 0, bcs: 0 });

  function summarize(games, byId, opts = {}) {
    const now = opts.now || null;
    games = [...games].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const out = { n: games.length };
    if (!games.length) return out;
    const per = {};
    games.forEach(g => (per[g.umpire_id] ||= []).push(g));
    const rows = Object.entries(per).map(([id, gs]) => {
      const adj = gs.map(g => g.adj), edge = gs.map(g => g.edge).filter(v => v != null), mis = gs.map(g => g.misses).filter(v => v != null);
      const recentN = gs.length >= 6 ? 3 : 2, recent = avg(adj.slice(-recentN)), before = avg(adj.slice(0, -recentN));
      let two = blank(); gs.forEach(g => { if (g.stats) { tallyAdd(two, g.stats.count.two); tallyAdd(two, g.stats.count.full); } });
      let fh = 0, fa = 0; gs.forEach(g => { const f = g.stats?.fair; if (f && !f.intra && f.home && f.away) { fh += f.home.helped + f.away.hurt; fa += f.away.helped + f.home.hurt; } });
      return { id, u: byId[id], n: gs.length, games: gs, adj: avg(adj), edge: avg(edge), mis: avg(mis), spread: sd(adj), recentN, recent, before,
        last: gs[gs.length - 1], prior: gs.length > 1 ? avg(adj.slice(0, -1)) : null, two: two.n ? two.ok / two.n : null, favorHome: fh, favorAway: fa };
    });
    const q = rows.filter(r => r.n >= MIN_GAMES);
    out.rows = rows; out.qualified = q.length; out.umpires = rows.length;
    out.staffAdj = avg(games.map(g => g.adj));
    out.misses = avg(games.map(g => g.misses).filter(v => v != null));
    out.edge = avg(games.map(g => g.edge).filter(v => v != null));
    out.elite = games.filter(g => g.adj >= 0.95).length;
    const lastDate = new Date(games[games.length - 1].date + 'T12:00Z'), cut = new Date(lastDate - 27 * 86400000).toISOString().slice(0, 10);
    const late = games.filter(g => g.date >= cut), early = games.filter(g => g.date < cut);
    out.delta4w = late.length >= 3 && early.length >= 3 ? avg(late.map(g => g.adj)) - avg(early.map(g => g.adj)) : null;
    out.firstDate = games[0].date; out.lastDate = games[games.length - 1].date;

    const top = (key, dir, k = 5) => [...q].filter(r => r[key] != null).sort((a, b) => dir * (a[key] - b[key]) || a.u.name.localeCompare(b.u.name)).slice(0, k);
    out.spot = {
      improvers: q.filter(r => r.before != null && r.recent - r.before > 0.001).map(r => ({ ...r, gain: r.recent - r.before })).sort((a, b) => b.gain - a.gain).slice(0, 5),
      top: top('adj', -1), edges: top('edge', -1), consistent: top('spread', 1), fewest: top('mis', 1),
      watch: rows.filter(r => r.prior != null && (r.last.adj - r.prior <= -0.03 || r.last.adj < 0.88)).map(r => ({ ...r, drop: r.last.adj - r.prior })).sort((a, b) => a.drop - b.drop).slice(0, 5),
      // umpires who would rank but have fewer than MIN_GAMES games, best first
      unranked: rows.filter(r => r.n < MIN_GAMES).sort((a, b) => b.adj - a.adj)
    };

    // Where the misses happen + situations + fairness, from stored per-game stats
    const withStats = games.filter(g => g.stats && g.stats.v);
    out.statsGames = withStats.length;
    if (withStats.length) {
      const all = blank(), reg = {}, cnt = {};
      REGIONS.forEach(([k]) => reg[k] = blank()); SITUATIONS.forEach(([k]) => cnt[k] = blank());
      let favorHome = 0, favorAway = 0, homeT = blank(), awayT = blank(), fairGames = 0;
      for (const g of withStats) {
        const s = g.stats; tallyAdd(all, s.all);
        REGIONS.forEach(([k]) => tallyAdd(reg[k], s.region[k])); SITUATIONS.forEach(([k]) => tallyAdd(cnt[k], s.count[k]));
        const f = s.fair;
        if (f && !f.intra && f.home && f.away) {
          fairGames++; favorHome += f.home.helped + f.away.hurt; favorAway += f.away.helped + f.home.hurt;
          homeT.n += f.home.n; homeT.ok += f.home.ok; awayT.n += f.away.n; awayT.ok += f.away.ok;
        }
      }
      const missAll = all.scb + all.bcs;
      out.missMap = {
        total: missAll, perGame: missAll / withStats.length, scb: all.scb, bcs: all.bcs, pitchAcc: all.n ? all.ok / all.n : null,
        regions: REGIONS.map(([k, label]) => { const t = reg[k], m = t.scb + t.bcs; return { key: k, label, n: t.n, miss: m, share: missAll ? m / missAll : 0, acc: t.n ? t.ok / t.n : null, scb: t.scb, bcs: t.bcs, perGame: m / withStats.length }; })
      };
      out.situations = SITUATIONS.map(([k, label]) => { const t = cnt[k]; return { key: k, label, n: t.n, acc: t.n ? t.ok / t.n : null, scb: t.scb, bcs: t.bcs }; });
      const twoT = tallyAdd(tallyAdd(blank(), cnt.two), cnt.full);
      out.twoStrike = twoT.n ? twoT.ok / twoT.n : null;
      out.fair = { games: fairGames, favorHome, favorAway, homeAcc: homeT.n ? homeT.ok / homeT.n : null, awayAcc: awayT.n ? awayT.ok / awayT.n : null,
        lopsided: q.filter(r => r.favorHome + r.favorAway >= 6).map(r => ({ ...r, net: r.favorHome - r.favorAway, share: r.favorHome / (r.favorHome + r.favorAway) })).filter(r => Math.abs(r.share - 0.5) >= 0.1).sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 3) };
    }

    // Report engagement (emailed reports only, since tracking began)
    const sent = games.filter(g => g.report && g.report.emailed_at && (!opts.trackSince || g.report.emailed_at >= opts.trackSince));
    if (sent.length) {
      const opened = sent.filter(g => g.report.first_opened_at);
      const nowIso = now || new Date().toISOString();
      const stale = sent.filter(g => !g.report.first_opened_at && (Date.parse(nowIso) - Date.parse(g.report.emailed_at)) > 2 * 86400000);
      out.engagement = { sent: sent.length, opened: opened.length, share: opened.length / sent.length,
        unopened: stale.sort((a, b) => a.report.emailed_at < b.report.emailed_at ? 1 : -1).slice(0, 6) };
    }
    return out;
  }

  function metricValue(metric, sum) {
    return metric === 'adj' ? sum.staffAdj : metric === 'misses' ? sum.misses : metric === 'edge' ? sum.edge : metric === 'two' ? sum.twoStrike : null;
  }
  function goalProgress(goal, sum) {
    const M = METRICS[goal.metric]; if (!M) return null;
    const cur = metricValue(goal.metric, sum);
    if (cur == null) return { M, cur: null, target: goal.target, met: false, gap: null };
    const met = M.better === 'higher' ? cur >= goal.target : cur <= goal.target;
    const gap = M.better === 'higher' ? goal.target - cur : cur - goal.target; // >0 = still to go
    return { M, cur, target: goal.target, met, gap };
  }

  const api = { confKey, confName, CONF_NAMES, MIN_GAMES, SITUATIONS, REGIONS, METRICS, seasonOf, seasonRank, isScrim, selectGames, summarize, goalProgress, metricValue, avg };
  root.StaffStats = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
