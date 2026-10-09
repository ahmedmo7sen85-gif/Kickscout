-- KICKSCOUT Challenges: skill challenges entered with a short video, judged against a versioned
-- rubric, with leaderboards, results, badges, appeals and scout picks. See docs/challenges.md.
--
-- Extends the existing `challenges` table in place (the demo rows keep working) and adds the rest.
-- A challenge never publishes a video: a submission only follows `videos.status`, which the
-- mandatory video safety pipeline owns. The database enforces that a submission can be judged or
-- approved only while its video is published.
--
-- Rollback: db/rollbacks/0011_challenges.down.sql

-- ---------------------------------------------------------------- challenges (extended)
ALTER TABLE challenges
  ADD COLUMN status            text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'active', 'judging', 'completed', 'archived', 'paused', 'cancelled')),
  ADD COLUMN is_template       boolean NOT NULL DEFAULT false,
  ADD COLUMN template_key      text CHECK (template_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  ADD COLUMN format            text NOT NULL DEFAULT 'standard'
    CHECK (format IN ('standard', 'daily', 'weekly', 'monthly_cup', 'beat_my_skill')),
  ADD COLUMN category          text NOT NULL DEFAULT 'freestyle'
    CHECK (category IN ('ball_control', 'dribbling', 'first_touch', 'freestyle', 'shooting', 'weak_foot', 'combo')),
  ADD COLUMN difficulty        text NOT NULL DEFAULT 'beginner' CHECK (difficulty IN ('beginner', 'intermediate', 'advanced', 'expert')),
  ADD COLUMN age_groups        text[] NOT NULL DEFAULT ARRAY['u13', 'u16', 'u18', 'adult']
    CHECK (cardinality(age_groups) > 0 AND age_groups <@ ARRAY['u13', 'u16', 'u18', 'adult']),
  ADD COLUMN instructions      jsonb NOT NULL DEFAULT '{"en": "", "ar": ""}' CHECK (jsonb_typeof(instructions) = 'object'),
  -- [{"en": "...", "ar": "..."}]
  ADD COLUMN equipment         jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(equipment) = 'array'),
  ADD COLUMN safety_notes      jsonb CHECK (safety_notes IS NULL OR jsonb_typeof(safety_notes) = 'object'),
  -- {"camera": "side|front|behind|any", "orientation": "vertical|horizontal|any", "continuousTake": true, "notes": {...}}
  ADD COLUMN recording         jsonb NOT NULL DEFAULT '{"camera": "any", "orientation": "any", "continuousTake": true}' CHECK (jsonb_typeof(recording) = 'object'),
  ADD COLUMN min_duration_s    smallint NOT NULL DEFAULT 3 CHECK (min_duration_s BETWEEN 1 AND 180),
  ADD COLUMN max_duration_s    smallint NOT NULL DEFAULT 60 CHECK (max_duration_s BETWEEN 1 AND 180),
  ADD COLUMN timezone          text NOT NULL DEFAULT 'UTC' CHECK (char_length(timezone) BETWEEN 1 AND 64),
  ADD COLUMN attempt_limit     smallint NOT NULL DEFAULT 3 CHECK (attempt_limit BETWEEN 1 AND 10),
  -- A clip the platform could not process (or that the safety pipeline rejected) does not use up an attempt.
  ADD COLUMN retry_failed      boolean NOT NULL DEFAULT true,
  -- Another person appears in the clip (e.g. a panna): the entrant must confirm that person's consent.
  ADD COLUMN requires_partner  boolean NOT NULL DEFAULT false,
  ADD COLUMN visibility        text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'unlisted')),
  ADD COLUMN featured          boolean NOT NULL DEFAULT false,
  ADD COLUMN voting_enabled    boolean NOT NULL DEFAULT true,
  -- Non-cash recognition only (no prizes, paid entry or betting), as bilingual text.
  ADD COLUMN reward            jsonb CHECK (reward IS NULL OR jsonb_typeof(reward) = 'object'),
  ADD COLUMN thumbnail_key     text,
  ADD COLUMN demo_video_id     uuid REFERENCES videos(id) ON DELETE SET NULL,
  ADD COLUMN results_published_at timestamptz,
  ADD COLUMN updated_at        timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT challenges_duration_order CHECK (min_duration_s <= max_duration_s);

