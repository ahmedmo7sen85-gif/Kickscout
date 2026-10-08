import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFICATION_PREFERENCES, notificationCategory, shouldDeliver } from './notifications.js';

describe('notification preferences', () => {
  it('maps every kind the API creates to a category', () => {
    expect(notificationCategory('follow')).toBe('follower');
    expect(notificationCategory('contact.requested')).toBe('scout_contact');
    expect(notificationCategory('verification.approved')).toBe('verification');
    expect(notificationCategory('save.milestone')).toBe('save_milestone');
    expect(notificationCategory('saved_search.match')).toBe('shortlist_activity');
  });

  it('lets a scout switch saved-search alerts off with shortlist activity', () => {
    expect(shouldDeliver('saved_search.match', { ...DEFAULT_NOTIFICATION_PREFERENCES, shortlist_activity: false })).toBe(false);
    expect(shouldDeliver('saved_search.match', DEFAULT_NOTIFICATION_PREFERENCES)).toBe(true);
  });

  it('respects a switched-off category', () => {
    const prefs = { ...DEFAULT_NOTIFICATION_PREFERENCES, like: false };
    expect(shouldDeliver('like', prefs)).toBe(false);
    expect(shouldDeliver('follow', prefs)).toBe(true);
    expect(shouldDeliver('like', null)).toBe(true);
  });

  it('always delivers security, safety and moderation notices', () => {
    const allOff = Object.fromEntries(Object.keys(DEFAULT_NOTIFICATION_PREFERENCES).map((k) => [k, false])) as typeof DEFAULT_NOTIFICATION_PREFERENCES;
    for (const kind of ['video.rejected', 'account.deletion_requested', 'security.new_sign_in']) expect(shouldDeliver(kind, allOff)).toBe(true);
  });
});
