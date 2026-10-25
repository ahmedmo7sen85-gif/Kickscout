# Implementation report — football utility, favourites, Web Push, security

Date: 2026-10-25. Branch: `claude/project-thread-nk4uh8`, built on `main` at `f5115fa`.
Read with [PROJECT_AUDIT.md](PROJECT_AUDIT.md) (what was found and why these changes came first).

Nothing in this branch has been deployed or applied to production. Production is unchanged.

## 1. What changed

### Security and dependencies
- Next.js `15.5.28`, Fastify `^5.12.7`, Zod `^4.6.7`, plus `pnpm.overrides` for `postcss` and
  `fast-uri`. Before: 16 advisories from `pnpm audit --prod`, one critical (Next.js image
  optimiser RCE). After: `No known vulnerabilities found`.
- Web security headers in `apps/web/next.config.ts`: HSTS and a structural Content Security
  Policy (`base-uri`, `object-src 'none'`, `frame-ancestors 'none'`, `form-action`, `worker-src`,
  `manifest-src`). Script and style sources are not restricted yet (Next.js inline scripts need
  nonces first; see limitations).
- Supabase advisor warning "function search_path mutable" fixed for
  `ai_json_has_forbidden_key` in migration 0013. The `citext` extension in `public` warning is
  left alone on purpose: moving an extension that columns depend on is risky and gains little.

### Football data (`packages/football`, new)
- One `FootballProvider` interface and normalised types (`Match`, `MatchDetail`, `Standings`,
  statuses `scheduled | live | halftime | finished | postponed | suspended | cancelled |
  abandoned | unknown`). Unknown provider states map to `unknown`, never guessed.
- **SportScore** adapter (default, no key): live and recent matches, match detail with events and
  stats, team matches. The detail endpoint is looked up by slug, so the adapter checks the
  returned id and team names and refuses a mismatch instead of showing the wrong match
  (a real case: the slug `barcelona` returned a different club). No standings (not offered).
- **football-data.org** adapter (free key): matches by date, standings, competitions.
- **Fixture** provider: invented teams such as "River Test FC", flagged `testData: true`, shown
  with a "Test data" notice, never indexed, and refused by config in production.
- Alert detection: compares a stored snapshot with a fresh observation and emits alerts only for
  verified transitions. A match seen for the first time never alerts.
- 24 unit tests, using real SportScore response samples.

### API (`apps/api`)
- Migration `db/migrations/0013_football.sql` (additive only, new tables): `football_cache`,
  `football_teams`, `football_competitions`, `favorite_teams`, `favorite_competitions`,
  `football_alert_preferences`, `push_subscriptions`, `football_match_states`, `push_deliveries`.
  Every new table: RLS on, `anon` and `authenticated` revoked, `api_all` policy for
  `kickscout_api` when that role exists. Numbered 0013 so PRs #1–#4 (0010–0012) are untouched;
  the migration runner applies missing files in name order, so the gap is fine.
- `FootballService`: a shared Postgres cache with freshness by content (60 s while a match is
  live, 5–30 minutes otherwise, 24 h for finished matches), single-flight per process,
  stale-if-error (the last good copy is served with `stale: true` and its age), exponential
  backoff up to 10 minutes, `Retry-After` honoured, and provider health.
- Public routes: `GET /v1/football/status`, `/matches?date&tz`, `/matches/:id`, `/teams/:id`,
  `/competitions`, `/competitions/:id/standings`, `/search?q`. Every answer carries `source`
  (provider, attribution, test-data flag, capabilities, `fetchedAt`, `stale`).
- Signed-in routes: favourites (`GET`, `PUT`/`DELETE` per team or competition, `POST import`),
  owner-only, 50 per kind under an advisory lock; alert preferences (`GET`/`PATCH`); push
  subscriptions (subscribe, remove, status, test). The push endpoint must be on a known push
  service host (FCM, Mozilla, Windows, Apple), which closes the SSRF route. At most 10 devices.
- `GET /v1/cron/football` (Bearer `CRON_SECRET`): retries failed deliveries from the last hour,
  loads matches from 4 h back to 2 h ahead for the audience's teams and competitions, detects
  alerts, writes one `push_deliveries` row per alert and device **before** sending (primary key
  `(alert_key, subscription_id)`, so a repeated run cannot send twice), deletes devices the push
  service says are gone (404/410), and trims old rows.
- Account export includes football data; account deletion erases it.
- 15 API tests for all of the above, against a real Postgres.

