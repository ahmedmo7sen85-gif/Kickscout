/**
 * Notification preferences. Every in-app notification kind belongs to a category the user can turn
 * off, or to `security`, which is always delivered (account, safety and moderation outcomes).
 */

export const NOTIFICATION_CATEGORIES = [
  'follower', 'like', 'comment', 'save_milestone', 'challenge', 'scout_contact', 'shortlist_activity', 'verification', 'announcements',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export type NotificationPreferences = Record<NotificationCategory, boolean>;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = Object.fromEntries(
  NOTIFICATION_CATEGORIES.map((c) => [c, true]),
) as NotificationPreferences;

/** Save counts that trigger a "your clip was saved N times" notification. */
export const SAVE_MILESTONES = [10, 50, 100, 500, 1000, 5000] as const;

/**
 * Category of a notification kind. Kinds not listed here (account, guardian, moderation and
 * security notices) are treated as security alerts and cannot be switched off.
 */
export function notificationCategory(kind: string): NotificationCategory | 'security' {
  if (kind === 'follow') return 'follower';
  if (kind === 'like') return 'like';
  if (kind === 'comment') return 'comment';
  if (kind === 'save.milestone') return 'save_milestone';
  if (kind.startsWith('challenge.')) return 'challenge';
  if (kind.startsWith('contact.')) return 'scout_contact';
  if (kind.startsWith('shortlist.')) return 'shortlist_activity';
  if (kind.startsWith('verification.')) return 'verification';
  if (kind.startsWith('announcement.')) return 'announcements';
  return 'security';
}

export function shouldDeliver(kind: string, prefs: NotificationPreferences | null | undefined): boolean {
  const category = notificationCategory(kind);
  return category === 'security' || (prefs ?? DEFAULT_NOTIFICATION_PREFERENCES)[category];
}
