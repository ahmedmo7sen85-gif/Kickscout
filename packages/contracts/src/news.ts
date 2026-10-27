/**
 * Football news contracts. Every article names its publisher and links to the original; the
 * publisher's publication time and KICKSCOUT's import time are separate fields.
 */
import { z } from 'zod';

const Iso = z.string();

export const NewsRegion = z.enum(['global', 'africa', 'europe', 'asia', 'north-america', 'south-america', 'oceania']);
export const NewsTopic = z.enum(['transfers', 'injuries', 'match-report', 'managers', 'national-teams', 'talent', 'general']);
export const NewsLanguage = z.enum(['en', 'ar']);

export const NewsSourceView = z.object({
  id: z.string(),
  publisher: z.string(),
  section: z.string().nullable(),
  homepage: z.string(),
  language: NewsLanguage,
  region: NewsRegion,
  country: z.string().nullable(),
});

export const NewsArticleView = z.object({
  id: z.string(),
  title: z.string(),
  /** The publisher's own teaser, plain text, at most 280 characters. */
  summary: z.string().nullable(),
  /** The original article. */
  url: z.string(),
  imageUrl: z.string().nullable(),
  source: NewsSourceView,
  language: NewsLanguage,
  region: NewsRegion,
  country: z.string().nullable(),
  /** Detected from the headline and the publisher's categories: a label, not an editorial judgement. */
  topics: z.array(NewsTopic),
  /** The publisher presents this as rumour or gossip. */
  rumour: z.boolean(),
  publishedAt: Iso,
  importedAt: Iso,
});

export const NewsListQuery = z.object({
  region: NewsRegion.optional(),
  language: NewsLanguage.optional(),
  topic: NewsTopic.optional(),
  source: z.string().max(60).optional(),
  q: z.string().trim().min(2).max(80).optional(),
  rumours: z.enum(['include', 'exclude']).default('include'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const NewsListView = z.object({
  items: z.array(NewsArticleView),
  nextCursor: z.string().nullable(),
  /** Last successful read of any source (null before the first one). */
  updatedAt: Iso.nullable(),
  /** Sources whose last read failed; their older articles are still listed. */
  failingSources: z.array(z.object({ id: z.string(), name: z.string() })),
  refreshEverySeconds: z.number().int(),
});

export const NewsSourcesView = z.object({
  refreshEverySeconds: z.number().int(),
  retentionDays: z.number().int(),
  sources: z.array(NewsSourceView.extend({
    feedUrl: z.string(),
    termsUrl: z.string(),
    enabled: z.boolean(),
    lastSuccessAt: Iso.nullable(),
    lastErrorAt: Iso.nullable(),
    lastError: z.string().nullable(),
    failures: z.number().int(),
    itemCount: z.number().int(),
  })),
});

export const NewsCronReport = z.object({
  attempted: z.number().int(),
  succeeded: z.number().int(),
  notModified: z.number().int(),
  failed: z.array(z.object({ source: z.string(), kind: z.string() })),
  inserted: z.number().int(),
  skippedDuplicates: z.number().int(),
});
