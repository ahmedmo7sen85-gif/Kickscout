import Anthropic from '@anthropic-ai/sdk';
import { AiPermanentError, AiTransientError } from './types.js';
import type { AiProvider, AiRequest, AiResponse } from './types.js';

export type ClaudeCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type ClaudeMessage = Anthropic.Beta.Messages.BetaMessage;

/** The one SDK call the provider makes; injectable so tests run without a network or key. */
export type CreateMessage = (params: ClaudeCreateParams, options?: { signal?: AbortSignal }) => Promise<ClaudeMessage>;

/** Anthropic Claude behind the provider-neutral interface. Request shape as in the original video analyzer. */
export class ClaudeProvider implements AiProvider {
  readonly name = 'anthropic';

  constructor(private readonly create: CreateMessage) {}

  /**
   * The router owns retries, backoff and per-task timeouts, so the SDK's own retries are off here
   * (otherwise attempts would multiply and the timeout would not hold).
   */
  static fromApiKey(apiKey: string): ClaudeProvider {
    const client = new Anthropic({ apiKey, timeout: 5 * 60_000, maxRetries: 0 });
    return new ClaudeProvider((params, options) => client.beta.messages.create(params, options));
  }

  buildParams(req: AiRequest): ClaudeCreateParams {
    const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = req.content.map((c) =>
      c.type === 'text'
        ? { type: 'text', text: c.text }
        : { type: 'image', source: { type: 'base64', media_type: c.mediaType, data: c.data } });
    return {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      thinking: { type: 'adaptive' },
      output_config: { effort: req.effort, format: { type: 'json_schema', schema: req.jsonSchema } },
      messages: [{ role: 'user', content }],
      ...(req.serverFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    };
  }

  async complete(req: AiRequest, opts: { signal: AbortSignal }): Promise<AiResponse> {
    let response: ClaudeMessage;
    try {
      response = await this.create(this.buildParams(req), { signal: opts.signal });
    } catch (err) {
      // Requests that are wrong or unauthorised will fail the same way every time.
      if (
        err instanceof Anthropic.BadRequestError ||
        err instanceof Anthropic.AuthenticationError ||
        err instanceof Anthropic.PermissionDeniedError ||
        err instanceof Anthropic.NotFoundError ||
        err instanceof Anthropic.UnprocessableEntityError
      ) {
        throw new AiPermanentError(`AI request rejected (${err.status}): ${err.message}`, { cause: err });
      }
      // Rate limits, overload, 5xx, network, aborts.
      throw new AiTransientError(err instanceof Error ? err.message : String(err), { cause: err });
    }
    return this.normalise(response);
  }

  normalise(response: ClaudeMessage): AiResponse {
    const usage = { inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 };
    const stop = response.stop_reason === 'end_turn' || response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens' ? response.stop_reason : 'other';
    if (stop === 'refusal') {
      // Content is empty or partial on a refusal; never read it. stop_details is informational and may be null.
      return {
        stop, rawStop: response.stop_reason, text: '', model: response.model, usage,
        refusal: { explanation: response.stop_details?.explanation ?? null, category: response.stop_details?.category ?? null },
      };
    }
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return { stop, rawStop: response.stop_reason, text, model: response.model, usage, refusal: null };
  }
}
