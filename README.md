# KICKSCOUT

**YOUR SKILL. YOUR MOMENT. GET DISCOVERED.**

KICKSCOUT is a football talent discovery platform. Players post short vertical clips of their
skills, fans discover and follow them, and verified scouts search, shortlist and contact talent
through a controlled, safety-first workflow. AI organises the content (skill tags, moderation);
it never rates a player's ability or "professional potential".

English first, Arabic (RTL) ready. Spanish, Portuguese and French are machine-quality translations
that need a native speaker's review before launch.

## What works today

| Area | What is built | Tested by |
| --- | --- | --- |
| Accounts | Supabase Auth tokens (email/password, Google) verified by the API; registration with age checks; roles PLAYER, FAN, SCOUT, MODERATOR, ADMIN (scout/staff roles are never self-assigned) | API tests |
| Minor safety | Guardian invitation + consent, private-by-default profiles and uploads, no city/email/age for the public, followers-only comments, contact-harvesting comments held, scout contact routed to the guardian, per-country age rules that apply only after legal review | API + domain tests |
| Videos | Signed direct upload, async processing queue, real-file validation (ffprobe + decode check), trim, H.264 720p transcode, thumbnail, duplicate detection, states UPLOADING → PROCESSING → ANALYZING → PUBLISHED / REVIEW_REQUIRED / REJECTED / FAILED | Worker tests (real ffmpeg clips) |
| AI | Claude vision on sampled frames: football present, players visible, context, skill tags with confidence, moderation verdict SAFE / FLAGGED / REVIEW_REQUIRED / REJECTED. AI tags are stored as AI and can be corrected by the player. Ambiguous content goes to humans, never auto-deleted. One `@fp/ai` router (provider interface, Claude + fake) picks model and effort per task (heavy model for video analysis, light model for search parsing), with timeouts, retries with backoff, per-task token budgets, an `ai_calls` cost log, and the model recorded on every AI tag and verdict (shown to owners and staff). No rating, score or "potential" is ever accepted from a model: refused in code and by database constraints | Worker + API + `@fp/ai` tests with fake providers (no live call made yet) |
| Natural-language scout search (prototype, off by default) | `POST /v1/scout/search/nl`: English or Arabic text to the normal scout filters (light model, or a built-in rule parser when no key is set or the model answer is unusable); the response says which parser was used, explains the filters, and returns results with the same privacy, minor and quota rules (counted once). Scout dashboard search box with editable filter chips. `NL_SCOUT_SEARCH=on` | API + domain + web tests |
| For You personalisation (prototype, off by default) | Transparent ranking from followed players, skills and positions of liked or saved clips, and country; "Why am I seeing this?" on every For You clip, "Not interested", a "Personalize my feed" switch and "Reset history" in Settings. Never from watch time. `FOR_YOU_PERSONALIZATION=on` | API + domain + web tests |
| Feed and social | For You, Following, New Talent, Trending; like, save, comment, share, follow, block, report; views counted once per viewer per day | API tests |
| Discovery | Search (players, videos, hashtags, skills, country, position, foot), Discover page, Talent Radar with "Trending because…" reasons and categories (rising, most watched, most saved, new talents, hidden gems, most improved, top by skill, new to the platform, regional standouts), challenges with direct-to-challenge upload | API + domain tests |
| Scouts | Verification by staff, filtered player search (age group, position, foot, country, skill, verified, followers), multiple shortlists, private notes, contact requests the player (or guardian) accepts or declines | API tests |
| Organizations | Academies, clubs, agencies, schools: owner / admin / scout / analyst / viewer roles enforced per action, email invitations (hashed, expiring token bound to the verified address), role changes, removal, leave, ownership transfer, delete; verification through the admin queue with a badge; public profile without members; reports freeze the organization | API + domain + web tests |
| Scout CRM | Personal and organization pipelines (New → Watching → Shortlisted → Monitoring → Contact Requested → Contacted → Evaluation → Archived) with stage history, private notes and tags; Contact Requested goes through the contact flow and its minor/guardian/consent rules; saved searches with alerts on newly published matching clips (in-app, honouring notification preferences); keyboard-operable kanban | API + worker + web tests |
| Privacy and account | Public / unlisted / followers / private profiles; toggles for scout discovery, contact requests, country, region and age, enforced in every list and search (a minor can only tighten them; loosening needs the guardian); notification preferences per category (security alerts always on); JSON data export; account deletion with typed confirmation (a minor's request waits for the guardian, profile hidden meanwhile) | API + domain tests |
| Copyright and legal | Ownership declaration on every upload; public takedown form that opens a priority moderation case; counter-notice by the uploader or guardian; repeat-infringer count shown to admins; draft Terms, Privacy (incl. cookies), Community Guidelines, Copyright, Safety, Scout and Subscription terms, all marked "draft pending legal review" | API + web tests |
| Admin | Moderation queue (AI flags, rule hits, merged user reports) with approve / reject / remove / restrict / escalate / suspend, verification decisions, user suspend/restore, challenges, jurisdiction rules, stats, append-only audit log | API tests |
| Web app | Next.js app in the KICKSCOUT design: landing page, feed, upload flow, profiles, Discover, Talent Radar, challenges, search, scout dashboard, notifications, settings, admin | See `apps/web` |
| Plans and billing | Plans, prices (per currency, minor units), trials and limits live in the database; one entitlements module turns a user's plans into FEATURE_* flags and limits (clip length, live videos, uploads per day, scout searches per month, shortlist slots, seats); quotas enforced on uploads, scout search and shortlists; Stripe Checkout + Billing Portal behind a `PaymentProvider` interface (test mode only); signed, idempotent webhooks are the only thing that grants a paid plan; coupons and referral codes; minors cannot buy (a guardian buys for them); `/pricing` page and a Billing section in Settings | API + domain + web tests (Stripe itself is faked; no live Stripe call made yet) |
| Product analytics | Allowlisted event registry (`packages/contracts/src/analytics.ts`) with strict per-event properties (ids and coarse enums only: no names, free text, search terms, raw IPs or URLs with query strings); `track()` at signup, upload, publish, views, likes, saves, follows, scout search, shortlist, pipeline stage, contact request/accept, checkout and subscription; `POST /v1/events` for browser events (allowlisted, rate-limited, max 20 per batch); an analytics opt-out in Settings (and GPC/DNT for signed-out visitors) keeps only payment and safety events; minors' identifying properties are stripped; daily rollups into aggregates, then raw events older than 180 days are deleted | Contracts + worker + API + web tests |
| Metrics | North Star "Qualified Talent Discoveries" computed daily, DAU/WAU, uploads, publishes, scout searches, contact requests and three funnels at `GET /v1/admin/metrics` (admin + MFA) and `/admin/metrics` (SVG charts, each with a data table) | Worker + API + web tests |
| Feature flags | Database flags with deterministic percentage bucketing, role/country audiences, a 30 s server cache, admin CRUD with audit log, `GET /v1/flags` and `useFlag()` in the web app; `nl_scout_search`, `for_you_personalization` and `hls_streaming` are seeded off | Domain + API + web tests |
| Observability | One JSON access-log line per request (request id, hashed user id, route, status, latency), `x-request-id` echoed, an `ErrorReporter` interface (logs by default), `GET /v1/health` and `GET /v1/ready`, worker batch metrics (jobs done/retried/failed, busy time, queue depth) | API + worker tests |
| SEO | Per-page title, description, canonical URL and Open Graph/Twitter cards with a brand image; `sitemap.xml` (only indexable profiles and videos, from `GET /v1/sitemap`); `robots.txt`; JSON-LD `ProfilePage` and `VideoObject` on indexable pages only | API + web tests |
| Languages and accessibility | English, Arabic (RTL), Spanish, Portuguese and French with key parity; locale switcher; `Accept-Language` default; WCAG 2.2 AA basics (contrast tokens, 24 px targets, visible focus, labelled controls) checked by tests | Web tests |
| Demo content | Labelled demo players, scout and challenges using the 20 promo clips, refused in production | API test |

### Not built yet (and labelled as such in the product)

- Natural-language search and For You personalisation are **Prototypes**, off until
  `NL_SCOUT_SEARCH=on` / `FOR_YOU_PERSONALIZATION=on` for everyone, or roll out gradually with the `nl_scout_search` and `for_you_personalization` flags.
  Scout comparison, direct messaging, Apple sign-in return **Coming Soon** capability labels.
- Paid plans are a **Prototype**: payments stay off until Stripe test keys are set, and the API
  refuses live keys. Pro analytics, team seat management, priority support and API access are
  listed on plans as **Coming soon**; seats are an entitlement number only (no member invites yet).
- Malware scanning of uploads (files are fully decoded by ffmpeg, which rejects non-video files).
- Production email for guardian invitations (`MAILER=log` prints the link; production refuses to
  start with it).
- Rate limits are per-process; use a shared store when running more than one API instance.
- Analytics events are not part of the JSON data export (they are deleted with the account).
  No third-party error tracker is wired yet: `ErrorReporter` logs; plug a vendor in through it.

## Architecture

```
 Browser (Next.js on Vercel)
   │  Supabase Auth session → Bearer access token
   ▼
 API (Fastify, apps/api) ── verifies JWT via Supabase JWKS, loads roles from Postgres,
   │                        authorises every request server-side (packages/domain/policy.ts)
   ├── Postgres (Supabase): all data, jobs queue, audit log
   ├── Object storage (S3 API: Supabase Storage / R2 / MinIO): signed PUT for originals
   ▼
 Worker (apps/worker) ── claims jobs (FOR UPDATE SKIP LOCKED), validates + transcodes with
                          ffmpeg, samples frames → Claude for tags + moderation → publishes,
                          or opens a moderation case for a human
```

Upload flow: `POST /v1/uploads` (signed URL) → browser PUTs the file to storage →
`POST /v1/uploads/:id/complete` → job queued, request returns immediately → worker processes →
player is notified.

| Package | Purpose |
| --- | --- |
| `packages/domain` | Pure rules: age and jurisdiction, privacy projection, authorization policy, Talent Radar, taxonomy, capability labels |
| `packages/contracts` | Zod request/response schemas shared by API and web; generates OpenAPI 3.1 |
| `packages/db` | Kysely database types, connection, migration runner |
| `apps/api` | HTTP API |
| `apps/worker` | Background video processing and AI |
| `apps/web` | Web app |
| `db/migrations` | SQL schema and reference data (regions, skills) |

Tech stack: TypeScript, Node 22, pnpm + Turborepo, Fastify 5, Zod 4, Kysely, PostgreSQL 16,
AWS SDK v3 (S3 API), ffmpeg, Anthropic SDK (`claude-opus-5-5`), Next.js, Supabase.

## Local setup

Requirements: Node 22, pnpm 10, Docker (or local PostgreSQL 16 + MinIO), ffmpeg.

```sh
pnpm install
docker compose up -d                  # postgres + minio
cp .env.example apps/api/.env         # fill in the api + shared values
cp .env.example apps/worker/.env      # fill in the worker + shared values
pnpm build
pnpm db:migrate                       # applies db/migrations
pnpm --filter @fp/api db:seed         # optional: labelled demo data
pnpm --filter @fp/api dev             # API on :8080
pnpm --filter @fp/worker dev          # video worker
pnpm --filter @fp/web dev             # web on :3000
```

Generate the two API secrets with `openssl rand -base64 32` (DOB_ENCRYPTION_KEY) and
`openssl rand -hex 32` (VIEWER_HASH_SECRET).

### Environment variables

All variables are listed with comments in [`.env.example`](.env.example). Only `NEXT_PUBLIC_*`
values reach the browser; database URLs, storage keys, the Anthropic key and the Supabase
service key never do.

### Database

Migrations are plain SQL in `db/migrations`, applied in order by `pnpm db:migrate` (tracked in
`schema_migrations`, guarded by an advisory lock). On Supabase, point `DATABASE_URL` at the
project's connection string. After a schema change, regenerate types with
`DATABASE_URL=... pnpm --filter @fp/db types`.

### Storage

Create two buckets: originals (private) and delivery (public read, or behind a CDN). Set
`S3_ENDPOINT`, keys and bucket names for your provider: Supabase Storage (S3 endpoint
`https://<ref>.supabase.co/storage/v1/s3`), Cloudflare R2, MinIO or AWS. The originals bucket
must allow browser `PUT` from your web origin (CORS) for direct uploads.

### Auth (Supabase)

Enable email/password and Google providers, turn on email confirmation, and use asymmetric JWT
signing keys so the API can verify tokens from
`https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`. Staff need MFA (`aal2`) for admin
and moderation actions. Grant the first admin with SQL:
`INSERT INTO user_roles (user_id, role) VALUES ('<user id>', 'admin');`

### AI

Set `ANTHROPIC_API_KEY` for the worker. Without it nothing is published automatically: every
upload waits in the moderation queue for a human. The prompt asks the model to tag only what is
visible and states it is not judging ability. AI tags are stored with `source = 'ai'`, a
confidence and the model that produced them; player corrections are stored separately.

Set `ANTHROPIC_API_KEY` for the API too to let natural-language scout search use the light model;
without it the built-in English/Arabic rule parser answers. All calls go through `packages/ai`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AI_MODEL_HEAVY` / `AI_EFFORT_HEAVY` | `claude-opus-5-5` / `high` | Video tagging and moderation (`AI_MODEL` / `AI_EFFORT` still work as fallbacks) |
| `AI_MAX_TOKENS_HEAVY`, `AI_TIMEOUT_MS_HEAVY`, `AI_MAX_ATTEMPTS_HEAVY` | 16000, 300000, 3 | Budget, per-attempt timeout, attempts (exponential backoff with jitter) |
| `AI_MODEL_LIGHT` / `AI_EFFORT_LIGHT` | `claude-haiku-5-5` / `low` | Natural-language query parsing |
| `AI_MAX_TOKENS_LIGHT`, `AI_TIMEOUT_MS_LIGHT`, `AI_MAX_ATTEMPTS_LIGHT` | 2048, 10000, 2 | Same, light tier |
| `AI_SERVER_FALLBACKS`, `AI_SERVER_FALLBACKS_LIGHT` | true, false | Server-side refusal fallbacks per tier |

Every attempt is logged in `ai_calls` (task, model, tokens, latency, outcome, video/user); admins
see totals in **Admin > AI usage** (`GET /v1/admin/ai/usage`).

### Promo / demo media

The 20 promo clips (`01_stepover` … `20_hero_your_skill_your_moment`) are configuration, not
code: the web app reads them from `NEXT_PUBLIC_PROMO_BASE_URL`, and the demo seed points demo
videos at `CDN_BASE_URL/DEMO_MEDIA_PREFIX/<stem>.mp4`. Every demo row is marked `is_demo` and
shown with a Demo label. The seed refuses to run when `NODE_ENV=production` unless
`ALLOW_DEMO_SEED=yes` (for a labelled preview environment).

## Testing

```sh
TEST_DATABASE_ADMIN_URL=postgres://fp:fp@localhost:5432/postgres pnpm test
```

API and worker tests run against a real PostgreSQL (a fresh database per run) and the worker
tests generate real video clips with ffmpeg. The API suite covers the critical security cases:
unauthorised users cannot reach admin routes (and staff need MFA), players cannot edit other
profiles, scouts cannot see private data or other scouts' notes, verification cannot be forged,
invalid files are refused, moderation status cannot be bypassed, and minor privacy cannot be
bypassed. CI (`.github/workflows/ci.yml`) runs build, typecheck and tests on every push.

## Deployment (free-tier friendly)

| Piece | Suggested host |
| --- | --- |
| Web | Vercel (Hobby) |
| Database, auth, storage | Supabase (Free) |
| API | Fly.io, Railway or Render (`node apps/api/dist/main.js`) |
| Worker | Same host family, using `apps/worker/Dockerfile` (includes ffmpeg) |
| CDN | Supabase Storage CDN or Cloudflare R2 public bucket |

The API also runs on Vercel: create a project with root directory `apps/api` (its `vercel.json`
routes every path to one function, `src/vercel.ts`) and point `DATABASE_URL` at Supabase's
transaction pooler (port 6543). The web app is a second Vercel project with root `apps/web`.
`apps/web/public/demo-media/promo` holds labelled placeholder clips for the demo seed until the
AI promo clips are rendered.

On Vercel the worker is a second function in the API project, `api/worker.js`, which ships static
ffmpeg/ffprobe binaries (copied into `apps/api/bin` at build). The API calls it when an upload
completes (`WORKER_TRIGGER_URL` = `https://<api>/api/worker`, `WORKER_TRIGGER_SECRET` set on the
project), and a daily cron (authenticated with Vercel's `CRON_SECRET`) picks up anything missed and
runs storage maintenance: abandoned uploads are failed, originals are removed once a video is
rejected, deleted or published for 7 days, and a deleted video's public files are removed. Each run
processes queued videos one at a time for up to `SERVERLESS_CLAIM_BUDGET_MS`, inside the 300 s
function limit. Set `RATE_LIMIT_STORE=postgres` there so limits hold across function instances.

Deploy order: database → run migrations → API → worker → web. Everything can be deployed
incrementally.

### Payments (Stripe, test mode)

Plans and prices are rows in `plans` and `plan_prices` (seeded by `db/migrations/0006_billing.sql`:
Player Free, Player Pro $4.99/mo or $49/yr with a 7-day trial, Scout Free with 20 searches a month
and 10 shortlist slots, Scout Pro $29/mo or $249/yr with a 14-day trial, Organization $99/mo for
teams of 3 to 5 with a 14-day trial, Club Pro $249/mo, Enterprise by contact). Change a price or a
limit with SQL; no deploy is needed. Another currency is another `plan_prices` row. Checkout sends
the row's amount inline, or uses a Stripe Price when `provider_price_id` is set. A free trial is
offered once per plan audience.

| Variable | Where | Purpose |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | API | Stripe **test-mode** secret key (`sk_test_…` or restricted `rk_test_…`). Live keys are refused at startup. |
| `STRIPE_WEBHOOK_SECRET` | API | Signing secret (`whsec_…`) of the webhook endpoint. Required together with the key. |
| `WEB_APP_URL` | API | Public web URL; checkout returns to `/settings?checkout=success#billing` or `/pricing?checkout=cancelled`. |
| `CRON_SECRET` | API | Bearer secret for `GET /v1/cron/billing` (daily on Vercel via `apps/api/vercel.json`; call it from any scheduler elsewhere). |
| `NEXT_PUBLIC_SALES_EMAIL` | Web | Optional address for the Enterprise "Contact sales" button. |

Without the two Stripe variables the API runs normally and `POST /v1/billing/checkout`,
`/v1/billing/portal` and `/v1/billing/webhook` answer `503 BILLING_NOT_CONFIGURED`; the web app
then says "Payments are not enabled yet". To turn payments on in test mode:

1. In the Stripe Dashboard (test mode) copy the secret key, and add a webhook endpoint
   `https://<api>/v1/billing/webhook` for `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted` and `invoice.payment_failed`; copy its signing secret.
2. Configure the Customer Portal (Settings > Billing > Customer portal): allow cancellation and
   payment-method updates. That is the one-click "Manage or cancel" button in Settings.
3. Set the variables above and redeploy the API. `GET /v1/plans` then reports `paymentsEnabled: true`.

Deleting an account (by its owner or a guardian) ends every subscription it holds or pays for: the
rows are closed in the deletion transaction and the provider is asked to cancel right away. If that
call fails (or payments are switched off) the deletion still completes; the row keeps
`cancel_requested_at`, the error and an attempt count, the failure is audited, and the daily
`GET /v1/cron/billing` retries it (up to 10 attempts, after which it stays listed as pending for a
person to check). Data exports (`GET /v1/me/export`) include plans, subscriptions with their dates
and coupon redemptions, never provider ids or payment details.

A paid plan is granted only when a signature-verified webhook writes the `subscriptions` row; the
redirect back from Checkout grants nothing. Webhook events are recorded by id in `billing_events`
in the same transaction as their effects, so retries and replays apply once. Coupons and referral
codes live in `coupons`; each needs the matching Stripe promotion code id
(`provider_promotion_code_id`) to be usable at checkout, or people can type a Stripe promotion code
on the Checkout page itself.

## Security

- Every protected route calls the server-side policy; roles come from the database, never the
  token or the client. Verification status can only be set by staff.
- Inputs and outputs are validated with Zod; SQL is parameterised (Kysely); responses carry
  strict security headers (helmet) and CORS is limited to the web origins.
- Per-route rate limits on registration, uploads, comments, likes, search, reports, scout
  contact and verification requests.
- Dates of birth are encrypted (AES-256-GCM); guardian invitation tokens are stored hashed;
  signed-out viewers are counted by a daily salted hash, never a raw IP.
- The audit log is append-only at the database level and records consent, safety, moderation,
  verification, scout search and admin actions.

## Analytics, North Star and feature flags

**North Star: Qualified Talent Discoveries.** A distinct (discoverer, player) pair counted on the
UTC day a verified scout (or a verified organization, for its pipeline and its contact requests)
adds an active player to a shortlist, puts or moves the player's pipeline card to Shortlisted or a
later stage other than Archived, or sends a contact request. A pair counts at most once in any 30
days. It is computed from the scouting tables themselves, so the analytics opt-out does not change
it. The exact text is `NORTH_STAR.definition` in `packages/contracts/src/analytics.ts`.

The worker's daily maintenance rolls up every finished day into `analytics_daily` (event counts,
distinct users, DAU, WAU, North Star), then deletes raw `analytics_events` older than 180 days
whose day is rolled up. DAU/WAU count signed-in people with at least one recorded event, so
people who turned analytics off are under-counted by design. Signed-out visitors are identified
only by a daily-rotating keyed hash (never stored IPs).

