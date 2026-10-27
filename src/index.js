// MyPlateReport — Cloudflare Worker entry point.
// Serves the static site from ./public and will host the API for uploads,
// report storage and email delivery.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, service: 'myplatereport', time: new Date().toISOString() });
    }

    // Saving reports and emailing them turn on once the D1 database and email service are connected.
    if (url.pathname === '/api/reports' && request.method === 'POST') {
      return Response.json({ error: 'Saving and emailing are not connected yet. The database and email service are the next step.' }, { status: 501 });
    }

    // Private report links: /r/<id> renders the report page, which loads its data from /api/reports/<id>.
    if (url.pathname.startsWith('/r/')) {
      return env.ASSETS.fetch(new Request(new URL('/report', url), request));
    }
    if (url.pathname.startsWith('/api/reports/')) {
      return Response.json({ error: 'Report not found.' }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  }
};