-- Existing rows were live by their dates; keep them that way.
UPDATE challenges SET status = CASE WHEN now() < starts_at THEN 'scheduled' WHEN now() < ends_at THEN 'active' ELSE 'completed' END;
UPDATE challenges SET results_published_at = ends_at WHERE status = 'completed';

CREATE INDEX challenges_status_idx ON challenges (status, ends_at) WHERE NOT is_template;

-- ---------------------------------------------------------------- rules and rubric versions
CREATE TABLE challenge_rules (
  id            uuid PRIMARY KEY,
  challenge_id  uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('eligibility', 'disqualification', 'safety', 'recording', 'general')),
  body          jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  sort          smallint NOT NULL DEFAULT 0
);
CREATE INDEX challenge_rules_challenge_idx ON challenge_rules (challenge_id, kind, sort);

-- The rubric shape is validated by the API (packages/domain/src/challenges/rubric.ts). A version is
-- frozen when the challenge starts and can never change after that: everyone is judged the same way.
CREATE TABLE challenge_rubric_versions (
  id            uuid PRIMARY KEY,
  challenge_id  uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  version       integer NOT NULL CHECK (version >= 1),
  method        text NOT NULL CHECK (method IN ('measured', 'judged')),
  rubric        jsonb NOT NULL CHECK (jsonb_typeof(rubric) = 'object'),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  frozen_at     timestamptz,
  UNIQUE (challenge_id, version)
);

CREATE FUNCTION challenge_rubric_frozen_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.frozen_at IS NOT NULL THEN
    -- Deleting the challenge (cascade) is the only way a frozen version goes away.
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM challenges WHERE id = OLD.challenge_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'rubric version % is frozen', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER challenge_rubric_frozen BEFORE UPDATE OR DELETE ON challenge_rubric_versions
  FOR EACH ROW EXECUTE FUNCTION challenge_rubric_frozen_guard();

ALTER TABLE challenges ADD COLUMN rubric_version_id uuid REFERENCES challenge_rubric_versions(id);

-- A challenge's rubric must be its own, and cannot be swapped once the current one is frozen.
CREATE FUNCTION challenge_rubric_switch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rubric_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM challenge_rubric_versions WHERE id = NEW.rubric_version_id AND challenge_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'rubric version belongs to another challenge' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.rubric_version_id IS DISTINCT FROM NEW.rubric_version_id AND OLD.rubric_version_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM challenge_rubric_versions WHERE id = OLD.rubric_version_id AND frozen_at IS NOT NULL) THEN
    RAISE EXCEPTION 'the rubric of a started challenge cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER challenge_rubric_switch BEFORE INSERT OR UPDATE OF rubric_version_id ON challenges
  FOR EACH ROW EXECUTE FUNCTION challenge_rubric_switch_guard();

-- Existing challenges get a simple judged rubric so their entries can be judged.
INSERT INTO challenge_rubric_versions (id, challenge_id, version, method, rubric, frozen_at)
SELECT gen_random_uuid(), c.id, 1, 'judged',
  '{"method": "judged", "unit": "points", "direction": "higher",
    "components": [
      {"key": "execution", "kind": "criterion", "weight": 0.4, "max": 10, "label": {"en": "Execution", "ar": "التنفيذ"}},
      {"key": "control", "kind": "criterion", "weight": 0.3, "max": 10, "label": {"en": "Ball control", "ar": "التحكم بالكرة"}},
      {"key": "difficulty", "kind": "criterion", "weight": 0.3, "max": 10, "label": {"en": "Difficulty", "ar": "الصعوبة"}}
    ],
    "tieBreakers": ["earliest_submission"], "minJudges": 1, "tolerance": 15,
    "summary": {"en": "Judges score execution, ball control and difficulty from 0 to 10. The weighted result is out of 100.",
                "ar": "يقيّم الحكام التنفيذ والتحكم بالكرة والصعوبة من 0 إلى 10. النتيجة الموزونة من 100."}}'::jsonb,
  CASE WHEN c.status IN ('active', 'judging', 'completed') THEN now() END
