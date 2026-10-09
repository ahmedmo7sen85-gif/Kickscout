import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AiOutputError, AiPermanentError, AiRouter, AiTransientError, AiUnavailableError, ClaudeProvider, FakeAiProvider, MemoryCallRecorder,
  assertNoRatingFields, estimateCostUsd, fakeResponse, findForbiddenKeys, routingFromEnv, DEFAULT_HEAVY_MODEL, DEFAULT_LIGHT_MODEL, DEFAULT_SCREEN_MODEL,
} from './index.js';
import type { ClaudeCreateParams, ClaudeMessage, RoutingTable } from './index.js';

const Out = z.object({ tags: z.array(z.string()) }).strict();
const input = { system: 'sys', content: [{ type: 'text' as const, text: 'hi' }], jsonSchema: { type: 'object' }, parse: (j: unknown) => Out.parse(j) };

function router(provider: FakeAiProvider | null, routes: RoutingTable = routingFromEnv({}), extra: { sleeps?: number[] } = {}) {
  const recorder = new MemoryCallRecorder();
  const sleeps = extra.sleeps ?? [];
  const r = new AiRouter(provider, routes, { recorder, backoffBaseMs: 100, random: () => 1, sleep: async (ms) => { sleeps.push(ms); } });
  return { r, recorder, sleeps };
}

describe('routing', () => {
  it('sends heavy work to the strong model and query parsing to the light one, with sane defaults', () => {
    const t = routingFromEnv({});
    expect(t.video_analysis).toMatchObject({ tier: 'heavy', model: DEFAULT_HEAVY_MODEL, effort: 'high', maxTokens: 16_000, serverFallbacks: true });
    expect(t.nl_scout_query).toMatchObject({ tier: 'light', model: DEFAULT_LIGHT_MODEL, effort: 'low', maxTokens: 2_048, serverFallbacks: false });
    expect(DEFAULT_HEAVY_MODEL).toBe('claude-opus-5-5');
    expect(DEFAULT_LIGHT_MODEL).toBe('claude-haiku-5-5');
    expect(t.nl_scout_query.timeoutMs).toBeLessThan(t.video_analysis.timeoutMs);
  });

  it('is configurable per tier, and keeps the worker’s original AI_MODEL / AI_EFFORT for the heavy tier', () => {
    const t = routingFromEnv({ AI_MODEL: 'claude-opus-5', AI_EFFORT: 'max', AI_MODEL_LIGHT: 'claude-sonnet-5-5', AI_MAX_TOKENS_LIGHT: '512', AI_TIMEOUT_MS_LIGHT: '', AI_SERVER_FALLBACKS: 'off' });
    expect(t.video_analysis).toMatchObject({ model: 'claude-opus-5', effort: 'max', serverFallbacks: false });
    expect(t.nl_scout_query).toMatchObject({ model: 'claude-sonnet-5-5', maxTokens: 512, timeoutMs: 10_000 });
    expect(routingFromEnv({ AI_MODEL: 'a', AI_MODEL_HEAVY: 'b' }).video_analysis.model).toBe('b');
    expect(() => routingFromEnv({ AI_EFFORT_LIGHT: 'extreme' })).toThrow(/AI_EFFORT_LIGHT/);
  });

  it('screens videos on its own cheap tier, configurable separately', () => {
    expect(routingFromEnv({}).video_screening).toMatchObject({ tier: 'screen', model: DEFAULT_SCREEN_MODEL, effort: 'low', serverFallbacks: false });
    expect(DEFAULT_SCREEN_MODEL).toBe('claude-haiku-5-5');
    expect(routingFromEnv({ AI_MODEL_SCREEN: 'claude-sonnet-5-5', AI_EFFORT_SCREEN: 'medium' }).video_screening).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' });
  });

  it('estimates spend per model, pricing unknown models high so a budget cap errs on the safe side', () => {
    expect(estimateCostUsd('claude-haiku-5-5', 1_000_000, 1_000_000)).toBeCloseTo(0.6);
    expect(estimateCostUsd('claude-opus-5-5', 1_000_000, 0)).toBeCloseTo(4);
    expect(estimateCostUsd('some-new-model', 1_000_000, 0)).toBeGreaterThanOrEqual(4);
  });
});