Feature flags live in `feature_flags`. A flag is on for a person when it is enabled, the person
matches its audience (roles, countries) and `hash(key:userId) % 100 < rollout`. Signed-out
visitors only see flags at 100 %. Changes go through `/v1/admin/flags` (admin + MFA) and are
written to the audit log; each API instance caches flags for 30 seconds.

Operations: point uptime checks at `GET /v1/health` (database ping, 503 when down) and deploy
checks at `GET /v1/ready` (503 until migration `0008_analytics_flags.sql` is applied). Send an
`x-request-id` header to correlate logs; the API echoes it (or generates one). Set
`NEXT_PUBLIC_SITE_URL` on the web app: canonical URLs, `sitemap.xml` and `robots.txt` use it.

## Moderation

Every upload is moderated before it is public. Clear severe violations are rejected; anything
ambiguous, not football, refused by the model or a suspected stolen clip goes to the human queue.
Reports on the same target merge into one case that climbs the queue; anything involving a minor
or child safety is priority 0.

## Roadmap

- **Phase 1 (core)** and **Phase 2 (talent)**: built as described above.
- **Phase 3 (intelligence)**: natural-language search to structured filters and personalised
  recommendations with user controls are built as prototypes; scout comparison and analytics
  dashboards remain.
- **Phase 4 (scale)**: PWA / mobile app, organisations and clubs (seat invites), live payments
  after legal review of the subscription terms.

Design notes: [docs/adr/0001-architecture.md](docs/adr/0001-architecture.md).