FROM challenges c;
UPDATE challenges c SET rubric_version_id = r.id FROM challenge_rubric_versions r WHERE r.challenge_id = c.id;

-- ---------------------------------------------------------------- participation and submissions
CREATE TABLE challenge_participations (
  id             uuid PRIMARY KEY,
  challenge_id   uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn', 'disqualified')),
  -- Who shared the invite link, when it was valid (never the player themselves).
  invited_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  safety_ack_at  timestamptz,
  joined_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (challenge_id, user_id),
  CHECK (invited_by IS NULL OR invited_by <> user_id)
);
CREATE INDEX challenge_participations_user_idx ON challenge_participations (user_id, joined_at DESC);

CREATE TABLE challenge_submissions (
  id                    uuid PRIMARY KEY,
  challenge_id          uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  participation_id      uuid NOT NULL REFERENCES challenge_participations(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id              uuid NOT NULL UNIQUE REFERENCES videos(id) ON DELETE CASCADE,
  attempt_no            smallint NOT NULL CHECK (attempt_no BETWEEN 1 AND 50),
  state                 text NOT NULL DEFAULT 'pending_upload' CHECK (state IN (
                          'pending_upload', 'processing', 'pending_moderation', 'pending_judging',
                          'approved', 'rejected', 'disqualified', 'failed_processing', 'withdrawn')),
  state_reason          text CHECK (char_length(state_reason) <= 500),
  rubric_version_id     uuid NOT NULL REFERENCES challenge_rubric_versions(id),
  -- The player's own number (touches, seconds, hits). Shown to judges as a claim, never used as a score.
  claimed_value         numeric(12, 3) CHECK (claimed_value >= 0),
  consent_others_at     timestamptz,
  safety_ack_at         timestamptz,
  -- Beat My Skill: the approved entry this one answers.
  target_submission_id  uuid REFERENCES challenge_submissions(id) ON DELETE SET NULL,
  idempotency_key       text CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  verification          jsonb,
  judging_round         smallint NOT NULL DEFAULT 1 CHECK (judging_round >= 1),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  approved_at           timestamptz,
  UNIQUE (participation_id, attempt_no)
);
CREATE UNIQUE INDEX challenge_submissions_idem_idx ON challenge_submissions (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX challenge_submissions_state_idx ON challenge_submissions (challenge_id, state, created_at);
CREATE INDEX challenge_submissions_user_idx ON challenge_submissions (user_id, created_at DESC);

CREATE TABLE challenge_submission_reviews (
  id             uuid PRIMARY KEY,
  submission_id  uuid NOT NULL REFERENCES challenge_submissions(id) ON DELETE CASCADE,
  -- A person, or null with `agent` set for an automated check.
  reviewer_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  agent          text CHECK (agent ~ '^[a-z_]{2,40}$'),
  kind           text NOT NULL CHECK (kind IN ('verification', 'judging', 'admin', 'appeal')),
  decision       text NOT NULL CHECK (decision IN ('pass', 'fail', 'score', 'disqualify', 'escalate', 'reinstate')),
  round          smallint NOT NULL DEFAULT 1,
  components     jsonb CHECK (components IS NULL OR jsonb_typeof(components) = 'object'),
  value          numeric(14, 3),
  evidence       jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(evidence) = 'array'),
  notes          text CHECK (char_length(notes) <= 1000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (reviewer_id IS NOT NULL OR agent IS NOT NULL)
);
CREATE INDEX challenge_reviews_submission_idx ON challenge_submission_reviews (submission_id, created_at);
-- One judging review per judge per round.
CREATE UNIQUE INDEX challenge_reviews_one_per_judge_idx ON challenge_submission_reviews (submission_id, reviewer_id, round) WHERE kind = 'judging' AND reviewer_id IS NOT NULL;

CREATE TABLE challenge_scores (
  id                 uuid PRIMARY KEY,
  submission_id      uuid NOT NULL REFERENCES challenge_submissions(id) ON DELETE CASCADE,
  rubric_version_id  uuid NOT NULL REFERENCES challenge_rubric_versions(id),
  method             text NOT NULL CHECK (method IN ('measured', 'judged')),
  value              numeric(14, 3) NOT NULL,
  penalties          numeric(14, 3) NOT NULL DEFAULT 0,
  -- Null for human judging (people do not report a probability); set only for a validated model.
  confidence         numeric(4, 3) CHECK (confidence BETWEEN 0 AND 1),
  -- [{"atMs": 1200, "note": "..."}]
  evidence           jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(evidence) = 'array'),
  review_status      text NOT NULL DEFAULT 'confirmed' CHECK (review_status IN ('confirmed', 'disputed', 'overturned')),
  judges             uuid[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  superseded_at      timestamptz
);
CREATE UNIQUE INDEX challenge_scores_current_idx ON challenge_scores (submission_id) WHERE superseded_at IS NULL;

CREATE TABLE challenge_score_components (
  score_id  uuid NOT NULL REFERENCES challenge_scores(id) ON DELETE CASCADE,
  key       text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,40}$'),
  value     numeric(14, 3) NOT NULL,
  PRIMARY KEY (score_id, key)
);

-- The database refuses a judged or approved submission whose video is not published, an approval
-- without a current confirmed score, and any change to a withdrawn submission.
CREATE FUNCTION challenge_submission_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE vstatus text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.state = 'withdrawn' AND NEW.state <> 'withdrawn' THEN
    RAISE EXCEPTION 'a withdrawn submission cannot change state' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IN ('pending_judging', 'approved') THEN
    SELECT status INTO vstatus FROM videos WHERE id = NEW.video_id;
    IF vstatus IS DISTINCT FROM 'published' THEN
      RAISE EXCEPTION 'submission % cannot be %: its video is %', NEW.id, NEW.state, coalesce(vstatus, 'missing') USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.state = 'approved' AND NOT EXISTS (
    SELECT 1 FROM challenge_scores WHERE submission_id = NEW.id AND superseded_at IS NULL AND review_status = 'confirmed'
  ) THEN
    RAISE EXCEPTION 'submission % has no confirmed score', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER challenge_submission_state BEFORE INSERT OR UPDATE ON challenge_submissions
  FOR EACH ROW EXECUTE FUNCTION challenge_submission_state_guard();

-- When a challenge video changes status (published, rejected, removed, failed, deleted), queue a
-- sync so the submission follows. Whatever moderation path moved the video, this fires.
CREATE FUNCTION challenge_video_status_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM challenge_submissions WHERE video_id = NEW.id) THEN
    INSERT INTO jobs (kind, payload) VALUES ('challenge.sync', jsonb_build_object('videoId', NEW.id));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER challenge_video_status AFTER UPDATE OF status ON videos
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION challenge_video_status_changed();

