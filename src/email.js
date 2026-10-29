// Report email: short summary + private link. Table layout and inline styles for email clients.
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = v => (v == null ? '–' : (v * 100).toFixed(1) + '%');
const fmtDate = s => { if (!s) return ''; const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); };

export function reportEmail({ name, url, game, s, hbp, pdf }) {
  const first = name.split(' ')[0];
  const title = game.intra ? `${game.home} intrasquad` : `${game.away} at ${game.home}`;
  const subject = `Your plate report: ${title}, ${fmtDate(game.date)}`;
  const stat = (label, value) => `<td style="padding:12px 8px;text-align:center;border:1px solid #D9E1E8;border-radius:8px;background:#FFFFFF">
      <div style="font:800 24px/1 Arial Narrow,Arial,sans-serif;color:#0D1117">${esc(value)}</div>
      <div style="font:12px/1.4 Arial,sans-serif;color:#5A6573;margin-top:4px">${esc(label)}</div></td>`;
  const html = `<!doctype html><html><body style="margin:0;background:#F3F6F9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F6F9"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
  <tr><td style="background:#0D1117;border-radius:12px 12px 0 0;padding:18px 22px">
    <img src="https://myplatereport.com/img/myplatereport-logo-dark.png" width="168" height="56" alt="MyPlateReport" style="display:block;border:0;width:168px;height:auto"></td></tr>
  <tr><td style="background:#FFFFFF;padding:24px 22px;font:15px/1.55 Arial,sans-serif;color:#0D1117">
    <p style="margin:0 0 6px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#5A6573">Plate umpire report · 2027 NSI static zone</p>
    <h1 style="margin:0 0 4px;font:800 26px/1.1 Arial Narrow,Arial,sans-serif;text-transform:uppercase">${esc(title)}</h1>
    <p style="margin:0 0 18px;color:#5A6573">${esc(fmtDate(game.date))}</p>
    <p style="margin:0 0 16px">${esc(first)}, your report is ready. You got <b>${s.adjCorrect} of ${s.decisions}</b> calls right after the buffer, with <b>${s.missN} missed call${s.missN === 1 ? '' : 's'}</b>.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="margin:0 0 18px"><tr>
      ${stat('Adjusted', pct(s.adj))}${stat('Raw', pct(s.raw))}${stat('Edge', pct(s.edgeAcc))}${stat('Missed', s.missN)}
    </tr></table>
    ${hbp ? `<p style="margin:0 0 16px;color:#5A6573">${hbp} hit batter${hbp === 1 ? '' : 's'} listed in the review section.</p>` : ''}
    <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#0D1117;border-radius:10px">
      <a href="${esc(url)}" style="display:inline-block;padding:13px 22px;font:700 15px Arial,sans-serif;color:#FFFFFF;text-decoration:none">Open your full report</a></td></tr></table>
    ${pdf ? `<p style="margin:14px 0 0;font-size:13px;color:#5A6573">A PDF copy is attached for printing or saving.</p>` : ''}
    <p style="margin:18px 0 0;font-size:13px;color:#5A6573">The report includes your zone chart, perceived strike zone, tough calls, home vs. visitor balance, every missed call and your trends. This link is private to you.</p>
  </td></tr>
  <tr><td style="padding:14px 22px;font:12px/1.5 Arial,sans-serif;color:#5A6573">Reply to this email with questions about your report.<br>${esc(url)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${first}, your plate report is ready.

${title} — ${fmtDate(game.date)}
Adjusted accuracy: ${pct(s.adj)} (${s.adjCorrect} of ${s.decisions})
Raw accuracy: ${pct(s.raw)}
Edge accuracy: ${pct(s.edgeAcc)}
Missed calls: ${s.missN}${hbp ? `\nHit batters for review: ${hbp}` : ''}

Open your full report: ${url}${pdf ? '\nA PDF copy is attached.' : ''}

This link is private to you. Reply to this email with questions.`;
  return { subject, html, text };
}

