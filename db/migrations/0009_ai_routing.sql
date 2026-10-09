-- Phase E2: AI provider routing and cost accounting, the model behind every AI tag, a database
-- guard against rating-like fields in stored AI output, and recommendation preferences.
-- Additive only: new tables, new nullable columns, new constraints that apply to new writes.

-- ---------------------------------------------------------------- AI call accounting
-- One row per attempt the AI router makes (retries are separate rows), with its token usage.
CREATE TABLE ai_calls (
  id              uuid PRIMARY KEY,
  task            text NOT NULL CHECK (task IN ('video_analysis', 'nl_scout_query')),
  provider        text NOT NULL,                -- 'anthropic', 'fake' in tests
  model           text NOT NULL,                -- model the router asked for
  response_model  text,                         -- model that answered (after any server-side fallback)
  effort          text NOT NULL,
  input_tokens    integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens   integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  latency_ms      integer NOT NULL CHECK (latency_ms >= 0),
  outcome         text NOT NULL CHECK (outcome IN ('ok', 'refusal', 'truncated', 'invalid_output', 'timeout', 'error')),
  attempt         smallint NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  video_id        uuid REFERENCES videos(id) ON DELETE SET NULL,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  error           text CHECK (char_length(error) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_calls_task_time_idx ON ai_calls (task, created_at DESC);
CREATE INDEX ai_calls_video_idx ON ai_calls (video_id) WHERE video_id IS NOT NULL;
CREATE INDEX ai_calls_user_idx ON ai_calls (user_id) WHERE user_id IS NOT NULL;

-- ---------------------------------------------------------------- model version per AI result
-- The model that produced each AI skill tag, and the model behind a video's AI analysis.
ALTER TABLE video_skills ADD COLUMN model text;
ALTER TABLE video_skills ADD CONSTRAINT video_skills_model_ai_only CHECK (model IS NULL OR source = 'ai') NOT VALID;
ALTER TABLE videos ADD COLUMN ai_model text;

-- ---------------------------------------------------------------- no ratings, ever
-- AI tags and assists; it never rates a player. Stored AI JSON may not carry a rating-like key at
-- any depth. Mirrors FORBIDDEN_AI_KEY in packages/ai/src/guard.ts. NOT VALID: applies to every new
-- write without rescanning old rows (none carry such keys).
CREATE FUNCTION ai_json_has_forbidden_key(j jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT j IS NOT NULL AND EXISTS (
    SELECT 1 FROM jsonb_path_query(j, 'strict $.**') AS node
    WHERE jsonb_typeof(node) = 'object'
      AND EXISTS (SELECT 1 FROM jsonb_object_keys(node) AS k
                  WHERE k ~* '(rating|potential|score|grade|rank|overall|talent_?level)' OR k ~* '^ability$')
  )
$$;
ALTER TABLE videos ADD CONSTRAINT videos_ai_summary_no_ratings CHECK (NOT ai_json_has_forbidden_key(ai_summary)) NOT VALID;
ALTER TABLE moderation_cases ADD CONSTRAINT moderation_cases_ai_verdict_no_ratings CHECK (NOT ai_json_has_forbidden_key(ai_verdict)) NOT VALID;

-- ---------------------------------------------------------------- recommendations with user controls
-- One row per user who changed a setting. No row = defaults (personalize on, nothing reset).
CREATE TABLE recommendation_preferences (
  user_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  personalize       boolean NOT NULL DEFAULT true,
  -- likes and saves before this moment no longer shape the For You feed ("reset history")
  history_reset_at  timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- "Not interested" signals. A video hides that clip; the clip's player and skill lose their boost.
CREATE TABLE recommendation_signals (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'not_interested' CHECK (kind IN ('not_interested')),
  target_kind  text NOT NULL CHECK (target_kind IN ('video', 'player', 'skill')),
  target_id    text NOT NULL CHECK (char_length(target_id) BETWEEN 1 AND 64),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, target_kind, target_id)
);
