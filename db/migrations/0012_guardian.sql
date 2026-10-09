-- KICKSCOUT Guardian: the football-relevance and content-safety gate every upload passes before it
-- can be public. Extends the existing videos / moderation_cases / audit_logs model rather than
-- adding a parallel moderation system. Additive: new tables, new columns with safe defaults, and
-- constraints that hold for the existing rows after the backfill below.

-- ---------------------------------------------------------------- safety status on videos
-- The Guardian decision for a video, separate from its processing lifecycle (videos.status).
-- A video can be public only while this is APPROVED; the check below enforces that in the database.
ALTER TABLE videos ADD COLUMN safety_status text NOT NULL DEFAULT 'PENDING_SCAN'
  CHECK (safety_status IN ('PENDING_SCAN', 'PROCESSING', 'APPROVED', 'REJECTED', 'HUMAN_REVIEW', 'SCAN_FAILED', 'REMOVED'));
-- Processed files waiting in private quarantine storage (originals bucket). The public delivery
-- keys (playback_key, thumbnail_key) are only written once a video is approved and published.
ALTER TABLE videos ADD COLUMN quarantine_playback_key text;
ALTER TABLE videos ADD COLUMN quarantine_thumbnail_key text;
-- Suspected child sexual abuse material: evidence is preserved (no purge) and access is restricted.
ALTER TABLE videos ADD COLUMN legal_hold boolean NOT NULL DEFAULT false;
ALTER TABLE videos ADD COLUMN safety_checked_at timestamptz;

UPDATE videos SET safety_status = CASE status
  WHEN 'published' THEN 'APPROVED'
  WHEN 'rejected' THEN 'REJECTED'
  WHEN 'review_required' THEN 'HUMAN_REVIEW'
  WHEN 'failed' THEN 'SCAN_FAILED'
  WHEN 'processing' THEN 'PROCESSING'
  WHEN 'analyzing' THEN 'PROCESSING'
  WHEN 'deleted' THEN 'REMOVED'
  ELSE 'PENDING_SCAN' END;

ALTER TABLE videos ADD CONSTRAINT videos_published_requires_approval CHECK (status <> 'published' OR safety_status = 'APPROVED');
CREATE INDEX videos_safety_idx ON videos (safety_status, created_at);

-- ---------------------------------------------------------------- upload restrictions
-- Escalating enforcement for repeated violations. Paid plans do not change any of this.
ALTER TABLE users ADD COLUMN upload_restricted_until timestamptz;
ALTER TABLE users ADD COLUMN upload_restriction_reason text CHECK (char_length(upload_restriction_reason) <= 500);

-- ---------------------------------------------------------------- scan results
-- One row per Guardian scan of a video (upload, re-scan after a report, re-scan after a policy or
-- model change). These are content-safety probabilities about the clip, never a rating of the player.
CREATE TABLE video_moderation_results (
  id                       uuid PRIMARY KEY,
  video_id                 uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  scan_kind                text NOT NULL DEFAULT 'upload' CHECK (scan_kind IN ('upload', 'rescan', 'report', 'policy_update')),
  football_relevance_score numeric(4,3) CHECK (football_relevance_score BETWEEN 0 AND 1),
  safety_scores            jsonb NOT NULL DEFAULT '{}',     -- {"sexual": 0.02, "nudity": 0.01, ...}
  detected_categories      text[] NOT NULL DEFAULT '{}',
  confidence               numeric(4,3) CHECK (confidence BETWEEN 0 AND 1),
  suspicious_timestamps    jsonb NOT NULL DEFAULT '[]',     -- [{"atMs": 4200, "categories": ["sexual"], "probability": 0.91}]
  frames_analyzed          integer NOT NULL DEFAULT 0 CHECK (frames_analyzed >= 0),
  stages                   text[] NOT NULL DEFAULT '{}',    -- integrity, screen, deep, text, audio, duplicate
  decision                 text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED', 'HUMAN_REVIEW', 'SCAN_FAILED')),
  reason_codes             text[] NOT NULL DEFAULT '{}',
  review_required          boolean NOT NULL DEFAULT false,
  explanation              text CHECK (char_length(explanation) <= 2000),
  model_version            text,                           -- every model that answered, e.g. "screen:claude-haiku-5-5;deep:claude-opus-5-5"
  policy_version           text NOT NULL,
  retry                    jsonb,                          -- {"attempt": 2, "maxAttempts": 3, "lastError": "..."} on a failed scan
  latency_ms               integer CHECK (latency_ms >= 0),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX video_moderation_results_video_idx ON video_moderation_results (video_id, created_at DESC);
CREATE INDEX video_moderation_results_decision_idx ON video_moderation_results (decision, created_at DESC);

-- ---------------------------------------------------------------- cases
ALTER TABLE moderation_cases ADD COLUMN user_id uuid REFERENCES users(id);            -- the account the case is about
ALTER TABLE moderation_cases ADD COLUMN reason text CHECK (char_length(reason) <= 500);
ALTER TABLE moderation_cases ADD COLUMN assigned_reviewer uuid REFERENCES users(id);
ALTER TABLE moderation_cases ADD COLUMN appeal_status text CHECK (appeal_status IN ('requested', 'upheld', 'overturned'));
-- Child-safety cases: admins only, no previews for ordinary moderators.
ALTER TABLE moderation_cases ADD COLUMN restricted boolean NOT NULL DEFAULT false;
ALTER TABLE moderation_cases ADD COLUMN result_id uuid REFERENCES video_moderation_results(id) ON DELETE SET NULL;
CREATE INDEX moderation_cases_user_idx ON moderation_cases (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX moderation_cases_assignee_idx ON moderation_cases (assigned_reviewer) WHERE status = 'open';

-- ---------------------------------------------------------------- appeals
-- A player's (or guardian's) request to look again at a rejected or removed video.
CREATE TABLE moderation_appeals (
  id            uuid PRIMARY KEY,
  video_id      uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id),        -- who filed it (owner or guardian)
  case_id       uuid REFERENCES moderation_cases(id),      -- the review case opened for it
  explanation   text NOT NULL CHECK (char_length(explanation) BETWEEN 10 AND 2000),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'upheld', 'overturned')),
  decided_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
