import type { AiProvider, AiRequest, AiResponse } from './types.js';

type Answer = AiResponse | Error | ((req: AiRequest, call: number, signal: AbortSignal) => AiResponse | Error | Promise<AiResponse | Error>);

/** A provider for tests: answers from a script, records every request, never touches a network. */
export class FakeAiProvider implements AiProvider {
  readonly name = 'fake';
  readonly requests: AiRequest[] = [];
  private readonly script: Answer[];

  /** Answers are used in order; the last one repeats. */
  constructor(...answers: Answer[]) {
    this.script = answers.length ? answers : [fakeResponse({})];
  }

  static json(value: unknown, extra: Partial<AiResponse> = {}): FakeAiProvider {
    return new FakeAiProvider(fakeResponse({ text: JSON.stringify(value), ...extra }));
  }

  async complete(req: AiRequest, opts: { signal: AbortSignal }): Promise<AiResponse> {
    const call = this.requests.push(req);
    const a = this.script[Math.min(call - 1, this.script.length - 1)]!;
    const out = typeof a === 'function' ? await a(req, call, opts.signal) : a;
    if (out instanceof Error) throw out;
    return out;
  }
}

export function fakeResponse(r: Partial<AiResponse>): AiResponse {
  return { stop: 'end_turn', rawStop: r.stop ?? 'end_turn', text: '{}', model: 'fake-model', usage: { inputTokens: 100, outputTokens: 20 }, refusal: null, ...r };
}
