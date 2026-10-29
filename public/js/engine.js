/* BB Umpire Report — scoring engine. Pure functions; runs in browser and Node.
   All coordinates in inches, ball-center, from Trackman PlateLocSide/PlateLocHeight.
   Trackman side: positive = toward the right-handed batter's box. */
(function (root) {
  const ZONES = {
    nsi2027: {
      id: 'nsi2027', label: '2027 NSI Static Zone', short: '2027 NSI',
      note: '19" wide, 24%–56% of a 73" batter, 1.47" ball radius, 1" buffer split ½" inside / ½" outside each edge.',
      zone:  { x: 10.97, bot: 16.05, top: 42.35 },
      outer: { x: 11.47, bot: 15.55, top: 42.85 },
      inner: { x: 10.47, bot: 16.55, top: 41.85 }
    },
    legacy2026: {
      id: 'legacy2026', label: '2026 Zone (current Excel)', short: '2026',
      note: 'Zone ±9.97" × 18.00–40.53"; strikes inside the outer buffer (±11.97" × 16.53–42.00") are not counted as misses.',
      zone:  { x: 9.969996, bot: 18.0, top: 40.53 },
      outer: { x: 11.97, bot: 16.53, top: 42.0 },
      inner: { x: 9.969996, bot: 18.0, top: 40.53 }
    }
  };
  const EDGE_BAND = 2.0; // inches either side of the zone edge = "edge pitch"

  const inBox = (p, b) => Math.abs(p.x) <= b.x && p.y >= b.bot && p.y <= b.top;

  // signed distance to zone rectangle: >0 outside (inches off edge), <0 inside (depth)
  function edgeDist(p, z) {
    const dx = Math.abs(p.x) - z.x, dyT = p.y - z.top, dyB = z.bot - p.y;
    const dy = Math.max(dyT, dyB);
    if (dx <= 0 && dy <= 0) return Math.max(dx, dy);
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  }
  // which edge the pitch is nearest/beyond, relative to the batter
  function region(p, z, side) {
    const dx = Math.abs(p.x) - z.x, dyT = p.y - z.top, dyB = z.bot - p.y;
    const m = Math.max(dx, dyT, dyB);
    if (m === dyT) return 'Top';
    if (m === dyB) return 'Bottom';
    const towardBatter = side === 'Right' ? p.side > 0 : p.side < 0;
    return towardBatter ? 'Inside' : 'Outside';
  }

  function normalize(fields, rows) {
    const ix = Object.fromEntries(fields.map((f, i) => [f, i]));
    return rows.map(r => {
      const g = k => r[ix[k]];
      const s = g('PlateLocSide'), h = g('PlateLocHeight');
      const has = typeof s === 'number' && typeof h === 'number';
      const call0 = g('PitchCall');
      return {
        no: g('PitchNo'), inning: g('Inning'), half: g('Top/Bottom'), pa: g('PAofInning'), pitchOfPA: g('PitchofPA'),
        outs: g('Outs'), balls: g('Balls'), strikes: g('Strikes'),
        pitcher: g('Pitcher'), throws: g('PitcherThrows'), pTeam: g('PitcherTeam'),
        batter: g('Batter'), bSide: g('BatterSide'), bTeam: g('BatterTeam'),
        type: g('TaggedPitchType'), call: call0, korbb: g('KorBB'), result: g('PlayResult'),
        velo: g('RelSpeed'),
        has, side: has ? s * 12 : null, x: has ? -s * 12 : null, y: has ? h * 12 : null
      };
    });
  }

  // decision: 'S' | 'B' | null.  BallinDirt counts as a called ball.
  const decisionOf = c => c === 'StrikeCalled' ? 'S' : (c === 'BallCalled' || c === 'BallinDirt') ? 'B' : null;

  function classify(p, Z) {
    const d = decisionOf(p.call);
    const o = { ...p, dec: d };
    if (!p.has) return o;
    const pt = { x: p.x, y: p.y };
    o.inZone = inBox(pt, Z.zone);
    o.inBand = inBox(pt, Z.outer) && !inBox(pt, Z.inner);
    o.dist = edgeDist(pt, Z.zone);
    o.edge = Math.abs(o.dist) <= EDGE_BAND;
    o.region = region(p, Z.zone, p.bSide);
    if (d) {
      o.rawOK = d === 'S' ? o.inZone : !o.inZone;
      o.adjOK = o.rawOK || o.inBand;
      o.missType = o.adjOK ? null : (d === 'B' ? 'strikeCalledBall' : 'ballCalledStrike');
      o.rawMissType = o.rawOK ? null : (d === 'B' ? 'strikeCalledBall' : 'ballCalledStrike');
    }
    return o;
  }

  const pct = (a, b) => b ? a / b : null;

  function summarize(ps) {
    const dec = ps.filter(p => p.dec && p.has);
    const S = dec.filter(p => p.dec === 'S'), B = dec.filter(p => p.dec === 'B');
    const inZ = dec.filter(p => p.inZone), outZ = dec.filter(p => !p.inZone);
    const edge = dec.filter(p => p.edge);
    const misses = dec.filter(p => !p.adjOK);
    return {
      decisions: dec.length, strikes: S.length, balls: B.length,
      rawCorrect: dec.filter(p => p.rawOK).length, adjCorrect: dec.filter(p => p.adjOK).length,
      raw: pct(dec.filter(p => p.rawOK).length, dec.length),
      adj: pct(dec.filter(p => p.adjOK).length, dec.length),
      inZoneN: inZ.length, inZoneOK: inZ.filter(p => p.adjOK).length, inZoneAcc: pct(inZ.filter(p => p.adjOK).length, inZ.length),
      outZoneN: outZ.length, outZoneOK: outZ.filter(p => p.adjOK).length, outZoneAcc: pct(outZ.filter(p => p.adjOK).length, outZ.length),
      edgeN: edge.length, edgeOK: edge.filter(p => p.adjOK).length, edgeAcc: pct(edge.filter(p => p.adjOK).length, edge.length),
      edgeStrikeRate: pct(edge.filter(p => p.dec === 'S').length, edge.length),
      missN: misses.length,
      scb: misses.filter(p => p.missType === 'strikeCalledBall').length,
      bcs: misses.filter(p => p.missType === 'ballCalledStrike').length,
      rawMissN: dec.filter(p => !p.rawOK).length,
      bid: ps.filter(p => p.call === 'BallinDirt').length,
      untracked: ps.filter(p => p.dec && !p.has).length
    };
  }

  // Kernel-smoothed strike probability -> perceived zone
  function perceived(ps, Z, opts = {}) {
    const bw = opts.bw || 3.0, alpha = opts.alpha || 0.35, step = opts.step || 1;
    const x0 = -24, x1 = 24, y0 = 4, y1 = 58;
    const nx = Math.round((x1 - x0) / step) + 1, ny = Math.round((y1 - y0) / step) + 1;
    const pts = ps.filter(p => p.dec && p.has);
    const grid = new Float64Array(nx * ny);
    const k2 = 2 * bw * bw;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const gx = x0 + i * step, gy = y0 + j * step;
      let w = 0, s = 0;
      for (const p of pts) {
        const d2 = (p.x - gx) ** 2 + (p.y - gy) ** 2;
        if (d2 > 9 * k2) continue;
        const wt = Math.exp(-d2 / k2); w += wt; if (p.dec === 'S') s += wt;
      }
      const prior = inBox({ x: gx, y: gy }, Z.zone) ? 1 : 0;
      grid[j * nx + i] = (s + alpha * prior) / (w + alpha);
    }
    const P = (gx, gy) => {
      const i = Math.round((gx - x0) / step), j = Math.round((gy - y0) / step);
      if (i < 0 || j < 0 || i >= nx || j >= ny) return 0;
      return grid[j * nx + i];
    };
    // edge crossings, averaged across a few scan lines
    const midY = (Z.zone.top + Z.zone.bot) / 2;
    const scan = (fx, fy, from, dir, lim) => { let t = from; while (Math.abs(t) < lim && P(fx(t), fy(t)) >= 0.5) t += dir * 0.5; return t; };
    const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
    const ys = [midY - 6, midY - 3, midY, midY + 3, midY + 6], xs = [-5, -2.5, 0, 2.5, 5];
    // umpire-view left (x<0) = 3B side; right (x>0) = 1B side
    const left = -avg(ys.map(y => scan(t => t, () => y, 0, -1, 24)));
    const right = avg(ys.map(y => scan(t => t, () => y, 0, 1, 24)));
    const top = avg(xs.map(x => scan(() => x, t => t, midY, 1, 58)));
    const bot = avg(xs.map(x => scan(() => x, t => t, midY, -1, 58)));
    let area = 0; for (let k = 0; k < grid.length; k++) if (grid[k] >= 0.5) area += step * step;
    const ruleArea = (2 * Z.zone.x) * (Z.zone.top - Z.zone.bot);
    return {
      grid: Array.from(grid, v => Math.round(v * 1000) / 1000), nx, ny, x0, y0, step, n: pts.length,
      edges: { left, right, top, bot },
      delta: { left: left - Z.zone.x, right: right - Z.zone.x, top: top - Z.zone.top, bot: Z.zone.bot - bot },
      areaRatio: area / ruleArea
    };
  }

  // Home vs. visitor pitching. Intrasquad games (same team on both sides) split by half instead:
  // top-half pitchers vs. bottom-half pitchers.
  function fairness(ps, home, away) {
    const intra = home && home === away;
    const groups = intra
      ? [{ key: 'Top', test: p => p.half === 'Top', intra: true }, { key: 'Bottom', test: p => p.half !== 'Top', intra: true }]
      : [{ key: home, test: p => p.pTeam === home }, { key: away, test: p => p.pTeam === away }];
    const teams = groups.map(({ key, test, intra }) => {
      const team = key;
      const mine = ps.filter(test);
      const s = summarize(mine);
      const dec = mine.filter(p => p.dec && p.has);
      return {
        team, intra: !!intra, ...s,
        helped: dec.filter(p => p.missType === 'ballCalledStrike').length, // favored this team's pitchers
        hurt: dec.filter(p => p.missType === 'strikeCalledBall').length
      };
    });
    return teams;
  }

  function breakdowns(ps) {
    const dec = ps.filter(p => p.dec && p.has);
    const grp = (keyFn, order) => {
      const m = new Map();
      for (const p of dec) { const k = keyFn(p); if (k == null) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(p); }
      const keys = order ? order.filter(k => m.has(k)) : [...m.keys()].sort((a, b) => m.get(b).length - m.get(a).length);
      return keys.map(k => { const a = m.get(k); return { key: k, n: a.length, ok: a.filter(p => p.adjOK).length, acc: pct(a.filter(p => p.adjOK).length, a.length), miss: a.filter(p => !p.adjOK).length }; });
    };
    return {
      region: grp(p => p.edge ? p.region : null, ['Top', 'Bottom', 'Inside', 'Outside']),
      count: grp(p => p.strikes === 2 && p.balls === 3 ? 'Full count' : p.strikes === 2 ? '2 strikes' : p.balls === 3 ? '3 balls' : 'Other counts', ['2 strikes', '3 balls', 'Full count', 'Other counts']),
      side: grp(p => p.bSide === 'Left' ? 'Left-handed batters' : p.bSide === 'Right' ? 'Right-handed batters' : null, ['Left-handed batters', 'Right-handed batters']),
      type: grp(p => p.type && p.type !== 'Undefined' ? p.type : null)
    };
  }

  function hbpReview(ps, home, away) {
    const hbps = ps.filter(p => p.call === 'HitByPitch');
    const halfIdx = p => p.inning * 2 + (p.half === 'Bottom' ? 1 : 0);
    return hbps.map((p, i) => {
      const flags = [];
      if (p.has && p.inZone) flags.push({ k: 'zone', t: 'Crossed the strike zone' });
      if (p.has && p.y >= 44 && (p.bSide === 'Right' ? p.side > 0 : p.side < 0)) flags.push({ k: 'up', t: 'Up and in' });
      const priorSameP = hbps.slice(0, i).filter(q => q.pitcher === p.pitcher).length;
      const priorSameT = hbps.slice(0, i).filter(q => q.pTeam === p.pTeam).length;
      if (priorSameP) flags.push({ k: 'repeat', t: `Pitcher's ${priorSameP + 1}${['', '', 'nd', 'rd'][priorSameP + 1] || 'th'} HBP` });
      else if (priorSameT) flags.push({ k: 'repeat', t: `Team's ${priorSameT + 1}${['', '', 'nd', 'rd'][priorSameT + 1] || 'th'} HBP` });
      const opp = hbps.slice(0, i).filter(q => q.pTeam !== p.pTeam && halfIdx(p) - halfIdx(q) >= 1 && halfIdx(p) - halfIdx(q) <= 2);
      if (opp.length) flags.push({ k: 'retal', t: `Follows ${opp[opp.length - 1].pTeam === home ? 'home' : 'visiting'} HBP (inn. ${opp[opp.length - 1].inning})` });
      return { ...p, flags };
    });
  }

  function analyzeGame(game, fields, Z) {
    const ps = normalize(fields, game.pitches).map(p => classify(p, Z));
    const home = game.HomeTeam, away = game.AwayTeam;
    return {
      meta: { date: game.Date, home, away, stadium: game.Stadium, umpire: game.umpire, file: game.file },
      pitches: ps, total: ps.length,
      summary: summarize(ps),
      fair: fairness(ps, home, away),
      br: breakdowns(ps),
      hbp: hbpReview(ps, home, away),
      ballIntentional: ps.filter(p => p.call === 'BallIntentional').length
    };
  }

  // Compact per-game numbers stored with each game for the staff dashboard and weekly email.
  // Every bucket is { n: decisions, ok: correct after the buffer, scb: strikes called balls, bcs: balls called strikes }.
  function gameStats(A) {
    const dec = A.pitches.filter(p => p.dec && p.has);
    const tally = list => ({ n: list.length, ok: list.filter(p => p.adjOK).length, scb: list.filter(p => p.missType === 'strikeCalledBall').length, bcs: list.filter(p => p.missType === 'ballCalledStrike').length });
    const by = (keyFn, keys) => Object.fromEntries(keys.map(k => [k, tally(dec.filter(p => keyFn(p) === k))]));
    const sit = p => p.balls === 0 && p.strikes === 0 ? 'first' : p.strikes === 2 && p.balls === 3 ? 'full' : p.strikes === 2 ? 'two' : p.balls === 3 ? 'three' : p.balls > p.strikes ? 'behind' : p.strikes > p.balls ? 'ahead' : 'even';
    const f = A.fair, home = A.meta.home, away = A.meta.away;
    const intra = !!(home && home === away);
    const team = t => t ? { n: t.decisions, ok: t.adjCorrect, helped: t.helped, hurt: t.hurt } : null;
    return {
      v: 1,
      all: tally(dec),
      zone: { in: tally(dec.filter(p => p.inZone)), out: tally(dec.filter(p => !p.inZone)), edge: tally(dec.filter(p => p.edge)) },
      region: by(p => p.region, ['Top', 'Bottom', 'Inside', 'Outside']),
      count: by(sit, ['first', 'ahead', 'even', 'behind', 'two', 'three', 'full']),
      batter: by(p => p.bSide, ['Left', 'Right']),
      fair: intra ? { intra: true } : { intra: false, home: team(f.find(t => t.team === home)), away: team(f.find(t => t.team === away)) }
    };
  }

  function trendPoint(A, Z) {
    const pz = perceived(A.pitches, Z, { step: 1 });
    const f = A.fair; const s = A.summary;
    return {
      date: A.meta.date, label: `${A.meta.away} @ ${A.meta.home}`,
      adj: s.adj, raw: s.raw, missN: s.missN, edgeAcc: s.edgeAcc, inZoneAcc: s.inZoneAcc, outZoneAcc: s.outZoneAcc,
      zoneSize: pz.areaRatio,
      balance: Math.abs((f[0].helped - f[0].hurt) - (f[1].helped - f[1].hurt)),
      decisions: s.decisions
    };
  }

  root.UmpEngine = { ZONES, EDGE_BAND, normalize, classify, summarize, perceived, fairness, breakdowns, hbpReview, analyzeGame, gameStats, trendPoint, inBox, edgeDist };
  if (typeof module !== 'undefined') module.exports = root.UmpEngine;
})(typeof window !== 'undefined' ? window : globalThis);