### Web (`apps/web`)
- Pages: `/scores` (day navigation in the visitor's time zone with a zone picker, live /
  upcoming / finished tabs with counts, competition chips, "Your teams" group, live refresh every
  60 s only while the tab is visible and online), `/scores/match/[id]` (score, status, kick-off,
  half-time, events timeline, line-ups, stats, each saying when the source has none),
  `/scores/team/[id]`, `/scores/competition/[id]` (standings with full column names for screen
  readers), `/following` ("My teams": list, search to add, alert settings, push controls).
- Every football page shows the data source, "Updated … ago", the delayed-scores note where it
  applies, a stale notice when the provider is down, and the provider's attribution as a normal
  followed link ("Powered by SportScore").
- Favourites work signed out (saved in the browser), and are moved into the account at sign-in.
- Web Push: `public/sw.js` handles only `push` and `notificationclick` (no caching, only
  same-site links), `lib/push.ts` asks for permission only from the "Turn on notifications"
  button after an explanation. Denied, unsupported (including iOS outside the Home Screen) and
  "not configured" states each have their own message.
- PWA manifest (`/manifest.webmanifest`, start URL `/scores`) and icons.
- Navigation: "Scores" in the top bar and the mobile bottom bar (now six items), a "My teams"
  star in the desktop top bar.
- SEO: `/scores` in the sitemap; match, team and standings pages get titles, descriptions and
  canonicals; `SportsEvent` JSON-LD on real match pages only; unknown and test-data pages are
  `noindex`; `/following` is disallowed in robots.
- All new copy in English, Arabic, Spanish, Portuguese and French (key parity test passes).
  Layout uses logical properties; the day arrows mirror in Arabic.

### Docs
`docs/PROJECT_AUDIT.md`, this report, `docs/ARCHITECTURE.md`, `docs/ENVIRONMENT_SETUP.md`,
`docs/COST_AND_SERVICES.md`, README rows, `.env.example` entries.

## 2. Checks run (real results)

| Check | Result | Notes |
| --- | --- | --- |
| `pnpm build` (all 8 packages) | PASS | |
| `pnpm typecheck` | PASS | |
| `pnpm test` with a real Postgres 16 | PASS | 499 tests: domain 84, contracts 20, football 24, ai 15, web 108, api 176, worker 72 (baseline on `main` was 450) |
| `pnpm audit --prod` | PASS | No known vulnerabilities |
| Playwright smoke suite (`pnpm --filter @fp/web e2e`) | PASS | 17 tests, including `/scores`, a match and a team page with the API unreachable (error state, no crash) and the six-item bottom nav |
| Browser walk-through with the local API on fixture data | PASS | `/scores`, match, standings and My teams at 390 px and 1440 px in English and 390 px in Arabic (RTL); no console errors; no horizontal scroll; follow while signed out survives a reload. Screenshots in the project files (`kickscout-audit/screenshots/`) |
| `pnpm lint` | NOT RUN | The repo has no lint script |
| Live SportScore calls from this environment | BLOCKED | The sandbox proxy refuses sportscore.com; the adapter is tested against real responses fetched through the docs tool |
| Live football-data.org calls | NOT RUN | No API key |
| Real push delivery to a browser | NOT RUN | Needs VAPID keys on a deployed API; the sender is faked in tests |
| Migration 0013 on production Supabase | NOT RUN | Waits for Ahmed's approval; applied and tested on local Postgres only |
| Lighthouse | NOT RUN | Not set up in CI yet |

## 3. Limitations

- **No football news.** No news API with clear free reuse terms was verified, so there is no news
  page rather than invented or scraped articles.
- **SportScore coverage**: only live and recent matches (up to 50, no date filter), so other days
  can look empty. The page says so. No standings or line-ups from SportScore.
- **Alerts need a scheduler.** Vercel Hobby crons run once a day. Until a minute-level scheduler
  calls `/v1/cron/football`, alert settings save but nothing is sent.
- **Alert speed** follows the provider's update speed (SportScore caches 60 s; football-data.org
  free scores are delayed), so alerts can arrive a minute or more after the moment.
- **iOS** only supports Web Push for sites added to the Home Screen (iOS 16.4+).
- **CSP** does not restrict scripts yet; tightening it needs per-request nonces in Next.js.
- Search covers teams and competitions the API has already seen from the provider (it fills as
  pages are visited), not the provider's whole catalogue.
- Spanish, Portuguese and French football copy is machine quality, like the rest of the app.
