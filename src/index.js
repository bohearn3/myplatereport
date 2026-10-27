// MyPlateReport — Cloudflare Worker entry point.
// Serves the static site from ./public and will host the API for uploads,
// report storage and email delivery.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, service: 'myplatereport', time: new Date().toISOString() });
    }

    return env.ASSETS.fetch(request);
  }
};
