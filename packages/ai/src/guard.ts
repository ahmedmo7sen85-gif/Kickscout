/**
 * AI on KICKSCOUT tags and assists; it never rates a player. Any AI output carrying a field that looks
 * like a rating, score, grade, rank or "potential" is rejected outright, at any depth, whatever the
 * task. The same rule is enforced on stored AI JSON by a database check (0009_ai_routing.sql).
 */

/** Keys matching this (case-insensitive) are refused in AI output. Mirrors `ai_json_has_forbidden_key` in SQL. */
export const FORBIDDEN_AI_KEY = /rating|potential|score|grade|rank|overall|talent_?level|^ability$/i;

/** Paths of every forbidden key in a JSON value (empty when clean). */
export function findForbiddenKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findForbiddenKeys(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
      ...(FORBIDDEN_AI_KEY.test(k) ? [`${path}.${k}`] : []),
      ...findForbiddenKeys(v, `${path}.${k}`),
    ]);
  }
  return [];
}

export class AiRatingFieldError extends Error {
  override name = 'AiRatingFieldError';
  constructor(readonly paths: string[]) {
    super(`AI output carries a rating-like field (${paths.join(', ')}); AI may only tag and assist, never rate`);
  }
}

export function assertNoRatingFields(value: unknown): void {
  const paths = findForbiddenKeys(value);
  if (paths.length) throw new AiRatingFieldError(paths);
}