describe('AiRouter', () => {
  it('uses the routed model, effort and budget, validates output and records tokens and latency', async () => {
    const fake = FakeAiProvider.json({ tags: ['elastico'] }, { model: 'claude-haiku-5-5', usage: { inputTokens: 321, outputTokens: 45 } });
    const { r, recorder } = router(fake);
    const res = await r.run('nl_scout_query', input, { userId: 'u1' });
    expect(res).toEqual({ kind: 'result', value: { tags: ['elastico'] }, model: 'claude-haiku-5-5' });
    expect(fake.requests[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low', maxTokens: 2_048, serverFallbacks: false, system: 'sys' });
    expect(recorder.calls).toEqual([expect.objectContaining({
      task: 'nl_scout_query', provider: 'fake', model: 'claude-haiku-5-5', responseModel: 'claude-haiku-5-5', inputTokens: 321, outputTokens: 45,
      outcome: 'ok', attempt: 1, userId: 'u1', videoId: null, error: null, latencyMs: expect.any(Number),
    })]);
  });

  it('retries transient failures with exponential backoff, recording each attempt', async () => {
    const fake = new FakeAiProvider(new AiTransientError('overloaded'), new AiTransientError('overloaded'), fakeResponse({ text: '{"tags":[]}' }));
    const { r, recorder, sleeps } = router(fake, routingFromEnv({ AI_MAX_ATTEMPTS_HEAVY: '3' }));
    expect((await r.run('video_analysis', input, { videoId: 'v1' })).kind).toBe('result');
    expect(sleeps).toEqual([100, 200]);
    expect(recorder.calls.map((c) => [c.attempt, c.outcome, c.videoId])).toEqual([[1, 'error', 'v1'], [2, 'error', 'v1'], [3, 'ok', 'v1']]);
  });

  it('gives up after the last attempt with a transient error', async () => {
    const { r, recorder } = router(new FakeAiProvider(new Error('socket hang up')), routingFromEnv({ AI_MAX_ATTEMPTS_LIGHT: '2' }));
    await expect(r.run('nl_scout_query', input)).rejects.toBeInstanceOf(AiTransientError);
    expect(recorder.calls).toHaveLength(2);
  });

  it('does not retry a permanent error', async () => {
    const { r, recorder } = router(new FakeAiProvider(new AiPermanentError('bad request')));
    await expect(r.run('video_analysis', input)).rejects.toBeInstanceOf(AiPermanentError);
    expect(recorder.calls.map((c) => c.outcome)).toEqual(['error']);
  });

  it('times out a slow call, aborts it and records a timeout', async () => {
    let aborted = false;
    const slow = new FakeAiProvider((_req, _n, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; });
      setTimeout(() => resolve(fakeResponse({ text: '{"tags":[]}' })), 2_000);
    }));
    const { r, recorder } = router(slow, routingFromEnv({ AI_TIMEOUT_MS_LIGHT: '500', AI_MAX_ATTEMPTS_LIGHT: '1' }));
    const started = Date.now();
    await expect(r.run('nl_scout_query', input)).rejects.toThrow(/timed out after 500 ms/);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(aborted).toBe(true);
    expect(recorder.calls[0]).toMatchObject({ outcome: 'timeout', inputTokens: 0, outputTokens: 0 });
  });

  it('treats a cut-off answer as an output error (the budget is a hard cap), and records it', async () => {
    const { r, recorder } = router(new FakeAiProvider(fakeResponse({ stop: 'max_tokens', text: '{"tags": [' })));
    const err = await r.run('nl_scout_query', input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiOutputError);
    expect((err as AiOutputError).reason).toBe('truncated');
    expect(recorder.calls.map((c) => c.outcome)).toEqual(['truncated']);
  });

  it('rejects invalid JSON and off-schema output', async () => {
    for (const [text, reason] of [['not json', 'invalid_json'], ['{"tags":"x"}', 'schema'], ['{"tags":[],"extra":1}', 'schema']] as const) {
      const { r, recorder } = router(new FakeAiProvider(fakeResponse({ text })));
      const err = await r.run('nl_scout_query', input).catch((e: unknown) => e);
      expect((err as AiOutputError).reason).toBe(reason);
      expect(recorder.calls[0]!.outcome).toBe('invalid_output');
    }
  });

  it('rejects any rating, score or potential field in AI output, even where the task schema would allow extra keys', async () => {
    const loose = { ...input, parse: (j: unknown) => j };
    for (const bad of [{ rating: 8 }, { tags: [], meta: { potentialScore: 0.9 } }, { players: [{ OverallGrade: 'A' }] }, { talent_level: 'high' }]) {
      const { r, recorder } = router(FakeAiProvider.json(bad));
      const err = await r.run('video_analysis', loose).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AiOutputError);
      expect((err as AiOutputError).reason).toBe('forbidden_field');
      expect(recorder.calls[0]!.outcome).toBe('invalid_output');
    }
  });

  it('returns a refusal without reading the content', async () => {
    const { r, recorder } = router(new FakeAiProvider(fakeResponse({ stop: 'refusal', text: '{"partial', refusal: { explanation: 'Declined.', category: 'general_harms' } })));
    expect(await r.run('video_analysis', input)).toEqual({ kind: 'refusal', explanation: 'Declined.', category: 'general_harms', model: 'fake-model' });
    expect(recorder.calls[0]!.outcome).toBe('refusal');
  });

  it('is unavailable without a provider, and accounting failures never break a call', async () => {
    const { r } = router(null);
    expect(r.available).toBe(false);
    await expect(r.run('nl_scout_query', input)).rejects.toBeInstanceOf(AiUnavailableError);
    const errors: unknown[] = [];
    const ok = new AiRouter(FakeAiProvider.json({ tags: [] }), routingFromEnv({}), { recorder: { record: async () => { throw new Error('db down'); } }, onRecordError: (e) => errors.push(e) });
    expect((await ok.run('nl_scout_query', input)).kind).toBe('result');
    expect(errors).toHaveLength(1);
  });
});

