-- Phase C: plans, entitlements and billing.
-- Plans and prices are configuration in the database, not code: the API reads them for the pricing
-- page, for checkout and for entitlements. Prices are stored per currency in minor units (cents for
-- USD), so another currency is a new row, not a code change. Only USD is seeded.
-- Subscriptions are written only by verified payment-provider webhooks and are the single source of
-- truth for paid entitlements; a browser redirect after checkout never grants anything.
-- Everything here is new; no existing table changes.

-- ---------------------------------------------------------------- plans
-- audience: who can buy it. player plans need the player role; scout, organization and club plans
-- need a verified scout (the scout role).
-- checkout_mode: 'none' (free, nothing to buy), 'self_serve' (Checkout), 'contact_sales' (no checkout).
-- features: FEATURE_* flags (see packages/domain/src/entitlements.ts for the known keys).
-- limits: camelCase keys. A missing key falls back to the default (the API's configured free-plan
-- upload limits, or zero scout quota); JSON null means unlimited.
CREATE TABLE plans (
  key            text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  audience       text NOT NULL CHECK (audience IN ('player', 'scout', 'organization')),
  tier           text NOT NULL CHECK (tier IN ('free', 'pro', 'organization', 'club', 'enterprise')),
  names          jsonb NOT NULL,                 -- {"en": "...", "ar": "..."}
  descriptions   jsonb NOT NULL,
  checkout_mode  text NOT NULL CHECK (checkout_mode IN ('none', 'self_serve', 'contact_sales')),
  trial_days     smallint NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 90),
  features       text[] NOT NULL DEFAULT '{}',
  limits         jsonb NOT NULL DEFAULT '{}',
  sort_order     smallint NOT NULL DEFAULT 0,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One price per plan, currency and billing interval. provider_price_id is optional: when set,
-- Checkout uses that catalogue price; when empty, Checkout sends this row's amount inline.
CREATE TABLE plan_prices (
  id                 uuid PRIMARY KEY,
  plan_key           text NOT NULL REFERENCES plans(key),
  currency           char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  billing_interval   text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  amount_minor       integer NOT NULL CHECK (amount_minor > 0),
  provider_price_id  text,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_key, currency, billing_interval)
);

