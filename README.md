# KICKSCOUT

**YOUR SKILL. YOUR MOMENT. GET DISCOVERED.**

KICKSCOUT is a football talent discovery platform. Players post short vertical clips of their
skills, fans discover and follow them, and verified scouts search, shortlist and contact talent
through a controlled, safety-first workflow. AI organises the content (skill tags, moderation);
it never rates a player's ability or "professional potential".

English first, Arabic (RTL) ready.

## What works today

| Area | What is built | Tested by |
| --- | --- | --- |
| Accounts | Supabase Auth tokens (email/password, Google) verified by the API; registration with age checks; roles PLAYER, FAN, SCOUT, MODERATOR, ADMIN (scout/staff roles are never self-assigned) | API tests |
| Minor safety | Guardian invitation + consent, private-by-default profiles and uploads, no city/email/age for the public, followers-only comments, contact-harvesting comments held, scout contact routed to the guardian, per-country age rules that apply only after legal review | API + domain tests |
| Videos | Signed direct upload, async processing queue, real-file validation (ffprobe + decode check), trim, H.264 720p transcode, thumbnail, duplicate detection, states UPLOADING → PROCESSING → ANALYZING → PUBLISHED / REVIEW_REQUIRED / REJECTED / FAILED | Worker tests (real ffmpeg clips) |
| AI | Claude vision on sampled frames: football present, players visible, context, skill tags with confidence, moderation verdict SAFE / FLAGGED / REVIEW_REQUIRED / REJECTED. AI tags are stored as AI and can be corrected by the player. Ambiguous content goes to humans, never auto-deleted | Worker tests with a stubbed Claude client (no live call made yet) |
| Feed and social | For You, Following, New Talent, Trending; like, save, comment, share, follow, block, report; views counted once per viewer per day | API tests |
| Discovery | Search (players, videos, hashtags, skills, country, position, foot), Discover page, Talent Radar with "Trending because…" reasons and categories (rising, most watched, most saved, new talents, hidden gems), challenges with direct-to-challenge upload | API + domain tests |
| Scouts | Verification by staff, filtered player search (age group, position, foot, country, skill, verified, followers), multiple shortlists, private notes, contact requests the player (or guardian) accepts or declines | API tests |
| Admin | Moderation queue (AI flags, rule hits, merged user reports) with approve / reject / remove / restrict / escalate / suspend, verification decisions, user suspend/restore, challenges, jurisdiction rules, stats, append-only audit log | API tests |
| Web app | Next.js app in the KICKSCOUT design: landing page, feed, upload flow, profiles, Discover, Talent Radar, challenges, search, scout dashboard, notifications, settings, admin | See `apps/web` |
| Demo content | Labelled demo players, scout and challenges using the 20 promo clips, refused in production | API test |

### Not built yet (and labelled as such in the product)

- Natural-language search, personalised recommendations (For You is newest-first today), scout
  comparison, direct messaging, Apple sign-in, notification preferences, paid plans: these return
  **Coming Soon** capability labels.
- Malware scanning of uploads (files are fully decoded by ffmpeg, which rejects non-video files).
- Production email for guardian invitations (`MAILER=log` prints the link; production refuses to
  start with it).
- Rate limits are per-process; use a shared store when running more than one API instance.
- Product analytics events and dashboards.

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
visible and states it is not judging ability. AI tags are stored with `source = 'ai'` and a
confidence; player corrections are stored separately.

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

Deploy order: database → run migrations → API → worker → web. Everything can be deployed
incrementally.

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

## Moderation

Every upload is moderated before it is public. Clear severe violations are rejected; anything
ambiguous, not football, refused by the model or a suspected stolen clip goes to the human queue.
Reports on the same target merge into one case that climbs the queue; anything involving a minor
or child safety is priority 0.

## Roadmap

- **Phase 1 (core)** and **Phase 2 (talent)**: built as described above.
- **Phase 3 (intelligence)**: natural-language search to structured filters, personalised
  recommendations with user controls, scout comparison, analytics dashboards.
- **Phase 4 (scale)**: PWA / mobile app, organisations and clubs, paid scout plans.

Design notes: [docs/adr/0001-architecture.md](docs/adr/0001-architecture.md).
