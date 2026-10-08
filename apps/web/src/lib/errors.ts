import { isApiError, KNOWN_ERROR_CODES, type KnownErrorCode } from './api';
import type { Dict } from './i18n';

const known = new Set<string>(KNOWN_ERROR_CODES);

/** A friendly, localised message for any thrown value. Field errors are appended when present. */
export function errorMessage(e: unknown, t: Dict): string {
  if (!isApiError(e)) return t.errors.genericText;
  const base = known.has(e.code) ? t.errors[e.code as KnownErrorCode] : e.status >= 500 ? t.errors.INTERNAL : (e.detail ?? t.errors.genericText);
  if (e.code === 'VALIDATION_FAILED' && e.fieldErrors.length) {
    return `${base} ${e.fieldErrors.map((f) => `${f.path}: ${f.message}`).join('; ')}`;
  }
  return base;
}
