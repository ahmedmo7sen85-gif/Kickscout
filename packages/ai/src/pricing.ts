/**
 * List prices in USD per million tokens, used to estimate spend from `ai_calls` (cost per video, the
 * Guardian's daily budget). Estimates only: the provider's invoice is the source of truth. Unknown
 * models are priced at the most expensive known rate so a budget never under-counts.
 */
export const MODEL_PRICES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'fake-model': { input: 0, output: 0 },
};

const FALLBACK = { input: 10, output: 50 };

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICES_USD_PER_MTOK[model] ?? FALLBACK;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
