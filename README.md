# MyPlateReport

Postgame strike zone reports for collegiate plate umpires, built from Trackman CSV exports.
Hosted on Cloudflare Workers at **myplatereport.com**.

## What's here

| Path | What it is |
|---|---|
| `src/index.js` | Cloudflare Worker: serves the site, private report links (`/r/<id>`) and the API |
| `public/index.html` | Home page |
| `public/admin/` | Admin: send a report (upload CSV, team names, pick umpire from roster, preview, send) |
| `public/admin/umpires/` | Umpire roster, roster CSV import, each umpire's trends, games and reports (also served at `/coord/` for coordinators) |
| `public/admin/import/` | Master admin: silent season import |
| `public/admin/coordinators/` | Master admin: add coordinators, set conferences and access tier, send invites |
| `public/coord-login.html` | Coordinator sign-in (email code), served at `/coord/login` |
| `public/assets/` | Shared admin styles and the role-aware menu script |
| `src/auth.js` | Coordinator sign-in codes and sessions |
| `public/report.html` | The umpire report page (interactive + print/PDF layout). Loads data from `/api/reports/<id>`, or from the admin preview |
| `public/js/engine.js` | Scoring engine: zone checks, raw/adjusted accuracy, edge pitches, perceived zone, fairness, HBP review, trends |
| `public/js/trackman-csv.js` | Trackman CSV reader and file checks |
| `scripts/build_sample_data.js` | Builds league averages and the sample report data from the 2026 Trackman export |

## Scoring rules

- Add `?compare=1` to a report URL to show the 2026-vs-2027 zone switch (admin use).
- **Zone:** 2027 NCAA NSI Static Zone. Ball-center limits ±10.97" wide, 16.05"–42.35" tall. 1" buffer split ½" inside / ½" outside each edge.
- **Calls scored:** StrikeCalled, BallCalled, and BallinDirt (counted as a called ball). HitByPitch is listed for review but not scored. BallIntentional is not scored.
- **Adjusted accuracy:** a call inside the buffer band is never a miss.
- **Trends:** each umpire's own games only. Staff-wide trends go to the admin report.
- Trackman `PlateLocSide` is positive toward the right-handed batter's box; reports draw from the umpire's view.

## Access

- **Master admin:** Cloudflare Access on `/admin` (unchanged). Full access to everything.
- **Conference coordinators:** sign in at `/coord/login` with a 6-digit email code (10 minutes, 5 tries, 30-day session cookie). They only see umpires tagged with their conferences, and all of those umpires' games and trends.
  - **View only:** roster, trends, reports.
  - **View & send:** also send reports to umpires already on their roster. Replies go to the coordinator.
  - **Full control:** also add and edit umpires and import rosters; they can only add or remove their own conference tags.
- Every rule is enforced on the server (`/coord/api/*`); pages only hide what a tier can't use. Turning a coordinator off signs them out everywhere.

## Deploying

Cloudflare **Workers Builds** is connected to this repository. Every push to `main` deploys automatically.

First-time setup (Cloudflare dashboard):
1. Workers & Pages → Create → Import a repository → pick `bohearn3/myplatereport`.
2. Build settings: leave the defaults (deploy command `npx wrangler deploy`).
3. After the first deploy: the Worker → Settings → Domains & Routes → Add → Custom domain → `myplatereport.com` (and `www.myplatereport.com`).

## Roadmap

1. Home page live on myplatereport.com ✓
2. Admin upload page with live report preview, behind Cloudflare Access ✓
3. D1 database for umpires, games and pitches ✓
4. Email delivery (Resend) ✓ with PDF attachment (Browser Run + KV) ← *current*
5. Umpire roster page with CSV import ✓
6. Conference coordinator access (view / send / full) ✓
7. Admin staff trend report every few weeks
8. Umpire logins
