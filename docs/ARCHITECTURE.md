# Architecture

KICKSCOUT is a pnpm + Turborepo monorepo (Node 22, TypeScript strict). The talent platform
(players, videos, scouts, moderation) is described in the README and
[adr/0001-architecture.md](adr/0001-architecture.md). This page covers the whole system briefly
and the football utility added in October 2026 in detail.

```
 Browser ── Next.js 15 web app (apps/web, Vercel project "kickscout")
   │          pages, service worker /sw.js, manifest, favourites in localStorage before sign-up
   │  HTTPS + Supabase access token (signed-in routes only)
   ▼
 API ── Fastify 5 (apps/api, Vercel project "kickscout-api")
   │      Zod contracts (packages/contracts), policy checks (packages/domain)
   ├── Postgres (Supabase): app data, jobs, audit log, football cache and alert state
   ├── Football providers (packages/football): SportScore | football-data.org | fixture
   ├── Push services (FCM, Mozilla, Windows, Apple) via web-push with VAPID
   └── Object storage (S3 API) for videos
 Worker ── apps/worker: ffmpeg + AI analysis of uploads
 Scheduler (to choose) ── calls GET /v1/cron/football every minute
```

## Football utility

### Provider layer (`packages/football`)
- `FootballProvider` interface: `matches(from, to)`, `match(id)`, `teamMatches(id)`,
  `standings(id)`, `competitions()`, and `info` (name, homepage, attribution, coverage note,
  capabilities, `testData`).
- Capabilities drive the UI: a page never offers what the source cannot give (no standings link
  for SportScore, "line-ups not available" instead of empty lists).
- `ProviderError` kinds: `not_configured`, `rate_limited` (with `retryAfterSeconds`), `timeout`,
  `unavailable`, `bad_response`, `not_supported`.
- HTTP helper: timeouts, retries only on network errors and 5xx, 404 → `null`.
- Status mapping is explicit per provider; anything unrecognised becomes `unknown`.

Adding a provider (for example a paid one later): implement the interface in a new file, add its
id to `FootballProviderId` in contracts and to `FOOTBALL_PROVIDER` in the API config, and wire it
in `footballProviderFromConfig`. Pages and alerts need no change.

### Caching and failure handling (`apps/api/src/platform/football.ts`)
- One shared table, `football_cache (key, data, fetched_at, fresh_until, failures,
  next_attempt_at, last_error)`. Every API instance reads the same copy, so visitors never cause
  extra provider calls; there is no per-user polling of the provider.
- Freshness by content: 60 s with a live match, 5 minutes for today, 30 minutes for future days,
  6 h for past days, 24 h for a finished match, 30 minutes for standings.
- When a refresh fails, the last good copy is returned with `stale: true` and its `fetchedAt`;
  the page shows "The data source is not answering. Showing the last update from …". Further
  attempts back off exponentially up to 10 minutes and respect `Retry-After`.
- Concurrent requests for the same key in one process share one provider call.
- Teams and competitions seen in any answer are remembered (`football_teams`,
  `football_competitions`) for search and as foreign keys for favourites.

### Favourites
- Signed out: `localStorage` key `ks_football_favorites` (provider + teams + competitions,
  validated on read, 50 max).
- Signed in: `favorite_teams` / `favorite_competitions`, primary key `(user_id, provider, id)`,
  always filtered by the caller's user id. On sign-in the browser posts the local list to
  `POST /v1/me/football/favorites/import`, which keeps only ids the server knows, then the local
  copy is cleared.

### Match alerts
1. The user follows teams or competitions, opens My teams, presses "Turn on notifications"; the
   browser asks for permission, subscribes with the server's VAPID public key, and the API stores
   the subscription (endpoint host allowlisted, at most 10 devices per user).
2. Every minute the scheduler calls `GET /v1/cron/football`.
3. The job loads matches for the audience (followed teams and competitions of users with alerts
   on), compares each with `football_match_states`, and derives alerts: starting soon (30 min),
   kick-off, goal (with the new score), half-time, full-time, confirmed line-ups. A match seen for
   the first time only stores its state.
4. For each alert and each device of each user who wants that category, it inserts a
   `push_deliveries` row first; only a successful insert leads to a send. Failed sends are retried
   by later runs (3 attempts within an hour). 404/410 from the push service deletes the device.
5. The service worker shows the notification; a click opens the match page (same-site paths only).

Notification payloads contain team names, the score and a link. No personal data.

### Security notes
- Provider keys and the VAPID private key are API environment variables only. The web app gets
  the VAPID public key from `GET /v1/push/config`.
- All new tables have RLS on, no grants to `anon`/`authenticated`, and an `api_all` policy for
  the `kickscout_api` role, the same pattern as the rest of the schema.
- Provider data is untrusted: ids are validated, logo URLs must be https, text is rendered as
  text, and JSON-LD is serialised with `<`, `>` and `&` escaped.