describe('no-rating guard', () => {
  it('finds rating-like keys at any depth and leaves tags and confidences alone', () => {
    expect(findForbiddenKeys({ skills: [{ key: 'nutmeg', confidence: 0.8 }], moderation: { verdict: 'safe' } })).toEqual([]);
    expect(findForbiddenKeys({ a: [{ b: { playerRating: 1 } }] })).toEqual(['$.a[0].b.playerRating']);
    expect(() => assertNoRatingFields({ potential: 'high' })).toThrow(/never rate/);
    expect(() => assertNoRatingFields({ ability: 5 })).toThrow();
    // Values are not keys: an explanation may mention the word.
    expect(() => assertNoRatingFields({ explanation: 'This is not a rating of potential.' })).not.toThrow();
  });
});

describe('ClaudeProvider', () => {
  const message = (p: { stop_reason: string; content?: unknown[]; stop_details?: unknown; model?: string }) => ({
    id: 'msg', type: 'message', role: 'assistant', model: p.model ?? 'claude-haiku-5-5', content: p.content ?? [], stop_reason: p.stop_reason,
    stop_details: p.stop_details ?? null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 7 },
  }) as unknown as ClaudeMessage;
  const req = { model: 'claude-haiku-5-5', effort: 'low' as const, maxTokens: 1024, system: 'sys', content: [{ type: 'text' as const, text: 'q' }], jsonSchema: { type: 'object' }, serverFallbacks: false };

  it('builds the same request shape as the video analyzer: adaptive thinking, effort, JSON schema output', async () => {
    const calls: { params: ClaudeCreateParams; signal?: AbortSignal }[] = [];
    const p = new ClaudeProvider(async (params, opts) => {
      calls.push({ params, signal: opts?.signal });
      return message({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: '{"a":1}' }] });
    });
    const controller = new AbortController();
    const out = await p.complete(req, { signal: controller.signal });
    expect(out).toEqual({ stop: 'end_turn', rawStop: 'end_turn', text: '{"a":1}', model: 'claude-haiku-5-5', usage: { inputTokens: 11, outputTokens: 7 }, refusal: null });
    expect(calls[0]!.signal).toBe(controller.signal);
    expect(calls[0]!.params).toEqual({
      model: 'claude-haiku-5-5', max_tokens: 1024, system: 'sys', thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
    });
    expect(p.buildParams({ ...req, serverFallbacks: true })).toMatchObject({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  });

  it('maps refusals, permanent and transient SDK errors', async () => {
    const refusal = await new ClaudeProvider(async () => message({ stop_reason: 'refusal', content: [{ type: 'text', text: 'x' }], stop_details: { type: 'refusal', category: 'cyber', explanation: 'No.' } }))
      .complete(req, { signal: new AbortController().signal });
    expect(refusal).toMatchObject({ stop: 'refusal', text: '', refusal: { category: 'cyber', explanation: 'No.' } });
    const headers = new Headers();
    const bad = new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, 'bad', headers);
    await expect(new ClaudeProvider(async () => { throw bad; }).complete(req, { signal: new AbortController().signal })).rejects.toBeInstanceOf(AiPermanentError);
    const limited = new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow' } }, 'slow', headers);
    const err = await new ClaudeProvider(async () => { throw limited; }).complete(req, { signal: new AbortController().signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiTransientError);
    expect((err as Error).cause).toBe(limited);
  });
});