-- ---------------------------------------------------------------- votes, picks, judges, head-to-head
CREATE TABLE challenge_votes (
  challenge_id   uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  submission_id  uuid NOT NULL REFERENCES challenge_submissions(id) ON DELETE CASCADE,
  voter_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Votes the anti-fraud checks set aside are kept for review but never counted.
  eligible       boolean NOT NULL DEFAULT true,
  flag_reason    text CHECK (flag_reason ~ '^[a-z_]{2,40}$'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (submission_id, voter_id)
);
CREATE INDEX challenge_votes_voter_idx ON challenge_votes (challenge_id, voter_id);
CREATE INDEX challenge_votes_time_idx ON challenge_votes (submission_id, created_at);

CREATE TABLE challenge_judges (
  challenge_id  uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, user_id)
);
CREATE INDEX challenge_judges_user_idx ON challenge_judges (user_id);

CREATE TABLE challenge_scout_picks (
  challenge_id   uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  scout_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  submission_id  uuid NOT NULL REFERENCES challenge_submissions(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, scout_id, submission_id)
);
CREATE INDEX challenge_scout_picks_submission_idx ON challenge_scout_picks (submission_id);

CREATE TABLE challenge_head_to_heads (
  id             uuid PRIMARY KEY,
  challenge_id   uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  challenger_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opponent_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'completed', 'expired', 'cancelled')),
  winner_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  responded_at   timestamptz,
  completed_at   timestamptz,
  CHECK (challenger_id <> opponent_id)
);
CREATE UNIQUE INDEX challenge_h2h_open_pair_idx ON challenge_head_to_heads
  (challenge_id, LEAST(challenger_id, opponent_id), GREATEST(challenger_id, opponent_id)) WHERE status IN ('pending', 'accepted');
