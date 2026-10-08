import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnalyzerRetryableError, ClaudeVideoAnalyzer, OUTPUT_SCHEMA, SYSTEM_PROMPT } from '../src/analyzer/claude.js';
import type { CreateMessage } from '../src/analyzer/claude.js';
import type { AnalysisInput } from '../src/analyzer/types.js';
import { PermanentJobError } from '../src/errors.js';
import { SAFE } from './helpers.js';

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

const input: AnalysisInput = {
  videoId: '0190f0a0-0000-7000-8000-000000000001',
  durationMs: 6000,
  width: 720,
  height: 1280,
  frames: [0, 1, 2].map((i) => ({ data: Buffer.from([0xff, 0xd8, 0xff, i]), atMs: 1000 + i * 2000 })),
};

const opts = { model: 'claude-opus-5-5', effort: 'high' as const, serverFallbacks: true };

/** A response shaped like the SDK's BetaMessage; only the fields the analyzer reads matter. */
function message(partial: { stop_reason: string; content?: unknown[]; stop_details?: unknown; model?: string }): BetaMessage {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model: partial.model ?? 'claude-opus-5-5', content: partial.content ?? [],
    stop_reason: partial.stop_reason, stop_details: partial.stop_details ?? null, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  } as unknown as BetaMessage;
}

function stub(response: BetaMessage | Error) {
  const calls: CreateParams[] = [];
  const create: CreateMessage = async (params) => {
    calls.push(params);
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, analyzer: new ClaudeVideoAnalyzer(create, opts) };
}

const text = (t: string) => ({ type: 'text', text: t, citations: null });

describe('ClaudeVideoAnalyzer request', () => {
  it('sends frames as base64 JPEG image blocks with structured output, adaptive thinking and fallbacks', async () => {
    const { calls, analyzer } = stub(message({ stop_reason: 'end_turn', content: [text(JSON.stringify(SAFE))] }));
    await analyzer.analyze(input);
    const req = calls[0]!;
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.max_tokens).toBe(16_000);
    expect(req.thinking).toEqual({ type: 'adaptive' });
    expect(req.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } });
    expect(req.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(req.fallbacks).toBe('default');
    expect(req.system).toBe(SYSTEM_PROMPT);

    // one user turn, no assistant prefill
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.role).toBe('user');
    const content = req.messages[0]!.content as Anthropic.Beta.Messages.BetaContentBlockParam[];
    const images = content.filter((b) => b.type === 'image');
    expect(images).toHaveLength(3);
    expect(images[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0]).toString('base64') } });
    expect(content[0]).toEqual({ type: 'text', text: 'Frame 1 of 3, at 1.0 s:' });
    expect(content.at(-1)).toMatchObject({ type: 'text', text: expect.stringContaining('6.0 second clip') });
  });

  it('omits the fallback beta when disabled', () => {
    const analyzer = new ClaudeVideoAnalyzer(async () => message({ stop_reason: 'end_turn' }), { ...opts, serverFallbacks: false });
    const req = analyzer.buildRequest(input);
    expect(req).not.toHaveProperty('betas');
    expect(req).not.toHaveProperty('fallbacks');
  });

  it('prompt keeps tagging conservative and does not judge ability', () => {
    expect(SYSTEM_PROMPT).toMatch(/only skills you can actually see/i);
    expect(SYSTEM_PROMPT).toMatch(/conservative/i);
    expect(SYSTEM_PROMPT).toMatch(/not judging the player's ability, talent, or professional potential/i);
  });

  it('output schema is API-compatible: every object closed and fully required', () => {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      if (n.type === 'object') {
        expect(n.additionalProperties).toBe(false);
        expect(new Set(n.required as string[])).toEqual(new Set(Object.keys(n.properties as object)));
      }
      for (const k of ['minimum', 'maximum', 'minLength', 'maxLength']) expect(n).not.toHaveProperty(k);
      Object.values(n).forEach(walk);
    };
    walk(OUTPUT_SCHEMA);
  });

  it('refuses to call the API with no frames', async () => {
    const { calls, analyzer } = stub(message({ stop_reason: 'end_turn' }));
    await expect(analyzer.analyze({ ...input, frames: [] })).rejects.toBeInstanceOf(PermanentJobError);
    expect(calls).toHaveLength(0);
  });
});

describe('ClaudeVideoAnalyzer response handling', () => {
  it('parses and validates a structured result, ignoring thinking and fallback blocks', async () => {
    const { analyzer } = stub(
      message({
        stop_reason: 'end_turn',
        model: 'claude-opus-5',
        content: [
          { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
          { type: 'thinking', thinking: '', signature: 'sig' },
          text(JSON.stringify(SAFE)),
        ],
      }),
    );
    expect(await analyzer.analyze(input)).toEqual({ kind: 'result', analysis: SAFE, model: 'claude-opus-5' });
  });

  it('turns a refusal into a review outcome with the explanation', async () => {
    const { analyzer } = stub(message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms', explanation: 'Declined.' } }));
    expect(await analyzer.analyze(input)).toEqual({ kind: 'refusal', explanation: 'Declined.', category: 'general_harms', model: 'claude-opus-5-5' });
  });

  it('handles a refusal with no stop_details', async () => {
    const { analyzer } = stub(message({ stop_reason: 'refusal', content: [text('{"partial')] }));
    expect(await analyzer.analyze(input)).toMatchObject({ kind: 'refusal', category: null, explanation: expect.stringMatching(/declined/) });
  });

  it('treats max_tokens as retryable', async () => {
    const { analyzer } = stub(message({ stop_reason: 'max_tokens', content: [text('{"footballPresent": tr')] }));
    await expect(analyzer.analyze(input)).rejects.toBeInstanceOf(AnalyzerRetryableError);
  });

  it('rejects output that does not match the schema (unknown skill, confidence out of range)', async () => {
    const bad = { ...SAFE, skills: [{ key: 'bicycle_kick_9000', confidence: 0.9 }] };
    await expect(stub(message({ stop_reason: 'end_turn', content: [text(JSON.stringify(bad))] })).analyzer.analyze(input)).rejects.toThrow(/schema/);
    const out = { ...SAFE, skills: [{ key: 'juggling', confidence: 1.4 }] };
    await expect(stub(message({ stop_reason: 'end_turn', content: [text(JSON.stringify(out))] })).analyzer.analyze(input)).rejects.toThrow(/schema/);
    await expect(stub(message({ stop_reason: 'end_turn', content: [text('not json')] })).analyzer.analyze(input)).rejects.toThrow(/valid JSON/);
  });

  it('marks bad requests as permanent and lets rate limits be retried', async () => {
    const headers = new Headers();
    const badRequest = new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, 'bad', headers);
    await expect(stub(badRequest).analyzer.analyze(input)).rejects.toBeInstanceOf(PermanentJobError);
    const limited = new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', headers);
    const err = await stub(limited).analyzer.analyze(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.RateLimitError);
    expect(err).not.toBeInstanceOf(PermanentJobError);
  });
});
