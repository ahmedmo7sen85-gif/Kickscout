import { describe, expect, it } from 'vitest';
import type { Analysis, AnalysisOutcome } from '../src/analyzer/types.js';
import { decide } from '../src/decision.js';
import { loadConfig } from '../src/config.js';
import { SAFE } from './helpers.js';

const result = (a: Partial<Analysis> & { verdict?: Analysis['moderation']['verdict']; categories?: Analysis['moderation']['categories'] }): AnalysisOutcome => ({
  kind: 'result',
  model: 'm',
  analysis: { ...SAFE, ...a, moderation: { verdict: a.verdict ?? 'safe', categories: a.categories ?? [], explanation: 'x' } },
});
const adult = { ownerIsMinor: false, duplicateOfOtherOwner: false };
const minor = { ownerIsMinor: true, duplicateOfOtherOwner: false };

describe('decide', () => {
  it('publishes only safe, football, category-free results', () => {
    expect(decide(result({}), adult).status).toBe('published');
    expect(decide(result({}), minor).status).toBe('published');
    expect(decide(result({ categories: ['spam'] }), adult)).toMatchObject({ status: 'review_required', case: { categories: ['spam'], priority: 2 } });
    expect(decide(result({ footballPresent: false }), adult)).toMatchObject({ status: 'review_required', case: { categories: ['non_football'] } });
  });

  it('prioritises child safety and minors', () => {
    expect(decide(result({ verdict: 'flagged', categories: ['child_safety'] }), adult).case?.priority).toBe(0);
    expect(decide(result({ verdict: 'flagged', categories: ['copyright'] }), minor).case?.priority).toBe(0);
    expect(decide(result({ verdict: 'flagged', categories: ['hate'] }), adult).case?.priority).toBe(1);
    expect(decide(result({ verdict: 'review_required' }), adult)).toMatchObject({ case: { categories: ['ai_uncertain'], priority: 2 } });
  });

  it('rejects only on an explicit rejected verdict with a severe category; child safety still gets a human', () => {
    expect(decide(result({ verdict: 'rejected', categories: ['sexual'] }), adult)).toMatchObject({ status: 'rejected', case: null });
    expect(decide(result({ verdict: 'rejected', categories: ['child_safety'] }), adult)).toMatchObject({ status: 'rejected', case: { priority: 0 } });
    expect(decide(result({ verdict: 'rejected', categories: ['copyright'] }), adult).status).toBe('review_required');
    expect(decide(result({ verdict: 'flagged', categories: ['sexual'] }), adult).status).toBe('review_required');
  });

  it('never publishes without AI, after a refusal, or for another owner’s duplicate', () => {
    expect(decide(null, adult)).toMatchObject({ status: 'review_required', moderation: null, case: { categories: ['ai_unavailable'] } });
    expect(decide({ kind: 'refusal', explanation: 'no', category: null, model: 'm' }, adult)).toMatchObject({ status: 'review_required', case: { categories: ['ai_refused'], priority: 1 } });
    expect(decide(result({}), { ownerIsMinor: false, duplicateOfOtherOwner: true })).toMatchObject({ status: 'review_required', case: { categories: ['stolen_video'], priority: 1 } });
    expect(decide(null, { ownerIsMinor: true, duplicateOfOtherOwner: true })).toMatchObject({ case: { categories: ['ai_unavailable', 'stolen_video'], priority: 0 } });
  });
});

describe('config', () => {
  const base = { DATABASE_URL: 'postgres://x', S3_BUCKET_ORIGINALS: 'o', S3_BUCKET_DELIVERY: 'd' };
  it('applies defaults and treats an empty API key as unset', () => {
    const c = loadConfig({ ...base, ANTHROPIC_API_KEY: '' });
    expect(c.ANTHROPIC_API_KEY).toBeUndefined();
    expect(c).toMatchObject({ AI_MODEL: 'claude-opus-5-5', WORKER_CONCURRENCY: 1, S3_FORCE_PATH_STYLE: false, AI_SERVER_FALLBACKS: true });
    expect(loadConfig({ ...base, S3_FORCE_PATH_STYLE: 'true', WORKER_CONCURRENCY: '3' })).toMatchObject({ S3_FORCE_PATH_STYLE: true, WORKER_CONCURRENCY: 3 });
  });
  it('fails clearly on missing settings', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});