CREATE UNIQUE INDEX moderation_appeals_pending_idx ON moderation_appeals (video_id) WHERE status = 'pending';
CREATE INDEX moderation_appeals_status_idx ON moderation_appeals (status, created_at);

-- ---------------------------------------------------------------- strikes
-- Confirmed violations on an account; they drive escalating enforcement and expire.
CREATE TABLE account_strikes (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id    uuid REFERENCES videos(id) ON DELETE SET NULL,
  case_id     uuid REFERENCES moderation_cases(id) ON DELETE SET NULL,
  category    text NOT NULL,
  severity    text NOT NULL CHECK (severity IN ('minor', 'serious', 'critical')),
  source      text NOT NULL CHECK (source IN ('auto', 'reviewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  voided_at   timestamptz                                  -- set when an appeal overturns the decision
);
CREATE INDEX account_strikes_user_idx ON account_strikes (user_id, created_at DESC) WHERE voided_at IS NULL;
CREATE UNIQUE INDEX account_strikes_video_idx ON account_strikes (video_id, category) WHERE voided_at IS NULL;

-- ---------------------------------------------------------------- perceptual hashes
-- 64-bit difference hashes of sampled frames (and their mirror images), for spotting edited
-- re-uploads of rejected videos. Hashes are one signal among several, never the only one.
CREATE TABLE video_frame_hashes (
  video_id  uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  at_ms     integer NOT NULL CHECK (at_ms >= 0),
  dhash     bigint NOT NULL,
  mirrored  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (video_id, at_ms, mirrored)
);

-- ---------------------------------------------------------------- moderation audit trail
-- The existing append-only audit_logs table carries the case, and the moderation audit log is a view
-- over it, so there is one audit trail.
ALTER TABLE audit_logs ADD COLUMN case_id uuid;
CREATE INDEX audit_logs_case_idx ON audit_logs (case_id, created_at) WHERE case_id IS NOT NULL;
CREATE VIEW moderation_audit_logs WITH (security_invoker = true) AS
  SELECT id, case_id, actor_id, action, created_at AS "timestamp", metadata, target_kind, target_id
  FROM audit_logs WHERE case_id IS NOT NULL OR action LIKE 'moderation.%' OR action LIKE 'guardian.%';

-- ---------------------------------------------------------------- AI accounting
ALTER TABLE ai_calls DROP CONSTRAINT ai_calls_task_check;
ALTER TABLE ai_calls ADD CONSTRAINT ai_calls_task_check CHECK (task IN ('video_analysis', 'video_screening', 'nl_scout_query'));

-- ---------------------------------------------------------------- access control (Supabase)
-- Same rule as every other table: no direct access for anon/authenticated; the API role only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['video_moderation_results', 'moderation_appeals', 'account_strikes', 'video_frame_hashes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE format('REVOKE ALL ON %I FROM anon', t); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE format('REVOKE ALL ON %I FROM authenticated', t); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kickscout_api') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO kickscout_api', t);
      EXECUTE format('CREATE POLICY api_all ON %I TO kickscout_api USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON moderation_audit_logs FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON moderation_audit_logs FROM authenticated; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kickscout_api') THEN GRANT SELECT ON moderation_audit_logs TO kickscout_api; END IF;
END $$;
