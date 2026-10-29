// Shared by the admin and coordinator pages: who is signed in, what they may do, and the menu.
(function () {
  const coord = location.pathname.startsWith('/coord');
  const base = coord ? '/coord/api' : '/admin/api';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const TIERS = ['view', 'send', 'full'];
  const can = (me, t) => me.role === 'master' || TIERS.indexOf(me.tier) >= TIERS.indexOf(t);
  const links = me => me.role === 'master'
    ? [['/admin/dashboard/', 'Dashboard'], ['/admin/', 'Send a report'], ['/admin/umpires/', 'Umpires'], ['/admin/import/', 'Season import'], ['/admin/teams/', 'Teams'], ['/admin/coordinators/', 'Coordinators']]
    : [['/coord/', 'Dashboard'], ['/coord/umpires/', 'Umpires'], ...(can(me, 'send') ? [['/coord/send/', 'Send a report']] : [])];
  function render(me) {
    const host = document.getElementById('nav'); if (!host) return;
    const here = location.pathname.replace(/\/?$/, '/');
    const nav = links(me).map(([h, l]) => `<a href="${h}"${here === h ? ' aria-current="page"' : ''}>${l}</a>`).join('');
    const who = me.role === 'master' ? '' :
      `<span class="who"><span><b>${esc(me.name)}</b> · ${esc((me.conferences || []).join(', '))} · ${{ view: 'View only', send: 'View & send', full: 'Full control' }[me.tier] || ''}</span><button type="button" id="signout">Sign out</button></span>`;
    host.outerHTML = `<div class="nav-wrap"><nav class="nav">${nav}</nav>${who}</div>`;
    const so = document.getElementById('signout');
    if (so) so.addEventListener('click', async () => {
      try { await fetch('/coord/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); } catch (e) { }
      location.href = '/coord/login';
    });
  }
  const ready = fetch(base + '/me', { headers: { accept: 'application/json' } }).then(async r => {
    if (r.status === 401 && coord) { location.href = '/coord/login?next=' + encodeURIComponent(location.pathname); return new Promise(() => {}); }
    if (!r.ok) throw new Error('Could not load your account.');
    const me = await r.json(); render(me); return me;
  });
  window.MPR = { coord, base, ready, can, page: p => (coord ? '/coord' : '/admin') + p };
})();
