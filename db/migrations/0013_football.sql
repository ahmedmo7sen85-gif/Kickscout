-- Football utility: a shared cache of football-data provider answers, a directory of teams and
-- competitions seen in that data, favourites, Web Push subscriptions, match alert preferences,
-- the match snapshots alerts are derived from, and a delivery log that makes every alert
-- idempotent. Additive only. Numbered 0013 so it does not collide with open PRs (0010-0012);
-- the migration runner applies any missing file in name order, so merge order does not matter.

-- ---------------------------------------------------------------- provider cache (shared by all instances)
CREATE TABLE football_cache (
  key            text PRIMARY KEY CHECK (char_length(key) <= 200),
  provider       text NOT NULL,
  payload        jsonb,                         -- null until the first successful fetch
  fetched_at     timestamptz,                   -- last successful fetch
  fresh_until    timestamptz,
  last_error     text CHECK (char_length(last_error) <= 300),
  last_error_at  timestamptz,
  failures       integer NOT NULL DEFAULT 0 CHECK (failures >= 0),   -- consecutive
  retry_after    timestamptz                    -- backoff: no provider call before this
);
CREATE INDEX football_cache_provider_idx ON football_cache (provider, fetched_at DESC);

-- ---------------------------------------------------------------- directory (from provider data, for search and favourites)
CREATE TABLE football_teams (
  provider      text NOT NULL,
  id            text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 80),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  logo_url      text CHECK (logo_url LIKE 'https://%'),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, id)
);
CREATE INDEX football_teams_name_idx ON football_teams (provider, lower(name));

CREATE TABLE football_competitions (
  provider      text NOT NULL,
  id            text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 80),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  logo_url      text CHECK (logo_url LIKE 'https://%'),
  area          text CHECK (char_length(area) <= 80),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, id)
);
CREATE INDEX football_competitions_name_idx ON football_competitions (provider, lower(name));

-- ---------------------------------------------------------------- favourites (one row per user and team/competition)
CREATE TABLE favorite_teams (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    text NOT NULL,
  team_id     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider, team_id),
  FOREIGN KEY (provider, team_id) REFERENCES football_teams (provider, id)
);
CREATE INDEX favorite_teams_team_idx ON favorite_teams (provider, team_id);

CREATE TABLE favorite_competitions (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  competition_id  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider, competition_id),
  FOREIGN KEY (provider, competition_id) REFERENCES football_competitions (provider, id)
);
CREATE INDEX favorite_competitions_comp_idx ON favorite_competitions (provider, competition_id);

-- ---------------------------------------------------------------- match alerts (Web Push)
-- No row = alerts off. Categories default to the few that matter most, to avoid alert fatigue.
CREATE TABLE football_alert_preferences (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled        boolean NOT NULL DEFAULT false,
  starting_soon  boolean NOT NULL DEFAULT false,
  kickoff        boolean NOT NULL DEFAULT true,
  goal           boolean NOT NULL DEFAULT true,
  halftime       boolean NOT NULL DEFAULT false,
  final_result   boolean NOT NULL DEFAULT true,
  lineups        boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- A browser's push subscription. The endpoint is a capability URL of a push service; it is never
-- returned by the API after it is stored. Deleted when the push service says it is gone.
CREATE TABLE push_subscriptions (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint         text NOT NULL UNIQUE CHECK (endpoint LIKE 'https://%' AND char_length(endpoint) <= 1000),
  p256dh           text NOT NULL CHECK (char_length(p256dh) BETWEEN 40 AND 200),
  auth             text NOT NULL CHECK (char_length(auth) BETWEEN 8 AND 64),
  locale           text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'ar', 'es', 'pt', 'fr')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_success_at  timestamptz,
  failures         integer NOT NULL DEFAULT 0 CHECK (failures >= 0)
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- Last observed state of every match someone follows; alerts are transitions from this row.
CREATE TABLE football_match_states (
  provider           text NOT NULL,
  match_id           text NOT NULL,
  status             text NOT NULL,
  home_score         smallint,
  away_score         smallint,
  kickoff            timestamptz NOT NULL,
  lineups_confirmed  boolean NOT NULL DEFAULT false,
  observed_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, match_id)
);
CREATE INDEX football_match_states_observed_idx ON football_match_states (observed_at);

-- One row per (alert, subscription): the primary key is the idempotency guarantee.
CREATE TABLE push_deliveries (
  alert_key        text NOT NULL CHECK (char_length(alert_key) <= 300),
  subscription_id  uuid NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  category         text NOT NULL,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'gone')),
  attempts         smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error       text CHECK (char_length(last_error) <= 300),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_key, subscription_id)
);
CREATE INDEX push_deliveries_retry_idx ON push_deliveries (status, created_at) WHERE status = 'failed';

-- ---------------------------------------------------------------- Supabase advisor: fixed search_path
ALTER FUNCTION ai_json_has_forbidden_key(jsonb) SET search_path = pg_catalog, public;

-- ---------------------------------------------------------------- row level security (Supabase)
-- Same rule as every other table: no access through Supabase's Data API (anon/authenticated), and
-- the API's own role works through an explicit policy because it does not bypass RLS.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['football_cache', 'football_teams', 'football_competitions', 'favorite_teams', 'favorite_competitions',
                           'football_alert_preferences', 'push_subscriptions', 'football_match_states', 'push_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kickscout_api') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO kickscout_api', t);
      EXECUTE format('CREATE POLICY api_all ON %I TO kickscout_api USING (true) WITH CHECK (true)', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON %I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON %I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;