INSERT INTO plans (key, audience, tier, names, descriptions, checkout_mode, trial_days, features, limits, sort_order) VALUES
  ('player_free', 'player', 'free',
   '{"en":"Player Free","ar":"اللاعب المجاني"}',
   '{"en":"Post your skills and get discovered.","ar":"انشر مهاراتك ودع الكشافين يكتشفونك."}',
   'none', 0, '{}', '{}', 10),
  ('player_pro', 'player', 'pro',
   '{"en":"Player Pro","ar":"اللاعب برو"}',
   '{"en":"Longer clips, more videos and profile analytics.","ar":"مقاطع أطول وفيديوهات أكثر وتحليلات للملف الشخصي."}',
   'self_serve', 7, '{FEATURE_EXTENDED_UPLOADS,FEATURE_PRO_ANALYTICS}',
   '{"maxVideoSeconds":180,"maxActiveVideos":100,"maxUploadsPerDay":30}', 20),
  ('scout_free', 'scout', 'free',
   '{"en":"Scout Free","ar":"الكشاف المجاني"}',
   '{"en":"Search verified talent with monthly limits.","ar":"ابحث عن المواهب ضمن حدود شهرية."}',
   'none', 0, '{}', '{"scoutSearchesPerMonth":20,"shortlistSlots":10,"seats":1}', 30),
  ('scout_pro', 'scout', 'pro',
   '{"en":"Scout Pro","ar":"الكشاف برو"}',
   '{"en":"Unlimited search and shortlists for one scout.","ar":"بحث وقوائم مختصرة بلا حدود لكشاف واحد."}',
   'self_serve', 14, '{FEATURE_UNLIMITED_SCOUT_SEARCH,FEATURE_UNLIMITED_SHORTLISTS,FEATURE_PRO_ANALYTICS}',
   '{"scoutSearchesPerMonth":null,"shortlistSlots":null,"seats":1}', 40),
  ('organization', 'organization', 'organization',
   '{"en":"Organization","ar":"المؤسسة"}',
   '{"en":"For scouting teams of 3 to 5 people.","ar":"لفرق الكشافة من 3 إلى 5 أشخاص."}',
   'self_serve', 14, '{FEATURE_UNLIMITED_SCOUT_SEARCH,FEATURE_UNLIMITED_SHORTLISTS,FEATURE_PRO_ANALYTICS,FEATURE_TEAM_SEATS}',
   '{"scoutSearchesPerMonth":null,"shortlistSlots":null,"seats":5}', 50),
  ('club_pro', 'organization', 'club',
   '{"en":"Club Pro","ar":"النادي برو"}',
   '{"en":"For clubs and academies with a full scouting department.","ar":"للأندية والأكاديميات التي لديها قسم كشافة كامل."}',
   'self_serve', 0, '{FEATURE_UNLIMITED_SCOUT_SEARCH,FEATURE_UNLIMITED_SHORTLISTS,FEATURE_PRO_ANALYTICS,FEATURE_TEAM_SEATS,FEATURE_PRIORITY_SUPPORT}',
   '{"scoutSearchesPerMonth":null,"shortlistSlots":null,"seats":10}', 60),
  ('enterprise', 'organization', 'enterprise',
   '{"en":"Enterprise","ar":"المؤسسات الكبرى"}',
   '{"en":"Custom terms for federations, leagues and large groups.","ar":"شروط مخصصة للاتحادات والدوريات والمجموعات الكبيرة."}',
   'contact_sales', 0, '{FEATURE_UNLIMITED_SCOUT_SEARCH,FEATURE_UNLIMITED_SHORTLISTS,FEATURE_PRO_ANALYTICS,FEATURE_TEAM_SEATS,FEATURE_PRIORITY_SUPPORT,FEATURE_API_ACCESS}',
   '{"scoutSearchesPerMonth":null,"shortlistSlots":null}', 70);

INSERT INTO plan_prices (id, plan_key, currency, billing_interval, amount_minor) VALUES
  ('01920000-0000-7000-8000-000000000001', 'player_pro',   'USD', 'month',   499),
  ('01920000-0000-7000-8000-000000000002', 'player_pro',   'USD', 'year',   4900),
  ('01920000-0000-7000-8000-000000000003', 'scout_pro',    'USD', 'month',  2900),
  ('01920000-0000-7000-8000-000000000004', 'scout_pro',    'USD', 'year',  24900),
  ('01920000-0000-7000-8000-000000000005', 'organization', 'USD', 'month',  9900),
  ('01920000-0000-7000-8000-000000000006', 'club_pro',     'USD', 'month', 24900);

-- ---------------------------------------------------------------- provider records
-- The payment provider's customer for the person who pays (a guardian pays for a minor).
CREATE TABLE billing_customers (
  user_id               uuid PRIMARY KEY REFERENCES users(id),
  provider              text NOT NULL,
  provider_customer_id  text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_customer_id)
);

-- Checkout sessions we created, so a completed checkout can be matched to who started it.
-- Completing one grants nothing by itself; the subscription events do.
CREATE TABLE checkout_sessions (
  provider_session_id  text PRIMARY KEY,
  provider             text NOT NULL,
  user_id              uuid NOT NULL REFERENCES users(id),     -- who the plan is for
  payer_user_id        uuid NOT NULL REFERENCES users(id),     -- who pays (the guardian for a minor)
  plan_key             text NOT NULL REFERENCES plans(key),
  price_id             uuid NOT NULL REFERENCES plan_prices(id),
  coupon_code          citext,
  trial_days           smallint NOT NULL DEFAULT 0,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'expired')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz
);
CREATE INDEX checkout_sessions_user_idx ON checkout_sessions (user_id, created_at DESC);

