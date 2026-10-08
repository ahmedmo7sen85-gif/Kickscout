-- Phase B: trust and accounts.
-- Taxonomy (wing-back and forward positions, more skills, video categories), privacy and discovery
-- toggles, notification preferences, account deletion, upload ownership declarations, and the
-- copyright workflow (takedown claims, counter-notices, repeat-infringer counts).
-- Every change widens or adds; existing rows and values stay valid.

-- ---------------------------------------------------------------- positions
ALTER TABLE player_profiles DROP CONSTRAINT player_profiles_primary_position_check;
ALTER TABLE player_profiles ADD CONSTRAINT player_profiles_primary_position_check
  CHECK (primary_position IN ('GK','CB','LB','RB','WB','DM','CM','AM','LW','RW','FW','ST'));
ALTER TABLE player_profiles ADD CONSTRAINT player_profiles_secondary_positions_check
  CHECK (secondary_positions <@ ARRAY['GK','CB','LB','RB','WB','DM','CM','AM','LW','RW','FW','ST']::text[]);
ALTER TABLE videos DROP CONSTRAINT videos_position_check;
ALTER TABLE videos ADD CONSTRAINT videos_position_check
  CHECK (position IN ('GK','CB','LB','RB','WB','DM','CM','AM','LW','RW','FW','ST'));

-- ---------------------------------------------------------------- skills
-- 'general' holds tags that are about the clip rather than one technique (match highlights).
ALTER TABLE skills DROP CONSTRAINT skills_category_check;
ALTER TABLE skills ADD CONSTRAINT skills_category_check
  CHECK (category IN ('dribbling', 'control', 'passing', 'shooting', 'athletic', 'defending', 'goalkeeping', 'freestyle', 'general'));

INSERT INTO skills (key, category, names, sort_order) VALUES
  ('through_ball',        'passing',     '{"en":"Through Ball","ar":"التمريرة البينية"}', 21),
  ('long_range_shooting', 'shooting',    '{"en":"Long-range Shooting","ar":"التسديد من بعيد"}', 22),
  ('finishing',           'shooting',    '{"en":"Finishing","ar":"إنهاء الهجمات"}', 23),
  ('acceleration',        'athletic',    '{"en":"Acceleration","ar":"التسارع"}', 24),
  ('tackling',            'defending',   '{"en":"Tackling","ar":"الافتكاك"}', 25),
  ('interception',        'defending',   '{"en":"Interception","ar":"قطع الكرة"}', 26),
  ('reflexes',            'goalkeeping', '{"en":"Reflexes","ar":"ردة الفعل"}', 27),
  ('ball_mastery',        'control',     '{"en":"Ball Mastery","ar":"إتقان الكرة"}', 28),
  ('skill_combo',         'freestyle',   '{"en":"Skill Combo","ar":"مزيج المهارات"}', 29),
  ('match_highlight',     'general',     '{"en":"Match Highlight","ar":"لقطة من مباراة"}', 30),
  ('la_croqueta',         'dribbling',   '{"en":"La Croqueta","ar":"لا كروكيتا"}', 31)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------- video category
-- The `context` column is the video category. Old values (match, training, freestyle, challenge,
-- other) stay valid; the rest are new.
ALTER TABLE videos DROP CONSTRAINT videos_context_check;
ALTER TABLE videos ADD CONSTRAINT videos_context_check
  CHECK (context IN ('skill', 'match', 'training', 'freestyle', 'challenge', 'goal', 'assist', 'save', 'one_v_one',
                     'tactical', 'showcase', 'other'));

-- Ownership declaration made by the uploader when starting the upload. Null for rows created before
-- the declaration existed.
ALTER TABLE videos ADD COLUMN rights_confirmed_at timestamptz;

-- ---------------------------------------------------------------- privacy and discovery
-- 'unlisted': reachable by direct link, never listed in feeds, search, Discover, Talent Radar or
-- scout search. The toggles only ever restrict; a minor's stricter defaults are enforced in code
-- whatever these say.
ALTER TABLE privacy_settings DROP CONSTRAINT privacy_settings_profile_visibility_check;
ALTER TABLE privacy_settings ADD CONSTRAINT privacy_settings_profile_visibility_check
  CHECK (profile_visibility IN ('public', 'unlisted', 'followers', 'private'));
