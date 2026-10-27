# Environment setup

Names only. Never put real values in the repo, in chat, or in alerts. Real values live in the
Vercel project settings (Environment Variables) and in Supabase.

## Existing variables
Everything that was already required is listed and explained in `.env.example` (database, auth,
storage, encryption keys, CORS, Stripe test mode, `CRON_SECRET`, AI). Nothing about them changed.

## New variables (API project `kickscout-api`)

| Variable | Required | What it does |
| --- | --- | --- |
| `FOOTBALL_PROVIDER` | No (default `sportscore`) | `sportscore`, `football-data`, `off`. `fixture` is for development and is refused in production |
| `FOOTBALL_DATA_API_KEY` | Only with `football-data` | Free key from football-data.org |
| `VAPID_PUBLIC_KEY` | For alerts | Web Push public key |
| `VAPID_PRIVATE_KEY` | For alerts | Web Push private key. Secret. Server only |
| `VAPID_SUBJECT` | For alerts | `mailto:` address or `https://` URL push services can contact |
| `CRON_SECRET` | For alerts | Already exists for billing; also protects `GET /v1/cron/football` and `GET /v1/cron/news` |
| `NEWS` | No (default `on`) | `off` hides football news (the API answers 503 `NEWS_DISABLED`) |
| `NEWS_SOURCES_DISABLED` | No | Comma-separated news source ids to leave out in this environment, e.g. `kooora,filgoal` |

The three VAPID variables must be set together or not at all (the API refuses to start with a
partial set). The web app needs no new variables.

### Generating VAPID keys
Run once on your own machine, inside the repo:

```sh
pnpm --filter @fp/api exec web-push generate-vapid-keys
```

Put the public and private key into the API project's environment variables (Production), set
`VAPID_SUBJECT`, and redeploy the API. Keep the private key out of chat and screenshots.
Changing the keys later makes every browser subscription invalid; people have to turn alerts on
again.

## Database
Apply `db/migrations/0013_football.sql`. It only creates tables and sets a function's
`search_path`; it changes no existing data. Locally:

```sh
DATABASE_URL=postgres://fp:fp@localhost:5432/fp_dev pnpm --filter @fp/db migrate
```

In production this waits for the owner's approval (and PRs #1–#4 bring 0010–0012; order does
not matter, the runner applies whatever is missing in name order).

## Football news
Apply `db/migrations/0014_news.sql` (two new tables, additive). Sources are listed in
`packages/football/src/news-sources.ts`; add one there, or switch one off without a deploy:

```sql
update news_sources set enabled = false where id = 'kooora';
```

No scheduler is needed: the first reader after a feed is due (every 10 minutes) triggers the read,
inside a short time budget, and every instance shares the result through the database. A
scheduler calling `GET /v1/cron/news` with the cron secret is optional. Feed health is public at
`GET /v1/news/sources`.

## Scheduler for match alerts
`GET /v1/cron/football` with `Authorization: Bearer <CRON_SECRET>` must be called about once a
minute. Vercel Hobby crons only run once a day, so use one of these (none is set up yet; each
needs the owner's go-ahead):

1. **Supabase `pg_cron` + `pg_net`** (recommended: free, already in the project, runs every
   minute). Store the secret in Supabase Vault, then schedule an HTTP GET:

   ```sql
   select cron.schedule('football-alerts', '* * * * *', $$
     select net.http_get(
       url := 'https://<api-domain>/v1/cron/football',
       headers := jsonb_build_object('Authorization', 'Bearer ' ||
         (select decrypted_secret from vault.decrypted_secrets where name = 'kickscout_cron_secret'))
     );
   $$);
   ```

2. **GitHub Actions schedule**: free, but the shortest interval is 5 minutes and runs can be
   late, so "starting soon" and goal alerts would be slow.
3. **Vercel Pro** cron (paid) or any external uptime/cron service.

Each run costs one API invocation and, at most, one provider call per stale cache key.

## Local development with test data

```sh
FOOTBALL_PROVIDER=fixture   # in apps/api/.env
```

The fixture provider serves invented matches around the current time, marked "Test data" on
every page and never indexed.
