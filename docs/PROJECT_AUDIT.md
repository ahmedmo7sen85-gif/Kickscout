# KICKSCOUT project audit

Date: 2026-10-25. Audited commit: `f5115fa` on `main` (the code that is live on Vercel).
Scope: the whole monorepo, the four open pull requests, the live Supabase project and the two
Vercel projects. Secret values were not read or printed at any point.

## 1. What exists today

| Item | Finding | How it was checked |
| --- | --- | --- |
| Repository | pnpm 10 + Turborepo monorepo, TypeScript, Node 22. `apps/web` (Next.js 15, App Router), `apps/api` (Fastify 5, Zod 4 contracts, Kysely), `apps/worker` (ffmpeg video pipeline + Claude tagging/moderation), `packages/{domain,contracts,db,ai}`, plain SQL migrations in `db/migrations` | Read the tree, README, AGENTS.md, ADR 0001 |
| Working tree | Clean, branch created from `main` | `git status` |
| Open PRs | #1 Play (tactics game, drills, XP, migration 0010), #4 Challenges (stacked on #1, migration 0011), #3 Guardian video-safety scan (migration 0012), #2 two small fixes. None merged; none of 0010-0012 is applied to production | GitHub API, `schema_migrations` on Supabase |
| Hosting | Vercel: web `kickscout` (https://kickscout-ten.vercel.app), API `kickscout-api` (Vercel function + `api/worker.js` with bundled ffmpeg). Two daily Vercel crons (worker maintenance 04:00 UTC, billing 04:30 UTC) | `apps/*/vercel.json`, Vercel MCP |
| Live health | `GET /v1/ready` on production answers `{"ready":true,"checks":{"database":"ok","migrations":"ok"}}`. No runtime errors on either project in the last 7 days | Vercel MCP fetch + runtime-error clusters |
| Database | Supabase Postgres (`kickscout`). Migrations 0001-0009 applied. 64 public tables, all with RLS on, every one has a policy, and `anon`/`authenticated` hold no table grants (the API connects as role `kickscout_api`) | SQL against `pg_tables`, `pg_policies`, `information_schema.role_table_grants` |
| Supabase advisors | 2 warnings: `ai_json_has_forbidden_key` has a mutable `search_path`; extension `citext` lives in `public`. Neither is exploitable through the Data API because anon/authenticated have no access, but both are cheap to fix | `get_advisors(security)` |
| Auth | Supabase Auth (email/password, Google). The API verifies JWTs against the project JWKS; roles come from the database, never the token. Staff actions need MFA (`aal2`) | `platform/auth.ts`, `platform/actor.ts`, `domain/policy.ts` |
| Tests | 450 tests, all passing on `main`: domain 84, contracts 20, ai 15, web 98, api 161, worker 72. API and worker tests run against a real Postgres and real ffmpeg | `pnpm test` with a local Postgres 16 |
| Build / typecheck | `pnpm build` passes (7 packages) | ran it |
| Lint | No lint step exists in the repo (no ESLint config). Type checking is strict and is the main static check | `package.json` scripts |
| CI | GitHub Actions: build, typecheck, test with Postgres + ffmpeg on every PR | `.github/workflows/ci.yml` |
| Secrets | No secret, key or credentialed URL is committed (pattern scan over the tracked tree). `.env*` files are git-ignored except `.env.example` | `git grep` scan |

### Working features (talent-discovery product)

Accounts and onboarding with age rules; guardian consent for minors; private-by-default minor
profiles; signed direct uploads with real-file validation, transcode and thumbnails; AI skill tags
and moderation that never rate a player; a human moderation queue; feeds (For You, Following, New
Talent, Trending); likes, saves, comments, follows, blocks, reports; Discover, search and Talent
Radar; verified scouts with shortlists, private notes and guarded contact requests;
organizations and a scout CRM; privacy toggles, data export and account deletion; copyright
takedown and counter-notice; Stripe billing in test mode only; analytics with opt-out; feature
flags; health checks; SEO metadata, sitemap and robots; English, Arabic (RTL), and
machine-quality Spanish, Portuguese and French. These are described in the README with the tests
that cover them; the audit did not find any of them broken.

## 2. Gaps against the master prompt

KICKSCOUT was built as a **talent-discovery** product. The master prompt adds a **football
utility** layer (scores, fixtures, news, favourites, push alerts) that does not exist at all yet.

| Prompt area | State before this work |
| --- | --- |
| 4.1 / 4.2 Live scores, fixtures, results, standings, match pages | **Missing.** No football data provider, no match, team or competition model |
| 4.3 Football news | **Missing** |
| 4.4 Search across teams, competitions, matches | Only players, videos, hashtags and skills |
| 5 Favourite teams and competitions | **Missing** (only following other users) |
| 6 Web Push | **Missing.** In-app notifications only; no service worker, no push subscriptions, no VAPID keys, no sender |
| 7 Provider adapter, caching, attribution | **Missing** |
| 8 Talent discovery | Built (see above); upload end-to-end still blocked on S3 keys in production |
| 9 AI match / player analysis | Video tagging exists; no match analysis (no match data to ground it) |
| 10 Games | In PR #1 (Play) and PR #4 (Challenges), not merged |
| 11 Design system / RTL | Consistent token-based design with logical CSS properties; WCAG basics tested |
| 12 SEO | Done for profiles and videos; no match/team/competition pages |
| 13 Security | Strong server-side policy and RLS; **dependency vulnerabilities** (below); web app has no CSP |
| 14 Performance | Next.js build: 103 kB shared JS; no Lighthouse run recorded before this audit |
| 15 Cost doc | No `docs/COST_AND_SERVICES.md` |
| 16 Ops reports / Telegram | No Telegram integration or daily ops report exists in the code; nothing to preserve |
| PWA | No web app manifest or service worker |

## 3. Security and data-integrity risks

| # | Risk | Severity | Evidence |
| --- | --- | --- | --- |
| S1 | `next@15.5.27` is affected by a **critical** unauthenticated RCE in the Image Optimization API and a high-severity Server Actions DoS (fixed in 15.5.28) | Critical | `pnpm audit --prod` |
| S2 | `zod@<4.6.6` memory exhaustion on oversized constrained collections (API validates untrusted bodies with Zod) | High | `pnpm audit --prod` |
| S3 | `postcss` (via Next) path traversal / file read / XSS advisories; `fast-uri` (via Fastify's AJV) URI-parsing advisories; `fastify` header-validation bypass (low) | High to low | `pnpm audit --prod` (16 findings in total) |
| S4 | Web app sends no Content-Security-Policy and no HSTS header of its own (Vercel adds HSTS on its domains, not on a future custom domain) | Medium | `apps/web/next.config.ts` |
| S5 | Supabase advisor warnings (mutable `search_path` on one SQL function, `citext` in `public`) | Low | Supabase advisors |
| S6 | Rate limits use Postgres on Vercel only when `RATE_LIMIT_STORE=postgres` is set; confirm it is set on `kickscout-api` | Low | config + README |
| S7 | Production mailer is not built: guardian emails are only logged in the preview (`ALLOW_LOG_MAILER=yes`). This blocks real minor sign-ups | Medium (product) | `server.ts` throws for `MAILER=ses` |

No authorization bypass, secret leak or RLS gap was found.

## 4. UX and design weaknesses

- The public site has nothing for a football fan who is not a player or scout: no scores, no
  fixtures, no reason to come back daily.
- Navigation has no football-utility entry point.
- No installable PWA, so mobile users cannot add KICKSCOUT to the home screen with an icon.
- Spanish, Portuguese and French copy is machine quality (already labelled as such).

## 5. Deployment and cost risks

- Vercel Hobby crons run **at most once a day**, so minute-level match reconciliation for push
  alerts cannot run on Vercel Cron alone. A free external scheduler is needed (Supabase
  `pg_cron` + `pg_net` is already available in the project; see `docs/COST_AND_SERVICES.md`).
- Free football data has hard limits: SportScore's free tier needs a visible "Powered by
  SportScore" link and covers only a short window of live/recent matches; football-data.org's
  free tier covers 12 competitions at 10 requests/minute with delayed scores.
- Supabase Free pauses a project after a week without activity and caps the database at 500 MB.
- Vercel Hobby is for non-commercial use; a commercial launch needs Vercel Pro or another host.

## 6. Prioritised changes

| Priority | Change | Status in this PR |
| --- | --- | --- |
| P0 | Patch the critical Next.js RCE and the other dependency advisories | Done |
| P0 | Add web security headers (CSP in report-friendly form, HSTS) | Done |
| P0 | Keep every existing test green; build on `main` without touching PRs #1-#4 (new migration is `0013`) | Done |
| P1 | Football data layer: provider interface, normalised types, strict status mapping, SportScore + football-data.org adapters, shared Postgres cache with stale-if-error, provider health | Done |
| P1 | Scores page with live / upcoming / finished filters, date navigation, competition filter, timezone shown; match, team and competition pages; source + last-updated on every page; required attribution | Done |
| P1 | Football news | Not built: no reliable free news API was verified. Documented in the cost doc with the adapter shape to add |
| P2 | Favourite teams and competitions (DB-backed, ownership enforced, local preview before sign-up, merged on sign-in) | Done |
| P2 | Web Push: service worker, subscription storage, per-category settings, VAPID, server sender, dedupe, expired-endpoint cleanup, test notification, reconciliation job | Done; the scheduler needs owner approval to switch on |
| P2 | Supabase advisor fixes | Done in migration 0013 (additive, safe) |
| P3 | Merge PRs #1-#4 in order, apply 0010-0012 | Needs Ahmed |
| P3 | Production mailer for guardian emails | Not started (needs a mail provider choice) |
| P4 | Evidence-grounded AI match analysis on top of the new match data | Not started |
| P4 | Lighthouse budget in CI, Search Console verification | Not started |
