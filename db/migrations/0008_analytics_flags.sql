-- Phase E1: product analytics, the North Star metric and feature flags.
-- Raw analytics events (180 days), daily aggregates kept indefinitely, the qualified talent
-- discoveries the North Star counts, and database-backed feature flags. Every change adds or
-- widens; existing rows and values stay valid.

-- ---------------------------------------------------------------- analytics preference
-- Off: only strictly necessary events are recorded for this person (see the event registry in
-- packages/contracts/src/analytics.ts). Like the other toggles it only ever restricts; turning it
-- back on is a loosening, which for a minor only the guardian may do.
ALTER TABLE privacy_settings ADD COLUMN allow_analytics boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------- raw events
-- One row per event. `properties` is validated per event name by the API's Zod registry before
-- it is written: ids and coarse enums only, never names, emails, free text, IPs or URLs with
-- query strings. Signed-out callers carry `anon_id`, a keyed hash that rotates daily, so they
-- cannot be followed from one day to the next. Raw rows are deleted after 180 days, once their
-- day is rolled up into analytics_daily.
CREATE TABLE analytics_events (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{1,59}$'),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  anon_id     text CHECK (anon_id ~ '^[0-9a-f]{16,64}$'),
  source      text NOT NULL CHECK (source IN ('server', 'client')),
  properties  jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(properties) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NULL OR anon_id IS NULL)
);
CREATE INDEX analytics_events_created_idx ON analytics_events (created_at);
CREATE INDEX analytics_events_name_idx ON analytics_events (name, created_at);
CREATE INDEX analytics_events_user_idx ON analytics_events (user_id, created_at) WHERE user_id IS NOT NULL;

-- ---------------------------------------------------------------- daily aggregates
-- One value per (UTC day, metric, dimension). Metrics: 'event:<name>' (count), 'users:<name>'
-- (distinct signed-in users), 'dau', 'wau', 'north_star', and '_rolled' (1 once the day has
-- been rolled up; raw events of a day are only deleted after this marker exists).
CREATE TABLE analytics_daily (
  day         date NOT NULL,
  metric      text NOT NULL CHECK (char_length(metric) BETWEEN 1 AND 80),
  dimension   text NOT NULL DEFAULT '' CHECK (char_length(dimension) <= 80),
  value       bigint NOT NULL CHECK (value >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, metric, dimension)
);

-- ---------------------------------------------------------------- North Star: qualified talent discoveries
-- One row per counted discovery: a (verified scout or verified organization, player) pair whose
-- qualifying action (shortlist add, pipeline stage >= shortlisted, contact request) happened on
-- `day`, counted at most once per pair in any 30-day window. Computed by the daily rollup from the
-- operational tables, so it never depends on anyone's analytics preference.
CREATE TABLE qualified_discoveries (
  discoverer_kind  text NOT NULL CHECK (discoverer_kind IN ('scout', 'organization')),
  discoverer_id    uuid NOT NULL,
  player_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day              date NOT NULL,
  source           text NOT NULL CHECK (source IN ('shortlist', 'pipeline', 'contact_request')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (discoverer_kind, discoverer_id, player_id, day)
);
CREATE INDEX qualified_discoveries_day_idx ON qualified_discoveries (day);
CREATE INDEX qualified_discoveries_player_idx ON qualified_discoveries (player_id);

-- ---------------------------------------------------------------- feature flags
-- A flag is on for a caller when it is enabled, the caller matches every audience rule present
-- (roles: any of; countries: any of, by the country given at sign-up), and the caller's
-- deterministic bucket (hash of flag key and user id, 0-99) is below rollout_percentage.
-- client_visible flags are returned, evaluated, by GET /v1/flags. Changes are audited in audit_logs.
CREATE TABLE feature_flags (
  key                 text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,59}$'),
  description         text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
  enabled             boolean NOT NULL DEFAULT false,
  rollout_percentage  smallint NOT NULL DEFAULT 0 CHECK (rollout_percentage BETWEEN 0 AND 100),
  audience            jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(audience) = 'object'),
  client_visible      boolean NOT NULL DEFAULT true,
  updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Nothing critical is gated; every seeded flag starts off.
INSERT INTO feature_flags (key, description, enabled, rollout_percentage) VALUES
  ('nl_scout_search', 'Natural-language scout search (turns a sentence into scout search filters).', false, 0),
  ('for_you_personalization', 'Personalised ordering of the For You feed.', false, 0),
  ('hls_streaming', 'Adaptive HLS playback instead of the single MP4 rendition.', false, 0);