-- Mirror of the provider's subscriptions, written only from verified webhooks.
-- Grants entitlements while status is trialing, active or past_due (the provider is still retrying
-- payment) and the current period has not ended.
CREATE TABLE subscriptions (
  id                        uuid PRIMARY KEY,
  user_id                   uuid NOT NULL REFERENCES users(id),
  payer_user_id             uuid REFERENCES users(id),
  plan_key                  text NOT NULL REFERENCES plans(key),
  provider                  text NOT NULL,
  provider_subscription_id  text NOT NULL,
  provider_customer_id      text,
  status                    text NOT NULL CHECK (status IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due',
                                                            'canceled', 'unpaid', 'paused')),
  billing_interval          text CHECK (billing_interval IN ('month', 'year')),
  currency                  char(3),
  amount_minor              integer,
  trial_end                 timestamptz,
  current_period_end        timestamptz,
  cancel_at_period_end      boolean NOT NULL DEFAULT false,
  canceled_at               timestamptz,
  -- Time of the provider event this row reflects; older events arriving late are ignored.
  provider_event_at         timestamptz NOT NULL,
  -- Cancellations we start ourselves (account deletion). The row is closed locally at once;
  -- provider_canceled_at is set once the provider confirms, otherwise the error is kept for a retry.
  cancel_requested_at       timestamptz,
  cancel_reason             text,
  provider_canceled_at      timestamptz,
  provider_cancel_attempts  integer NOT NULL DEFAULT 0,
  provider_cancel_error     text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subscription_id)
);
CREATE INDEX subscriptions_user_idx ON subscriptions (user_id, status);
CREATE INDEX subscriptions_payer_idx ON subscriptions (payer_user_id);
CREATE INDEX subscriptions_cancel_pending_idx ON subscriptions (cancel_requested_at)
  WHERE cancel_requested_at IS NOT NULL AND provider_canceled_at IS NULL;

-- Webhook idempotency: one row per provider event id, written in the same transaction as the
-- event's effects, so a replayed or retried event is applied once.
CREATE TABLE billing_events (
  provider      text NOT NULL,
  event_id      text NOT NULL,
  type          text NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

-- ---------------------------------------------------------------- coupons and referral codes
-- Validated by the API before checkout; applied at checkout through the provider's promotion code
-- (provider_promotion_code_id). A code without one cannot be used at checkout yet.
CREATE TABLE coupons (
  code                        citext PRIMARY KEY CHECK (code ~* '^[a-z0-9_-]{3,40}$'),
  kind                        text NOT NULL DEFAULT 'coupon' CHECK (kind IN ('coupon', 'referral')),
  referrer_user_id            uuid REFERENCES users(id),
  description                 text,
  percent_off                 smallint CHECK (percent_off BETWEEN 1 AND 100),
  amount_off_minor            integer CHECK (amount_off_minor > 0),
  currency                    char(3),
  duration                    text NOT NULL DEFAULT 'once' CHECK (duration IN ('once', 'repeating', 'forever')),
  duration_months             smallint CHECK (duration_months > 0),
  plan_keys                   text[],               -- null: any paid plan
  max_redemptions             integer CHECK (max_redemptions > 0),
  redeemed_count              integer NOT NULL DEFAULT 0,
  valid_from                  timestamptz,
  valid_until                 timestamptz,
  provider_promotion_code_id  text,
  active                      boolean NOT NULL DEFAULT true,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK ((percent_off IS NULL) <> (amount_off_minor IS NULL)),
  CHECK (amount_off_minor IS NULL OR currency IS NOT NULL),
  CHECK (duration <> 'repeating' OR duration_months IS NOT NULL)
);

CREATE TABLE coupon_redemptions (
  code                 citext NOT NULL REFERENCES coupons(code),
  user_id              uuid NOT NULL REFERENCES users(id),
  provider_session_id  text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code, user_id)
);

-- ---------------------------------------------------------------- usage
-- Metered usage per user and period (e.g. scout searches per calendar month, 'YYYY-MM' in UTC).
CREATE TABLE usage_counters (
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  metric   text NOT NULL,
  period   text NOT NULL,
  count    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, metric, period)
);
