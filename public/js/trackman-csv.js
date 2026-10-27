/* Trackman CSV -> report game object. Runs in the browser (admin page) and in Node (tests). */
(function (root) {
  const FIELDS = ['PitchNo','Inning','Top/Bottom','PAofInning','PitchofPA','Outs','Balls','Strikes','Pitcher','PitcherThrows','PitcherTeam','Batter','BatterSide','BatterTeam','TaggedPitchType','PitchCall','KorBB','PlayResult','PlateLocHeight','PlateLocSide','RelSpeed'];
  const NUMERIC = new Set(['PitchNo','Inning','PAofInning','PitchofPA','Outs','Balls','Strikes','PlateLocHeight','PlateLocSide','RelSpeed']);
  const REQUIRED = ['PitchCall','PlateLocHeight','PlateLocSide','Balls','Strikes','Inning','Top/Bottom','PitcherTeam','BatterSide'];
  const KNOWN_CALLS = new Set(['BallCalled','StrikeCalled','InPlay','FoulBallNotFieldable','FoulBallFieldable','FoulBall','StrikeSwinging','BallinDirt','HitByPitch','BallIntentional','Undefined']);

  // RFC 4180 CSV parser (quoted fields, embedded commas/newlines, "" escapes)
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function normDate(v) {
    if (!v) return null;
    let m = String(v).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
    return String(v).trim();
  }

  function parseTrackman(text, fileName) {
    const rows = parseCSV(text);
    const errors = [], warnings = [];
    if (rows.length < 2) return { errors: ['The file has no pitch rows.'], warnings };
    const header = rows[0].map(h => h.trim());
    const ix = Object.fromEntries(header.map((h, i) => [h, i]));
    const missing = REQUIRED.filter(k => !(k in ix));
    if (missing.length) errors.push(`This doesn't look like a Trackman export. Missing columns: ${missing.join(', ')}.`);
    if (errors.length) return { errors, warnings };

    const get = (r, k) => (k in ix ? r[ix[k]] : undefined);
    const pitches = [], unknown = new Map(), games = new Set();
    for (const r of rows.slice(1)) {
      const call = (get(r, 'PitchCall') || '').trim();
      if (!call) continue;
      if (!KNOWN_CALLS.has(call)) unknown.set(call, (unknown.get(call) || 0) + 1);
      const gid = get(r, 'GameID') || get(r, 'GameUID'); if (gid) games.add(gid);
      pitches.push(FIELDS.map(k => {
        const v = get(r, k);
        if (v === undefined || v === '') return null;
        if (NUMERIC.has(k)) { const n = Number(v); return Number.isFinite(n) ? n : null; }
        return String(v).trim();
      }));
    }
    const first = rows[1];
    const meta = {
      Date: normDate(get(first, 'Date')),
      HomeTeam: (get(first, 'HomeTeam') || '').trim() || null,
      AwayTeam: (get(first, 'AwayTeam') || '').trim() || null,
      Stadium: (get(first, 'Stadium') || '').trim() || null,
      Level: (get(first, 'Level') || '').trim() || null,
      GameID: (get(first, 'GameID') || '').trim() || null
    };
    if (!meta.HomeTeam || !meta.AwayTeam) warnings.push('Home or away team is missing from the file. Enter the team names below.');
    if (games.size > 1) warnings.push(`This file contains ${games.size} different games. Upload one game per file.`);
    if (unknown.size) warnings.push(`Unrecognized pitch calls (not scored): ${[...unknown].map(([k, n]) => `${k} (${n})`).join(', ')}.`);
    const iC = FIELDS.indexOf('PitchCall'), iH = FIELDS.indexOf('PlateLocHeight');
    const untracked = pitches.filter(p => ['BallCalled', 'StrikeCalled', 'BallinDirt'].includes(p[iC]) && p[iH] == null).length;
    if (untracked) warnings.push(`${untracked} called pitch${untracked === 1 ? ' has' : 'es have'} no location from Trackman and won't be scored.`);
    if (!pitches.length) errors.push('No pitches with a PitchCall were found.');
    return { errors, warnings, game: { file: fileName || 'upload.csv', umpire: null, ...meta, pitches }, fields: FIELDS };
  }

  root.TrackmanCSV = { FIELDS, parseCSV, parseTrackman };
  if (typeof module !== 'undefined') module.exports = root.TrackmanCSV;
})(typeof window !== 'undefined' ? window : globalThis);