// Coordinator sign-in code and invitation
const shell = (inner) => `<!doctype html><html><body style="margin:0;background:#F3F6F9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F6F9"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
  <tr><td style="background:#0D1117;border-radius:12px 12px 0 0;padding:18px 22px">
    <img src="https://myplatereport.com/img/myplatereport-logo-dark.png" width="168" height="56" alt="MyPlateReport" style="display:block;border:0;width:168px;height:auto"></td></tr>
  <tr><td style="background:#FFFFFF;padding:24px 22px;font:15px/1.55 Arial,sans-serif;color:#0D1117">${inner}</td></tr>
</table></td></tr></table></body></html>`;

export function codeEmail({ name, code }) {
  const first = String(name || '').split(' ')[0] || 'Hi';
  return {
    subject: `Your MyPlateReport sign-in code: ${code}`,
    html: shell(`<p style="margin:0 0 14px">${esc(first)}, here is your sign-in code:</p>
      <p style="margin:0 0 14px;font:800 34px/1 Arial Narrow,Arial,sans-serif;letter-spacing:.18em">${esc(code)}</p>
      <p style="margin:0;color:#5A6573;font-size:13px">It works for 10 minutes. If you didn't try to sign in, you can ignore this email.</p>`),
    text: `${first}, your MyPlateReport sign-in code is ${code}. It works for 10 minutes. If you didn't try to sign in, ignore this email.`
  };
}

export function inviteEmail({ name, conferences, tier, url }) {
  const first = String(name || '').split(' ')[0] || 'Hi';
  const what = { view: 'view your umpires, their reports and trends', send: 'view your umpires and send them postgame reports', full: 'view your umpires, send reports and manage your conference roster' }[tier] || 'view your umpires';
  const conf = (conferences || []).join(', ');
  return {
    subject: `You're set up on MyPlateReport${conf ? ` for ${conf}` : ''}`,
    html: shell(`<p style="margin:0 0 12px">${esc(first)}, you now have coordinator access on MyPlateReport${conf ? ` for <b>${esc(conf)}</b>` : ''}. You can ${esc(what)}.</p>
      <p style="margin:0 0 16px">Sign in with this email address. We'll send you a 6-digit code each time; there's no password.</p>
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#0D1117;border-radius:10px">
        <a href="${esc(url)}" style="display:inline-block;padding:13px 22px;font:700 15px Arial,sans-serif;color:#FFFFFF;text-decoration:none">Sign in to MyPlateReport</a></td></tr></table>
      <p style="margin:16px 0 0;color:#5A6573;font-size:13px">${esc(url)}</p>`),
    text: `${first}, you now have coordinator access on MyPlateReport${conf ? ` for ${conf}` : ''}. You can ${what}.\n\nSign in with this email address at ${url}. We'll email you a 6-digit code each time; there's no password.`
  };
}

export function portalInviteEmail({ name, url }) {
  const first = String(name || '').split(' ')[0] || 'Hi';
  return {
    subject: 'Your MyPlateReport umpire portal is ready',
    html: shell(`<p style="margin:0 0 12px">${esc(first)}, you can now sign in to MyPlateReport to see all of your postgame strike zone reports and your season trends in one place.</p>
      <p style="margin:0 0 16px">Sign in with this email address. We'll send you a 6-digit code each time; there's no password.</p>
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#0D1117;border-radius:10px">
        <a href="${esc(url)}" style="display:inline-block;padding:13px 22px;font:700 15px Arial,sans-serif;color:#FFFFFF;text-decoration:none">Open my umpire portal</a></td></tr></table>
      <p style="margin:16px 0 0;color:#5A6573;font-size:13px">${esc(url)}</p>`),
    text: `${first}, you can now sign in to MyPlateReport to see all of your postgame strike zone reports and season trends.\n\nSign in with this email address at ${url}. We'll email you a 6-digit code each time; there's no password.`
  };
}
