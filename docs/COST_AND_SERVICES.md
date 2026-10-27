# Costs and services

Every service KICKSCOUT uses or could use, what it costs, and what is switched on. Nothing paid
was activated in this work. Prices are list prices as understood on 2026-10-25; check the
provider's pricing page before relying on them.

## In use today

| Service | Used for | Plan now | Cost now | Limits that matter | When it would cost money |
| --- | --- | --- | --- | --- | --- |
| Vercel | Web app and API hosting, daily crons | Hobby | Free | Non-commercial use only; crons at most once a day; function time limits | A commercial launch needs Pro (about $20 per member per month) |
| Supabase | Postgres, Auth, Storage | Free | Free | 500 MB database, 1 GB storage, project pauses after 7 days without activity | Pro (about $25 per month) for more space, no pausing, backups |
| SportScore widget API | Football scores (default provider) | Free, no key | Free | About 10,000 requests a day per IP, 60 s cache, only live and recent matches (max 50), no standings or line-ups; "Powered by SportScore" link required on pages showing the data | Their terms do not list a paid tier for this API; for wider coverage switch provider |
| Publisher RSS/Atom feeds (BBC Sport, The Guardian, Sky Sports, CBS Sports, KingFut, NileSports, FilGoal, Kooora) | Football news headlines, each linking to the original article | Free, no key | Free | Read at most every 10 minutes per feed with conditional requests; only headline, the publisher's teaser (≤280 characters) and link are stored, for 30 days; thumbnails off. Several publishers' terms limit feed use to non-commercial purposes: review each source's `termsUrl` (in `packages/football/src/news-sources.ts`) before a commercial launch and switch off any that do not allow it | No cost; a licensed news API would cost money if a publisher refuses |
| Browser push services (FCM, Mozilla, Apple, Microsoft) | Delivering match alerts | — | Free | Per-service rate limits that a small app will not reach | No cost |
| `web-push` library, VAPID | Signing push messages | Open source | Free | — | — |
| Stripe | Checkout and billing (test mode only) | Test mode | Free | The API refuses live keys | Per-transaction fees only once live payments are approved |
| Anthropic API | Video tags and moderation; optional search parsing | Pay as you go | Only when a key is set and uploads happen | Per-task token budgets in `@fp/ai` | Per token; logged in `ai_calls` |

## Optional or proposed (not switched on)

| Service | Would be used for | Cost | Why not on yet |
| --- | --- | --- | --- |
| football-data.org | Scores by date, standings for 12 major competitions | Free tier with a key (10 requests a minute, delayed scores); paid tiers for live scores and more competitions | Needs Ahmed to register a key; its free-tier commercial-use terms should be read first |
| Supabase `pg_cron` + `pg_net` | Calling the alert job every minute | Included in Supabase (free) | Scheduling outbound calls from production needs Ahmed's approval |
| GitHub Actions schedule | Alternative scheduler | Free minutes on the current plan; 5-minute minimum interval | Too slow for goal alerts |
| Mail provider (for guardian emails) | Production email | Usually a free tier then per email | Provider not chosen yet (listed in the audit) |

## Load estimate for the football features

- Pages read the shared cache, so provider calls depend on time, not visitors: with SportScore,
  roughly one call a minute while matches are live and far fewer otherwise, well under the
  10,000 a day limit even with the alert job running every minute.
- The alert job is one API invocation a minute (about 43,000 a month), within Vercel Hobby's
  invocation allowance.
- New tables stay small: the alert job deletes match states after 3 days, deliveries after 14 days
  and cache entries a week after they went stale.
