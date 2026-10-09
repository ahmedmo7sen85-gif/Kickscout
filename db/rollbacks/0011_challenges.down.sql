-- Rollback for 0011_challenges.sql. Removes every challenge table and column the migration added and
-- restores the Play XP source check. Challenge data (submissions, scores, votes, badges) is lost;
-- the videos themselves and the original challenges/challenge_entries rows stay.
-- Run in one transaction, then: DELETE FROM schema_migrations WHERE name = '0011_challenges.sql';

DELETE FROM play_xp WHERE source IN ('challenge_entry', 'challenge_podium', 'challenge_award');
ALTER TABLE play_xp DROP CONSTRAINT play_xp_source_check;
ALTER TABLE play_xp ADD CONSTRAINT play_xp_source_check
  CHECK (source IN ('tactics_round', 'scan_drill', 'training_drill', 'challenge_win'));

DROP VIEW IF EXISTS challenge_audit_logs;
DROP TRIGGER IF EXISTS challenge_video_status ON videos;
DROP FUNCTION IF EXISTS challenge_video_status_changed();
DELETE FROM jobs WHERE kind = 'challenge.sync';

DROP TABLE IF EXISTS challenge_agent_runs, challenge_notifications, challenge_appeals, user_challenge_badges, challenge_badges,
  challenge_leaderboard_snapshots, challenge_head_to_heads, challenge_scout_picks, challenge_judges, challenge_votes,
  challenge_score_components, challenge_scores, challenge_submission_reviews, challenge_submissions, challenge_participations,
  challenge_rules CASCADE;
DROP FUNCTION IF EXISTS challenge_submission_state_guard();

DROP TRIGGER IF EXISTS challenge_rubric_switch ON challenges;
DROP FUNCTION IF EXISTS challenge_rubric_switch_guard();
ALTER TABLE challenges DROP COLUMN IF EXISTS rubric_version_id;
DROP TABLE IF EXISTS challenge_rubric_versions CASCADE;
DROP FUNCTION IF EXISTS challenge_rubric_frozen_guard();

-- Challenges created after the migration (not the original demo rows) only make sense with the new columns.
DELETE FROM challenges WHERE is_template;
DROP INDEX IF EXISTS challenges_status_idx;
ALTER TABLE challenges
  DROP CONSTRAINT IF EXISTS challenges_duration_order,
  DROP COLUMN status, DROP COLUMN is_template, DROP COLUMN template_key, DROP COLUMN format, DROP COLUMN category,
  DROP COLUMN difficulty, DROP COLUMN age_groups, DROP COLUMN instructions, DROP COLUMN equipment, DROP COLUMN safety_notes,
  DROP COLUMN recording, DROP COLUMN min_duration_s, DROP COLUMN max_duration_s, DROP COLUMN timezone, DROP COLUMN attempt_limit,
  DROP COLUMN retry_failed, DROP COLUMN requires_partner, DROP COLUMN visibility, DROP COLUMN featured, DROP COLUMN voting_enabled,
  DROP COLUMN reward, DROP COLUMN thumbnail_key, DROP COLUMN demo_video_id, DROP COLUMN results_published_at, DROP COLUMN updated_at;
