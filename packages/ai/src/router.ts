import { assertNoRatingFields, AiRatingFieldError } from './guard.js';
import { AiOutputError, AiPermanentError, AiTransientError, AiUnavailableError } from './types.js';
import type { AiContent, AiProvider, AiResponse, AiTask } from './types.js';
import type { RouteConfig, RoutingTable } from './routing.js';

export const AI_CALL_OUTCOMES = ['ok', 'refusal', 'truncated', 'invalid_output', 'timeout', 'error'] as const;
export type AiCallOutcome = (typeof AI_CALL_OUTCOMES)[number];

/** One attempt, as stored in `ai_calls` for cost accounting. */
export interface AiCallRecord {
  task: AiTask;
  provider: string;
  /** The model the router asked for. */
  model: string;
  /** The model that answered (after any server-side fallback), when there was an answer. */
  responseModel: string | null;
  effort: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  outcome: AiCallOutcome;
  attempt: number;
  videoId: string | null;
  userId: string | null;
  error: string | null;
}

export interface AiCallRecorder {
  record(r: AiCallRecord): Promise<void>;
}

export class MemoryCallRecorder implements AiCallRecorder {
  readonly calls: AiCallRecord[] = [];
  async record(r: AiCallRecord) {
    this.calls.push(r);
  }
}

export interface AiTaskInput<T> {
  system: string;
  content: AiContent[];
  jsonSchema: Record<string, unknown>;
  /** Validates the parsed JSON (a zod `parse`, typically). Throwing means the output is off-schema. */
  parse: (json: unknown) => T;
}

export interface AiCallMeta {
  videoId?: string | null;
  userId?: string | null;
}

export type AiTaskResult<T> =
  | { kind: 'result'; value: T; model: string }
  | { kind: 'refusal'; explanation: string | null; category: string | null; model: string };

export interface AiRouterOptions {
  recorder?: AiCallRecorder | null;
  /** First backoff delay; doubles per attempt, with jitter. */
  backoffBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  onRecordError?: (err: unknown) => void;
}

class TimeoutError extends AiTransientError {
  override name = 'AiTimeoutError';
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Routes each task to its model, enforces the per-task budget (max tokens) and timeout, retries
 * transient failures with exponential backoff, validates output (JSON, schema, no rating fields) and
 * records every attempt with its token usage. With no provider (no API key) it is unavailable and
 * callers fall back: videos wait for a human, search uses the rule-based parser.
 */
export class AiRouter {
  private readonly recorder: AiCallRecorder | null;
  private readonly backoffBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(
    private readonly provider: AiProvider | null,
    private readonly routes: RoutingTable,
    private readonly opts: AiRouterOptions = {},
  ) {
    this.recorder = opts.recorder ?? null;
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  get available(): boolean {
    return this.provider !== null;
  }

  route(task: AiTask): RouteConfig {
    return this.routes[task];
  }

  backoffMs(attempt: number): number {
    // attempt 1 failed -> base, 2 -> 2x base, ... with 50-100% jitter.
    return Math.round(this.backoffBaseMs * 2 ** (attempt - 1) * (0.5 + this.random() * 0.5));
  }

  async run<T>(task: AiTask, input: AiTaskInput<T>, meta: AiCallMeta = {}): Promise<AiTaskResult<T>> {
    const provider = this.provider;
    if (!provider) throw new AiUnavailableError('no AI provider is configured');
    const route = this.routes[task];
    const request = {
      model: route.model, effort: route.effort, maxTokens: route.maxTokens, system: input.system, content: input.content,
      jsonSchema: input.jsonSchema, serverFallbacks: route.serverFallbacks,
    };

    for (let attempt = 1; ; attempt++) {
      const started = this.now();
      const base = { task, provider: provider.name, model: route.model, effort: route.effort, attempt, videoId: meta.videoId ?? null, userId: meta.userId ?? null };
      let response: AiResponse;
      try {
        response = await this.withTimeout(route.timeoutMs, (signal) => provider.complete(request, { signal }));
      } catch (err) {
        const latencyMs = this.now() - started;
        const timedOut = err instanceof TimeoutError;
        await this.record({ ...base, responseModel: null, inputTokens: 0, outputTokens: 0, latencyMs, outcome: timedOut ? 'timeout' : 'error', error: errorText(err) });
        if (err instanceof AiPermanentError) throw err;
        const transient = err instanceof AiTransientError ? err : new AiTransientError(errorText(err), { cause: err });
        if (attempt >= route.maxAttempts) throw transient;
        await this.sleep(this.backoffMs(attempt));
        continue;
      }

      const latencyMs = this.now() - started;
      const done = { ...base, responseModel: response.model, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, latencyMs };
      if (response.stop === 'refusal') {
        await this.record({ ...done, outcome: 'refusal', error: null });
        return { kind: 'refusal', explanation: response.refusal?.explanation ?? null, category: response.refusal?.category ?? null, model: response.model };
      }
      // The budget is a hard cap: a cut-off answer is not retried with the same budget here.
      if (response.stop === 'max_tokens') {
        await this.record({ ...done, outcome: 'truncated', error: 'output token limit reached' });
        throw new AiOutputError('AI output was cut off by the output token limit', 'truncated');
      }
      if (response.stop !== 'end_turn') {
        await this.record({ ...done, outcome: 'error', error: `stop reason ${response.rawStop}` });
        throw new AiOutputError(`unexpected AI stop reason: ${response.rawStop}`, 'stop_reason');
      }
      try {
        const value = validate(response.text, input.parse);
        await this.record({ ...done, outcome: 'ok', error: null });
        return { kind: 'result', value, model: response.model };
      } catch (err) {
        await this.record({ ...done, outcome: 'invalid_output', error: errorText(err) });
        throw err;
      }
    }
  }

  private async withTimeout<R>(ms: number, fn: (signal: AbortSignal) => Promise<R>): Promise<R> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(`AI call timed out after ${ms} ms`));
      }, ms);
    });
    try {
      return await Promise.race([fn(controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async record(r: AiCallRecord) {
    if (!this.recorder) return;
    try {
      await this.recorder.record({ ...r, error: r.error?.slice(0, 500) ?? null });
    } catch (err) {
      // Accounting must never break the feature it measures.
      this.opts.onRecordError?.(err);
    }
  }
}

function validate<T>(text: string, parse: (json: unknown) => T): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AiOutputError('AI output was not valid JSON', 'invalid_json');
  }
  try {
    assertNoRatingFields(json);
  } catch (err) {
    throw new AiOutputError((err as AiRatingFieldError).message, 'forbidden_field');
  }
  try {
    return parse(json);
  } catch (err) {
    const issues = (err as { issues?: { path: PropertyKey[] }[] }).issues;
    const where = issues ? issues.map((i) => i.path.map(String).join('.')).join(', ') : errorText(err);
    throw new AiOutputError(`AI output did not match the schema: ${where}`, 'schema');
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
