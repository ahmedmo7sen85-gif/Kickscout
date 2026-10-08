-- Phase D: organizations and the scout CRM.
-- Organizations (academies, clubs, agencies, schools) with members, roles and email invitations;
-- verification by type (identity, player, scout, organization); a per-owner recruitment pipeline
-- (a scout's own, or an organization's) with stage history, private notes and tags; saved searches
-- with in-app alerts. Every change adds or widens; existing rows and values stay valid.

-- ---------------------------------------------------------------- organizations
-- Public: name, type, country, verified, logo. Members are never listed publicly.
CREATE TABLE organizations (
  id            uuid PRIMARY KEY,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  type          text NOT NULL CHECK (type IN ('academy', 'club', 'agency', 'school', 'other')),
  country_code  char(2) CHECK (country_code ~ '^[A-Z]{2}$'),
  logo_key      text,
  verified_at   timestamptz,                    -- set only by an approved organization verification request
  -- suspended: hidden by a moderation decision; deleted: removed by its owner (CRM data is erased)
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

-- Roles: owner (everything, incl. delete and transfer), admin (manage members), scout (full CRM),
-- analyst (read + notes), viewer (read only). Exactly one owner per organization.
CREATE TABLE organization_members (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('owner', 'admin', 'scout', 'analyst', 'viewer')),
  added_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX organization_members_user_idx ON organization_members (user_id);
CREATE UNIQUE INDEX organization_one_owner_idx ON organization_members (organization_id) WHERE role = 'owner';

-- Only the hash of the emailed token is stored. Ownership is never granted by invitation.
CREATE TABLE organization_invitations (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           citext NOT NULL,
  role            text NOT NULL CHECK (role IN ('admin', 'scout', 'analyst', 'viewer')),
  token_hash      bytea NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  invited_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  responded_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  responded_at    timestamptz
);
CREATE UNIQUE INDEX organization_invitation_pending_idx ON organization_invitations (organization_id, email) WHERE status = 'pending';

-- ---------------------------------------------------------------- verification by type
-- identity: the person is who they say; player / scout as before; organization: the organization is real
-- and the applicant (its owner or an admin) represents it.
ALTER TABLE verification_requests DROP CONSTRAINT verification_requests_kind_check;
ALTER TABLE verification_requests ADD CONSTRAINT verification_requests_kind_check
  CHECK (kind IN ('identity', 'player', 'scout', 'organization'));
ALTER TABLE verification_requests ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE verification_requests ADD CONSTRAINT verification_requests_organization_check
  CHECK ((kind = 'organization') = (organization_id IS NOT NULL));
-- One pending request per person and type; organization requests are one pending per organization
-- (a person may represent several).
DROP INDEX verification_pending_idx;
CREATE UNIQUE INDEX verification_pending_idx ON verification_requests (user_id, kind) WHERE status = 'pending' AND kind <> 'organization';
CREATE UNIQUE INDEX verification_pending_org_idx ON verification_requests (organization_id) WHERE status = 'pending';

-- ---------------------------------------------------------------- contact requests on behalf of an organization
-- The scout who sends it is still the sender; the organization is shown to the player or guardian.
ALTER TABLE contact_requests ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- scout CRM
-- One card per player per owner scope: a scout's personal pipeline (owner_user_id) or an
-- organization's (organization_id). Private to that scope; never shown to the player.
CREATE TABLE crm_entries (
  id                  uuid PRIMARY KEY,
  owner_user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  organization_id     uuid REFERENCES organizations(id) ON DELETE CASCADE,
  player_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage               text NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'watching', 'shortlisted', 'monitoring',
                        'contact_requested', 'contacted', 'evaluation', 'archived')),
  tags                text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 20),
  -- set when the card moved to contact_requested through the contact-request flow
  contact_request_id  uuid REFERENCES contact_requests(id) ON DELETE SET NULL,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_user_id IS NULL) <> (organization_id IS NULL))
);
CREATE UNIQUE INDEX crm_entries_personal_idx ON crm_entries (owner_user_id, player_id) WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX crm_entries_org_idx ON crm_entries (organization_id, player_id) WHERE organization_id IS NOT NULL;
CREATE INDEX crm_entries_player_idx ON crm_entries (player_id);

-- Who moved a card, from where to where, and when. Append-only in practice (also in audit_logs).
CREATE TABLE crm_stage_history (
  id          uuid PRIMARY KEY,
  entry_id    uuid NOT NULL REFERENCES crm_entries(id) ON DELETE CASCADE,
  from_stage  text,
  to_stage    text NOT NULL,
  changed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_stage_history_entry_idx ON crm_stage_history (entry_id, created_at);

-- Notes private to the entry's owner scope.
CREATE TABLE crm_notes (
  id          uuid PRIMARY KEY,
  entry_id    uuid NOT NULL REFERENCES crm_entries(id) ON DELETE CASCADE,
  author_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_notes_entry_idx ON crm_notes (entry_id, created_at DESC);

-- ---------------------------------------------------------------- saved searches and alerts
-- `filters` holds scout-search filters, validated by the API's scout search schema. With alerts on,
-- newly published clips whose player matches create an in-app notification for `created_by`.
CREATE TABLE saved_searches (
  id                 uuid PRIMARY KEY,
  owner_user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  organization_id    uuid REFERENCES organizations(id) ON DELETE CASCADE,
  created_by         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  filters            jsonb NOT NULL DEFAULT '{}',
  alerts_enabled     boolean NOT NULL DEFAULT false,
  -- clips published before this are never alerted (set when alerts are switched on)
  alerts_since       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_user_id IS NULL) <> (organization_id IS NULL))
);
CREATE INDEX saved_searches_personal_idx ON saved_searches (owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX saved_searches_org_idx ON saved_searches (organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX saved_searches_alerts_idx ON saved_searches (id) WHERE alerts_enabled;

-- One row per (saved search, clip) already alerted, so matching can re-scan an overlapping window
-- and never notify twice.
CREATE TABLE saved_search_hits (
  saved_search_id  uuid NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
  video_id         uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  player_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (saved_search_id, video_id)
);
CREATE INDEX saved_search_hits_player_idx ON saved_search_hits (player_id);
