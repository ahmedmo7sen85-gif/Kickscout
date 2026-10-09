-- Play: a football-thinking game and training tracker. Tactics rounds (read a match situation and
-- pick the best pass, run or shot), a scanning drill, offline training drills, XP and levels, and
-- turn-based challenges between friends. Additive only: new tables, nothing existing changes.
--
-- XP measures practice done here, never a player's ability: it is shown to the player and to the
-- friend they play against, never on a public profile, to scouts or in search.

-- ---------------------------------------------------------------- friend challenges
-- Both players answer the same scenarios. Only between mutual follows who have not blocked each
-- other, and never between an adult and a minor unless the adult is that minor's guardian (checked
-- by the API policy at creation). There is no free text anywhere in a challenge.
CREATE TABLE play_challenges (
  id             uuid PRIMARY KEY,
  challenger_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opponent_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scenario_ids   text[] NOT NULL CHECK (cardinality(scenario_ids) BETWEEN 1 AND 10),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'completed', 'declined', 'expired')),
  winner_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  completed_at   timestamptz,
  CHECK (challenger_id <> opponent_id)
);
CREATE INDEX play_challenges_challenger_idx ON play_challenges (challenger_id, created_at DESC);
CREATE INDEX play_challenges_opponent_idx ON play_challenges (opponent_id, created_at DESC);

-- ---------------------------------------------------------------- tactics rounds
-- A round is a fixed list of scenario ids drawn by the server. The correct answers live only in
-- the API, so the browser never sees them before answering.
CREATE TABLE play_rounds (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_id  uuid REFERENCES play_challenges(id) ON DELETE CASCADE,
  scenario_ids  text[] NOT NULL CHECK (cardinality(scenario_ids) BETWEEN 1 AND 10),
  points        integer NOT NULL DEFAULT 0 CHECK (points >= 0),
  total_ms      integer NOT NULL DEFAULT 0 CHECK (total_ms >= 0),
  xp            integer NOT NULL DEFAULT 0 CHECK (xp >= 0),
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  UNIQUE (challenge_id, user_id)
);
CREATE INDEX play_rounds_user_idx ON play_rounds (user_id, started_at DESC);

-- One answer per scenario per round. `ms` is measured by the server from the previous answer.
CREATE TABLE play_answers (
  round_id     uuid NOT NULL REFERENCES play_rounds(id) ON DELETE CASCADE,
  scenario_id  text NOT NULL CHECK (char_length(scenario_id) BETWEEN 1 AND 40),
  option_id    text NOT NULL CHECK (char_length(option_id) BETWEEN 1 AND 8),
  points       smallint NOT NULL CHECK (points BETWEEN 0 AND 2),
  ms           integer NOT NULL CHECK (ms >= 0),
  answered_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, scenario_id)
);

-- ---------------------------------------------------------------- XP ledger
-- Every XP award is a row; totals, levels and streaks are computed from it. `ref` keys the daily
-- caps (one row per drill per day, a limited number of rounds and scan runs per day).
CREATE TABLE play_xp (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      text NOT NULL CHECK (source IN ('tactics_round', 'scan_drill', 'training_drill', 'challenge_win')),
  ref         text NOT NULL CHECK (char_length(ref) BETWEEN 1 AND 64),
  xp          integer NOT NULL CHECK (xp BETWEEN 0 AND 1000),
  day         date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source, ref, day)
);
CREATE INDEX play_xp_user_day_idx ON play_xp (user_id, day DESC);

-- ---------------------------------------------------------------- hosted Postgres (Supabase)
-- Where the API's own role exists, lock the new tables down like every other table: row level
-- security on, the public API roles revoked, and the API role allowed through its policy.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['play_challenges', 'play_rounds', 'play_answers', 'play_xp'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kickscout_api') THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
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
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kickscout_api') THEN
    GRANT USAGE, SELECT ON SEQUENCE play_xp_id_seq TO kickscout_api;
  END IF;
END $$;
