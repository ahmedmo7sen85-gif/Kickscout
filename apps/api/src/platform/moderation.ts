/**
 * First-pass comment moderation. Keyword and pattern rules only: it catches obvious spam,
 * contact-harvesting and abuse, and holds the comment for review rather than deleting it.
 * A model-based classifier (harassment, hate, sexual content, threats) is not integrated yet.
 */

export type ModerationResult = { status: 'visible' } | { status: 'held'; reasons: string[] };

const CONTACT_PATTERNS = [
  /\b(?:\+?\d[\s-]?){8,}\b/, // phone numbers
  /[\w.+-]+@[\w-]+\.[\w.]+/, // emails
  /\b(?:whats\s?app|snap(?:chat)?|telegram|wa\.me|t\.me)\b/i,
  /(?:واتس|واتساب|تليجرام|سناب)/,
];
const SPAM_PATTERNS = [/https?:\/\//i, /(.)\1{9,}/, /\b(?:free followers|buy followers|crypto)\b/i];

export function moderateComment(body: string, opts: { onMinorsContent: boolean }): ModerationResult {
  const reasons: string[] = [];
  if (CONTACT_PATTERNS.some((p) => p.test(body))) reasons.push('contact_details');
  if (SPAM_PATTERNS.some((p) => p.test(body))) reasons.push('spam_pattern');
  // On minors' videos every contact attempt is held; elsewhere only spam is.
  const blocking = opts.onMinorsContent ? reasons : reasons.filter((r) => r !== 'contact_details');
  return blocking.length ? { status: 'held', reasons: blocking } : { status: 'visible' };
}
