// Strike zone charts drawn the same way as the report (umpire's view, inches): called pitches, and the perceived (called) zone.
// Needs CSS variables --strike, --ballc, --miss, --band, --deep, --ink, --line, --muted, --surface on the page.
(function () {
  const VX0 = -30, VX1 = 30, VY0 = 0, VY1 = 62;
  const sx = x => x - VX0, sy = y => VY1 - y;
  const boxPath = b => `M${sx(-b.x)},${sy(b.top)}H${sx(b.x)}V${sy(b.bot)}H${sx(-b.x)}Z`;
  function frame(inner) {
    let g = '';
    for (let x = -24; x <= 24; x += 6) g += `<line x1="${sx(x)}" x2="${sx(x)}" y1="${sy(VY1)}" y2="${sy(6)}" stroke="var(--line)" stroke-width=".15"/>`;
    for (let y = 12; y <= 60; y += 6) g += `<line x1="${sx(-27)}" x2="${sx(27)}" y1="${sy(y)}" y2="${sy(y)}" stroke="var(--line)" stroke-width=".15"/>`;
    for (let y = 12; y <= 60; y += 12) g += `<text x="${sx(-28.6)}" y="${sy(y) + 0.7}" font-size="2" text-anchor="middle">${y}"</text>`;
    g += `<path d="M${sx(-8.5)},${sy(4.6)}H${sx(8.5)}V${sy(3.2)}L${sx(0)},${sy(1.4)}L${sx(-8.5)},${sy(3.2)}Z" fill="var(--surface)" stroke="var(--muted)" stroke-width=".3"/>`;
    g += `<text x="${sx(-25)}" y="${sy(2.2)}" font-size="2.1">3B side</text><text x="${sx(25)}" y="${sy(2.2)}" font-size="2.1" text-anchor="end">1B side</text>`;
    return g + (inner || '');
  }
  const wrap = (inner, label) => `<svg class="zsvg" viewBox="0 0 ${VX1 - VX0} ${VY1 - VY0}" role="img" aria-label="${label}">${frame(inner)}</svg>`;

  // ps: classified pitches from UmpEngine. opts.missesOnly draws only missed calls; opts.r dot radius.
  function zone(ps, Z, opts = {}) {
    const band = `<path d="${boxPath(Z.outer)} ${boxPath(Z.inner)}" fill="var(--band)" fill-rule="evenodd"/>`;
    const zr = `<path d="${boxPath(Z.zone)}" fill="none" stroke="var(--ink)" stroke-width=".35"/>`;
    const r = opts.r || 1.2;
    const list = ps.filter(p => p.has && p.dec && p.y > VY0 + 1 && p.y <= VY1 && Math.abs(p.x) <= 29 && (!opts.missesOnly || p.adjOK === false))
      .sort((a, b) => (a.adjOK === false) - (b.adjOK === false));
    let dots = '';
    for (const p of list) {
      const miss = p.adjOK === false, cx = sx(p.x).toFixed(2), cy = sy(p.y).toFixed(2);
      if (p.dec === 'S') dots += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${miss ? 'var(--miss)' : 'var(--strike)'}" fill-opacity="${miss ? 1 : .55}" stroke="var(--surface)" stroke-width=".2"/>`;
      else dots += `<circle cx="${cx}" cy="${cy}" r="${r - (miss ? .35 : .2)}" fill="none" stroke="${miss ? 'var(--miss)' : 'var(--ballc)'}" stroke-opacity="${miss ? 1 : .6}" stroke-width="${miss ? .8 : .35}"/>`;
    }
    return wrap(band + zr + dots, `Strike zone chart of ${list.length} called pitches`);
  }

  // pz: UmpEngine.perceived() result. Heat map + 50% line against the dashed rulebook zone.
  function perceived(pz, Z) {
    let cells = '';
    try {
      const cv = document.createElement('canvas'); cv.width = pz.nx; cv.height = pz.ny;
      const cx = cv.getContext('2d'), img = cx.createImageData(pz.nx, pz.ny);
      for (let j = 0; j < pz.ny; j++) for (let i = 0; i < pz.nx; i++) {
        const v = pz.grid[j * pz.nx + i], o = ((pz.ny - 1 - j) * pz.nx + i) * 4;
        img.data[o] = 99; img.data[o + 1] = 166; img.data[o + 2] = 218; img.data[o + 3] = v < .06 ? 0 : Math.round(v * .85 * 255);
      }
      cx.putImageData(img, 0, 0);
      cells = `<image href="${cv.toDataURL()}" x="${sx(pz.x0 - pz.step / 2)}" y="${sy(pz.y0 + (pz.ny - .5) * pz.step)}" width="${pz.nx * pz.step}" height="${pz.ny * pz.step}" preserveAspectRatio="none"/>`;
    } catch (e) { }
    const T = .5, v = (i, j) => pz.grid[j * pz.nx + i], X = i => sx(pz.x0 + i * pz.step), Y = j => sy(pz.y0 + j * pz.step);
    let d = '';
    for (let j = 0; j < pz.ny - 1; j++) for (let i = 0; i < pz.nx - 1; i++) {
      const a = v(i, j), b = v(i + 1, j), c = v(i + 1, j + 1), e = v(i, j + 1), pts = [], l = (p, q) => (T - p) / (q - p);
      if ((a >= T) !== (b >= T)) pts.push([X(i + l(a, b)), Y(j)]);
      if ((b >= T) !== (c >= T)) pts.push([X(i + 1), Y(j + l(b, c))]);
      if ((e >= T) !== (c >= T)) pts.push([X(i + l(e, c)), Y(j + 1)]);
      if ((a >= T) !== (e >= T)) pts.push([X(i), Y(j + l(a, e))]);
      for (let k = 0; k + 1 < pts.length; k += 2) d += `M${pts[k][0].toFixed(2)},${pts[k][1].toFixed(2)}L${pts[k + 1][0].toFixed(2)},${pts[k + 1][1].toFixed(2)}`;
    }
    const zr = `<path d="${boxPath(Z.zone)}" fill="none" stroke="var(--ink)" stroke-width=".35" stroke-dasharray="1 .8"/>`;
    return wrap(cells + zr + `<path d="${d}" fill="none" stroke="var(--deep)" stroke-width=".7" stroke-linecap="round"/>`, 'Your called strike zone compared with the rulebook zone');
  }
  window.ZoneCharts = { zone, perceived };
})();
