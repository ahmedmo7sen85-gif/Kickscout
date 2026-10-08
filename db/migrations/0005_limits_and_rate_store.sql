-- Shared rate-limit counters (one row per key and window) so limits hold across many API instances,
-- and the per-video duration limit the API sets from the uploader's plan when the upload starts.

CREATE TABLE rate_limit_hits (
  key       text PRIMARY KEY,
  count     integer NOT NULL,
  reset_at  timestamptz NOT NULL
);
CREATE INDEX rate_limit_hits_reset_idx ON rate_limit_hits (reset_at);

ALTER TABLE videos ADD COLUMN max_duration_ms integer CHECK (max_duration_ms > 0);

-- Storage cleanup bookkeeping: originals are dropped once a video is settled, everything is dropped once it is deleted.
ALTER TABLE videos ADD COLUMN original_purged_at timestamptz;
ALTER TABLE videos ADD COLUMN delivery_purged_at timestamptz;
