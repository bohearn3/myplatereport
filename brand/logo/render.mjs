// Renders the MyPlateReport (concept B) logo files from one SVG source. Run: NODE_PATH=$(npm root -g) node render.mjs
import fs from 'node:fs'; import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const FONT = fs.readFileSync(new URL('../fonts/Exo2-Italic-VF.ttf', import.meta.url)).toString('base64');
const BLUE = '#63A6DA', BLACK = '#000000';
const PLATE = 'M10 10 H166 V110 L88 188 L10 110 Z';
const badge = gap => `
  <path d="${PLATE}" fill="none" stroke="${BLUE}" stroke-width="20" stroke-linejoin="round"/>
  <path d="${PLATE}" fill="none" stroke="${gap}" stroke-width="8" stroke-linejoin="round"/>
  <path d="${PLATE}" fill="${BLACK}"/>
  <rect x="100.7" y="36" width="25.3" height="29.3" fill="${BLUE}"/>
  <path d="M75.3 36 V124 M100.7 36 V124 M50 65.3 H126 M50 94.7 H126" stroke="#FFFFFF" stroke-opacity="0.45" stroke-width="2"/>
  <rect x="50" y="36" width="76" height="88" fill="none" stroke="#FFFFFF" stroke-width="4"/>`;
const lockup = (gap, ink) => `<g transform="translate(10 8)">${badge(gap)}</g>
  <text x="222" y="102" class="w" fill="${ink}">MYPLATE</text>
  <text x="206" y="186" class="w" fill="${BLUE}">REPORT</text>`;
const page = (inner) => `<!doctype html><html><head><style>
@font-face{font-family:Exo2;src:url(data:font/ttf;base64,${FONT});font-style:italic;font-weight:100 900}
html,body{margin:0;background:transparent}
.w{font-family:Exo2;font-style:italic;font-weight:900;font-size:84px}
</style></head><body><svg id="s" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 260" width="900" height="260">${inner}</svg></body></html>`;
const b = await chromium.launch();
async function shot(inner, out, width, { pad = 14, bg = null, square = false, size } = {}) {
  const p = await b.newPage({ deviceScaleFactor: 1 });
  await p.setContent(page(inner)); await p.evaluate(() => document.fonts.ready);
  const bb = await p.evaluate(() => { const r = document.getElementById('s').getBBox(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  let { x, y, w, h } = bb; x -= pad; y -= pad; w += 2 * pad; h += 2 * pad;
  if (square) { const m = Math.max(w, h); x -= (m - w) / 2; y -= (m - h) / 2; w = h = m; }
  const W = size || width, H = size || Math.round(width * h / w);
  await p.evaluate(({ x, y, w, h, W, H, bg }) => { const s = document.getElementById('s'); s.setAttribute('viewBox', `${x} ${y} ${w} ${h}`); s.setAttribute('width', W); s.setAttribute('height', H); if (bg) document.body.style.background = bg; }, { x, y, w, h, W, H, bg });
  await p.setViewportSize({ width: W, height: H });
  await p.screenshot({ path: out, omitBackground: !bg, clip: { x: 0, y: 0, width: W, height: H } });
  // also keep the SVG source for print use
  if (out.endsWith('.png') && !size) fs.writeFileSync(out.replace('.png', '.svg'), await p.evaluate(() => document.getElementById('s').outerHTML));
  await p.close(); console.log(out, W, H);
}
const OUT = '/home/claude/myplatereport/public/img/';
await shot(lockup('#0D1117', '#F3F6F9'), OUT + 'myplatereport-logo-dark.png', 1200);   // for dark headers (site, emails, PDF)
await shot(lockup('#FFFFFF', BLACK), OUT + 'myplatereport-logo.png', 1200);            // for light backgrounds
await shot(`<g transform="translate(10 8)">${badge('#FFFFFF')}</g>`, OUT + 'myplatereport-mark.png', 512, { pad: 14 });
// App icon: badge on a black rounded tile
const tile = s => `<rect x="-47" y="-36" width="270" height="270" rx="60" fill="#000"/><g>${badge('#000')}</g>`;
for (const [f, n] of [['icon-512.png', 512], ['apple-touch-icon.png', 180]]) await shot(tile(), OUT + f, 0, { pad: 0, size: n });
// Favicon: simplified plate, readable at 16–64px
const fav = `<path d="${PLATE}" fill="#000" stroke="${BLUE}" stroke-width="20" stroke-linejoin="round"/><rect x="54" y="40" width="68" height="80" fill="none" stroke="#FFF" stroke-width="14"/>`;
for (const n of [16, 32, 48, 64]) await shot(fav, `/tmp/fav-${n}.png`, 0, { pad: 11, square: true, size: n });
await b.close();
