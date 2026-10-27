-- Football news: the state of each publisher feed and the article metadata read from it
-- (headline, the publisher's own teaser, publication time, link). No article bodies are stored.
-- Additive only. The list of sources lives in code (@fp/football NEWS_SOURCES); a row here is
-- created the first time a source is fetched, and `enabled = false` switches a source off
-- without a deploy.

CREATE TABLE news_sources (
  id               text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 60),
  enabled          boolean NOT NULL DEFAULT true,
  etag             text CHECK (char_length(etag) <= 300),
  last_modified    text CHECK (char_length(last_modified) <= 100),
  last_attempt_at  timestamptz,
  last_success_at  timestamptz,
  last_error       text CHECK (char_length(last_error) <= 300),
  last_error_at    timestamptz,
  failures         integer NOT NULL DEFAULT 0 CHECK (failures >= 0),   -- consecutive
  next_fetch_at    timestamptz NOT NULL DEFAULT now(),                  -- claim: no fetch before this
  item_count       integer NOT NULL DEFAULT 0 CHECK (item_count >= 0)   -- items in the last good fetch
);

CREATE TABLE news_articles (
  id            uuid PRIMARY KEY,
  source_id     text NOT NULL REFERENCES news_sources(id) ON DELETE CASCADE,
  url           text NOT NULL UNIQUE CHECK (url LIKE 'https://%' AND char_length(url) <= 2000),
  title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  title_key     text NOT NULL CHECK (char_length(title_key) <= 200),
  summary       text CHECK (char_length(summary) <= 300),
  image_url     text CHECK (image_url LIKE 'https://%' AND char_length(image_url) <= 2000),
  language      text NOT NULL CHECK (language IN ('en', 'ar')),
  region        text NOT NULL CHECK (region IN ('global', 'africa', 'europe', 'asia', 'north-america', 'south-america', 'oceania')),
  country       text CHECK (country ~ '^[A-Z]{2}$'),
  topics        text[] NOT NULL DEFAULT '{}',
  rumour        boolean NOT NULL DEFAULT false,
  published_at  timestamptz NOT NULL,                 -- the publisher's time
  imported_at   timestamptz NOT NULL DEFAULT now(),   -- when KICKSCOUT first read it
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX news_articles_published_idx ON news_articles (published_at DESC, id DESC);
CREATE INDEX news_articles_region_idx ON news_articles (region, published_at DESC);
CREATE INDEX news_articles_language_idx ON news_articles (language, published_at DESC);
CREATE INDEX news_articles_source_idx ON news_articles (source_id, published_at DESC);
CREATE INDEX news_articles_title_key_idx ON news_articles (title_key);
CREATE INDEX news_articles_topics_idx ON news_articles USING gin (topics);

-- ---------------------------------------------------------------- row level security (Supabase)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['news_sources', 'news_articles'] LOOP
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
