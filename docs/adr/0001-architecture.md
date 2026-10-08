# ADR 0001: Phase 1 architecture

Date: 2026-10-08
Status: accepted (pending owner review)

## Decision

- TypeScript monorepo (pnpm workspaces, Turborepo).
- API: Fastify modular monolith with Zod contracts. The design doc proposed NestJS; Fastify was
  chosen for the first build because it is lighter, has no decorator metadata, and the module
  boundaries (one folder per bounded context, no cross-module table access) give the same
  structure. Revisit if the team prefers Nest's DI.
- PostgreSQL 16 with SQL migrations and Kysely (typed, parameterized queries; types generated
  from the live schema).
- Authentication through a managed identity provider; the API verifies JWTs against its JWKS
  and keeps all authorization (roles, consent, age) in its own database.
- Video bytes never pass through the API: signed S3 uploads, a separate media service, HLS on a CDN.
- AI runs outside the API. Workers post agent runs and observations to an internal endpoint;
  the API aggregates them deterministically (`@fp/domain`).

## Consequences

- Every score is reproducible from stored observations and versioned methods.
- The media service, AI workers, outbox relay and production mailer are separate pieces still to build.
