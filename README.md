# Football Talent Platform

A football talent discovery platform: short video, evidence-based AI analysis, Player DNA, and
safe scouting workflows. Arabic and English first.

Design document: https://claude.ai/code/artifact/21dccf2f-1b83-4550-9ae3-abd6f5f6158c

## What is in this repository (Phase 1 foundation)

| Path | What it is | Status |
| --- | --- | --- |
| `packages/domain` | Pure logic: age and consent rules, privacy projection, authorization policy, evidence scoring, position frameworks, Player DNA, progress, discovery vs popularity | Built, unit tested |
| `packages/contracts` | Zod API schemas and OpenAPI 3.1 generation | Built |
| `apps/api` | Fastify API: registration, guardian consent, profiles, signed uploads, feed, likes, comments, follows, blocks, reports, analysis requests, worker result intake, skill explanations, Player DNA | Built, integration tested on Postgres |
| `db/migrations` | PostgreSQL schema | Built |
| AI workers (detection, tracking, events) | Python GPU services | Not built: analysis capabilities report **Requires Model Integration** |
| Media service (scan, transcode, HLS) | Processes uploads, calls back `/internal/media/:id/processed` | Not built |
| Outbox relay, production mailer, Redis rate-limit store | Platform pieces | Not built |
| Mobile app (Expo) and web app (Next.js) | Clients | Not built |

Nothing here fakes AI output. Scores exist only when a worker has submitted observations, and
features without an implementation return their status label (Prototype, Coming Soon,
Requires Model Integration) from the API.

## Run locally

Requirements: Node 22, pnpm 10, Docker (or a local PostgreSQL 16).

```sh
pnpm install
docker compose up -d postgres
pnpm build
cp .env.example apps/api/.env   # fill in the keys
pnpm --filter @fp/api db:migrate
pnpm --filter @fp/api dev
```

Tests (need a PostgreSQL role that can create databases):

```sh
TEST_DATABASE_ADMIN_URL=postgres://fp:fp@localhost:5432/postgres pnpm test
```

OpenAPI: `GET /v1/openapi.json`, or `pnpm openapi` after a build.

## Rules the code enforces

- Authorization is server-side (`packages/domain/src/policy.ts`), called by every handler.
- Minors need guardian consent; guardians, not minors, grant a minor's consents. Minors' profiles
  start private, never show city, email or DM options to the public, and comments on their videos
  default to followers-only with stricter moderation.
- Under-13 sign-ups are refused without storing the date of birth; dates of birth are encrypted.
- A player is linked to footage only by explicit confirmation from that player or their guardian.
- Skill scores need a minimum amount of usable evidence, list every action they used, and say
  what limited them. Confidence is reported as uncalibrated until evaluated against coach labels.
- Popularity is never an input to football scores.
- The audit log is append-only at the database level.