CREATE INDEX challenge_h2h_opponent_idx ON challenge_head_to_heads (opponent_id, created_at DESC);
CREATE INDEX challenge_h2h_challenger_idx ON challenge_head_to_heads (challenger_id, created_at DESC);

-- ---------------------------------------------------------------- leaderboards, badges, appeals
-- Live leaderboards are computed from scores; a snapshot is written when results are published
-- (kind 'final', one per scope) and on demand by an authorized recalculation.
CREATE TABLE challenge_leaderboard_snapshots (
  id                 bigserial PRIMARY KEY,
  challenge_id       uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  scope              text NOT NULL CHECK (scope ~ '^(overall|country:[A-Z]{2})$'),
  kind               text NOT NULL CHECK (kind IN ('final', 'recalculated')),
  rubric_version_id  uuid NOT NULL REFERENCES challenge_rubric_versions(id),
  entries            jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array'),
  computed_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  computed_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX challenge_snapshots_idx ON challenge_leaderboard_snapshots (challenge_id, scope, computed_at DESC);

CREATE TABLE challenge_badges (
  key          text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name         jsonb NOT NULL,
  description  jsonb NOT NULL,
  icon         text NOT NULL DEFAULT 'trophy',
  sort         smallint NOT NULL DEFAULT 0
);
INSERT INTO challenge_badges (key, name, description, icon, sort) VALUES
  ('first_entry', '{"en": "First Entry", "ar": "أول مشاركة"}', '{"en": "Your first approved challenge entry.", "ar": "أول مشاركة معتمدة لك في تحدٍ."}', 'trophy', 1),
  ('podium', '{"en": "Podium", "ar": "منصة التتويج"}', '{"en": "Finished in the top three of a challenge.", "ar": "أنهيت ضمن المراكز الثلاثة الأولى في تحدٍ."}', 'trophy', 2),
  ('winner', '{"en": "Challenge Winner", "ar": "بطل التحدي"}', '{"en": "Won a challenge.", "ar": "فزت بتحدٍ."}', 'trophy', 3),
  ('community_favorite', '{"en": "Community Favorite", "ar": "المفضل لدى المجتمع"}', '{"en": "Most eligible community votes in a challenge.", "ar": "أكثر الأصوات المؤهلة من المجتمع في تحدٍ."}', 'heart', 4),
  ('scout_pick', '{"en": "Scout Pick", "ar": "اختيار الكشافين"}', '{"en": "Picked by a verified scout.", "ar": "اختارك كشاف موثّق."}', 'star', 5),
  ('personal_best', '{"en": "Personal Best", "ar": "أفضل رقم شخصي"}', '{"en": "Beat your own best in a challenge type.", "ar": "تفوقت على أفضل رقم لك في نوع من التحديات."}', 'bolt', 6),
  ('streak_3', '{"en": "Three-Week Streak", "ar": "ثلاثة أسابيع متتالية"}', '{"en": "Approved entries in three weeks in a row.", "ar": "مشاركات معتمدة في ثلاثة أسابيع متتالية."}', 'flame', 7),
  ('all_rounder', '{"en": "All-Rounder", "ar": "اللاعب الشامل"}', '{"en": "Approved entries in four different categories.", "ar": "مشاركات معتمدة في أربع فئات مختلفة."}', 'star', 8);

CREATE TABLE user_challenge_badges (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_key      text NOT NULL REFERENCES challenge_badges(key),
  challenge_id   uuid REFERENCES challenges(id) ON DELETE SET NULL,
  submission_id  uuid REFERENCES challenge_submissions(id) ON DELETE SET NULL,
  awarded_at     timestamptz NOT NULL DEFAULT now()
);
-- Once per badge per challenge (and once ever for the badges that are not tied to one challenge).
CREATE UNIQUE INDEX user_challenge_badges_once_idx ON user_challenge_badges
  (user_id, badge_key, coalesce(challenge_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE challenge_appeals (
  id             uuid PRIMARY KEY,
  submission_id  uuid NOT NULL REFERENCES challenge_submissions(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason         text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 1000),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'upheld', 'rejected')),
  resolution     text CHECK (char_length(resolution) <= 1000),
  resolved_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz
);
CREATE UNIQUE INDEX challenge_appeals_open_idx ON challenge_appeals (submission_id) WHERE status = 'open';
CREATE INDEX challenge_appeals_status_idx ON challenge_appeals (status, created_at);

-- ---------------------------------------------------------------- notifications and agents
-- Idempotency ledger: one row per (person, dedupe key), so a retried job never notifies twice.
-- `notification_id` is null when the person's preferences or the daily cap suppressed it.
CREATE TABLE challenge_notifications (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dedupe_key       text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 3 AND 200),
  kind             text NOT NULL,
  notification_id  uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, dedupe_key)
);
CREATE INDEX challenge_notifications_day_idx ON challenge_notifications (user_id, created_at DESC);

