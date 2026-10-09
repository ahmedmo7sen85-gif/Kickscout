/**
 * Provider-neutral AI types. Features ask the router for a task; the router picks the model, effort,
 * budget and timeout, calls an `AiProvider`, validates the output and records the call. Nothing here
 * knows which vendor answers.
 */

/** Every kind of AI work the platform does. Each one is routed to a model tier (see routing.ts). */
export const AI_TASKS = ['video_analysis', 'video_screening', 'nl_scout_query'] as const;
export type AiTask = (typeof AI_TASKS)[number];

export const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];

export type AiContent =
  | { type: 'text'; text: string }
  /** Base64 image bytes. */
  | { type: 'image'; mediaType: 'image/jpeg' | 'image/png'; data: string };

/** One request to a model, already routed: the provider sends exactly this. */
export interface AiRequest {
  model: string;
  effort: AiEffort;
  /** Hard output cap for the task (its budget). */
  maxTokens: number;
  system: string;
  content: AiContent[];
  /** JSON schema the answer must follow (structured output). */
  jsonSchema: Record<string, unknown>;
  /** Vendor-side fallback when the model declines (Claude API only; not every model supports it). */
  serverFallbacks: boolean;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiResponse {
  /** Normalised stop reason. */
  stop: 'end_turn' | 'refusal' | 'max_tokens' | 'other';
  /** The vendor's raw stop reason, for logs. */
  rawStop: string | null;
  /** Concatenated text output (never read on a refusal). */
  text: string;
  /** The model that actually answered (may differ from the request after a server-side fallback). */
  model: string;
  usage: AiUsage;
  refusal: { explanation: string | null; category: string | null } | null;
}

export interface AiProvider {
  readonly name: string;
  complete(req: AiRequest, opts: { signal: AbortSignal }): Promise<AiResponse>;
}

/** The request is wrong or unauthorised; it will fail the same way every time. */
export class AiPermanentError extends Error {
  override name = 'AiPermanentError';
}

/** Rate limits, overload, 5xx, network errors and timeouts: a later attempt can succeed. */
export class AiTransientError extends Error {
  override name = 'AiTransientError';
}

/** The model answered, but the answer is unusable (cut off, not JSON, off-schema, or carrying a rating). */
export class AiOutputError extends Error {
  override name = 'AiOutputError';
  constructor(message: string, readonly reason: 'truncated' | 'invalid_json' | 'schema' | 'forbidden_field' | 'stop_reason') {
    super(message);
  }
}

/** No provider is configured (no API key): callers degrade gracefully. */
export class AiUnavailableError extends Error {
  override name = 'AiUnavailableError';
}