ALTER TABLE privacy_settings
  ADD COLUMN allow_scout_discovery  boolean NOT NULL DEFAULT true,
  ADD COLUMN allow_contact_requests boolean NOT NULL DEFAULT true,
  ADD COLUMN show_country           boolean NOT NULL DEFAULT true,
  ADD COLUMN show_region            boolean NOT NULL DEFAULT true,
  ADD COLUMN show_age               boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------- notification preferences
-- In-app delivery per kind. No row means everything on. Security alerts have no column: they
-- cannot be turned off.
CREATE TABLE notification_preferences (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  follower           boolean NOT NULL DEFAULT true,
  "like"             boolean NOT NULL DEFAULT true,
  comment            boolean NOT NULL DEFAULT true,
  save_milestone     boolean NOT NULL DEFAULT true,
  challenge          boolean NOT NULL DEFAULT true,
  scout_contact      boolean NOT NULL DEFAULT true,
  shortlist_activity boolean NOT NULL DEFAULT true,
  verification       boolean NOT NULL DEFAULT true,
  announcements      boolean NOT NULL DEFAULT true,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- account deletion
-- A minor's own deletion request waits for their guardian; the account is hidden meanwhile.
ALTER TABLE users ADD COLUMN deletion_requested_at timestamptz;

-- ---------------------------------------------------------------- reports and moderation
-- 'organization' is reserved for organisation profiles (not built yet); scouts are reported as users.
ALTER TABLE reports DROP CONSTRAINT reports_target_kind_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_kind_check CHECK (target_kind IN ('video', 'comment', 'user', 'organization'));
ALTER TABLE reports DROP CONSTRAINT reports_reason_check;
ALTER TABLE reports ADD CONSTRAINT reports_reason_check
  CHECK (reason IN ('spam','harassment','hate','sexual','violence','dangerous','child_safety','impersonation','copyright',
                    'stolen_video','scam','not_football','fake_scout','inappropriate_contact','other'));
ALTER TABLE moderation_cases DROP CONSTRAINT moderation_cases_target_kind_check;
ALTER TABLE moderation_cases ADD CONSTRAINT moderation_cases_target_kind_check CHECK (target_kind IN ('video', 'comment', 'user', 'organization'));
ALTER TABLE moderation_cases DROP CONSTRAINT moderation_cases_source_check;
ALTER TABLE moderation_cases ADD CONSTRAINT moderation_cases_source_check CHECK (source IN ('ai', 'rules', 'report', 'appeal', 'copyright'));

-- ---------------------------------------------------------------- copyright
-- A takedown claim from anyone (signed in or not). Claims on the same video join its open case.
-- 'upheld' claims count towards the uploader's repeat-infringer total; 'reversed' means a
-- counter-notice restored the video.
CREATE TABLE copyright_claims (
  id                 uuid PRIMARY KEY,
  video_id           uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  claimant_name      text NOT NULL CHECK (char_length(claimant_name) BETWEEN 2 AND 120),
  claimant_email     citext NOT NULL,
  claimant_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  description        text NOT NULL CHECK (char_length(description) BETWEEN 20 AND 4000),
  good_faith         boolean NOT NULL CHECK (good_faith),
  accurate           boolean NOT NULL CHECK (accurate),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'upheld', 'rejected', 'reversed')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz
);
CREATE INDEX copyright_claims_video_idx ON copyright_claims (video_id, status);

-- The uploader's (or guardian's) answer to a removal. Reviewed as an appeal case.
CREATE TABLE copyright_counter_notices (
  id            uuid PRIMARY KEY,
  video_id      uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  submitted_by  uuid NOT NULL REFERENCES users(id),
  full_name     text NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 120),
  explanation   text NOT NULL CHECK (char_length(explanation) BETWEEN 20 AND 4000),
  good_faith    boolean NOT NULL CHECK (good_faith),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
CREATE UNIQUE INDEX copyright_counter_pending_idx ON copyright_counter_notices (video_id) WHERE status = 'pending';