-- One row per run of a challenge agent: the standard log every agent emits.
CREATE TABLE challenge_agent_runs (
  id               bigserial PRIMARY KEY,
  agent            text NOT NULL CHECK (agent IN ('recommendation', 'verification', 'scoring', 'anti_fraud', 'seo', 'operations', 'notification')),
  agent_version    text NOT NULL,
  provider         text,
  model            text,
  latency_ms       integer NOT NULL CHECK (latency_ms >= 0),
  outcome          text NOT NULL CHECK (outcome IN ('ok', 'routed_to_human', 'flagged', 'skipped', 'error')),
  confidence       numeric(4, 3) CHECK (confidence BETWEEN 0 AND 1),
  cost_usd_micros  bigint NOT NULL DEFAULT 0 CHECK (cost_usd_micros >= 0),
  trace_id         text NOT NULL CHECK (char_length(trace_id) BETWEEN 8 AND 64),
  subject_kind     text,
  subject_id       uuid,
  detail           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object'),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX challenge_agent_runs_idx ON challenge_agent_runs (agent, created_at DESC);
CREATE INDEX challenge_agent_runs_subject_idx ON challenge_agent_runs (subject_id) WHERE subject_id IS NOT NULL;

-- The challenge slice of the append-only audit trail.
CREATE VIEW challenge_audit_logs WITH (security_invoker = true) AS
  SELECT * FROM audit_logs
  WHERE target_kind IN ('challenge', 'challenge_submission', 'challenge_appeal', 'challenge_vote', 'challenge_h2h');

-- ---------------------------------------------------------------- XP (shared with Play)
-- Challenge XP lands in the Play ledger so a player has one level. Only approved entries earn it.
ALTER TABLE play_xp DROP CONSTRAINT play_xp_source_check;
ALTER TABLE play_xp ADD CONSTRAINT play_xp_source_check
  CHECK (source IN ('tactics_round', 'scan_drill', 'training_drill', 'challenge_win', 'challenge_entry', 'challenge_podium', 'challenge_award'));

-- ---------------------------------------------------------------- hosted Postgres (Supabase)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'challenge_rules', 'challenge_rubric_versions', 'challenge_participations', 'challenge_submissions',
    'challenge_submission_reviews', 'challenge_scores', 'challenge_score_components', 'challenge_votes',
    'challenge_judges', 'challenge_scout_picks', 'challenge_head_to_heads', 'challenge_leaderboard_snapshots',
    'challenge_badges', 'user_challenge_badges', 'challenge_appeals', 'challenge_notifications', 'challenge_agent_runs'
  ] LOOP
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
    GRANT USAGE, SELECT ON SEQUENCE challenge_leaderboard_snapshots_id_seq, challenge_agent_runs_id_seq TO kickscout_api;
    GRANT SELECT ON challenge_audit_logs TO kickscout_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON challenge_audit_logs FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON challenge_audit_logs FROM authenticated;
  END IF;
END $$;
