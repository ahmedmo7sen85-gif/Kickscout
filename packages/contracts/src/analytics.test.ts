import { describe, expect, it } from 'vitest';
import { ANALYTICS_EVENTS, CLIENT_EVENT_NAMES, prepareEvent, TrackEventsRequest, UpdateFeatureFlagRequest } from './index.js';

const id = '0192e000-0000-7000-8000-000000000001';
const server = { source: 'server' as const, optedOut: false, minor: false };

describe('analytics event registry', () => {
  it('records known events with valid properties and nothing else', () => {
    expect(prepareEvent('video_liked', { videoId: id }, server)).toEqual({ record: true, properties: { videoId: id } });
    expect(prepareEvent('nope', {}, server)).toEqual({ record: false, reason: 'unknown_event' });
    expect(prepareEvent('toString', {}, server)).toEqual({ record: false, reason: 'unknown_event' });
    expect(prepareEvent('video_liked', { videoId: id, name: 'Ahmed' }, server)).toEqual({ record: false, reason: 'invalid_properties' });
    expect(prepareEvent('page_viewed', { path: 'https://x.test/?email=a@b.c' }, { ...server, source: 'client' }).record).toBe(false);
  });

  it('allows only client events from the browser', () => {
    expect(CLIENT_EVENT_NAMES).toEqual(['page_viewed', 'cta_clicked', 'locale_changed', 'share_clicked', 'video_completed', 'challenge_shared']);
    expect(Object.entries(ANALYTICS_EVENTS).filter(([, s]) => s.client).map(([n]) => n)).toEqual([...CLIENT_EVENT_NAMES]);
    expect(prepareEvent('contact_requested', { contactRequestId: id, playerId: id, origin: 'profile' }, { ...server, source: 'client' }))
      .toEqual({ record: false, reason: 'not_allowed_from_client' });
  });

  it('keeps only strictly necessary events for people who opted out', () => {
    const optedOut = { ...server, optedOut: true };
    const necessary = Object.entries(ANALYTICS_EVENTS).filter(([, s]) => s.necessary).map(([n]) => n);
    expect(necessary.sort()).toEqual(['checkout_started', 'contact_accepted', 'contact_requested', 'subscription_activated']);
    expect(prepareEvent('video_liked', { videoId: id }, optedOut)).toEqual({ record: false, reason: 'opted_out' });
    expect(prepareEvent('subscription_activated', { planKey: 'scout_pro', status: 'active' }, optedOut).record).toBe(true);
  });

  it('strips identifying properties for minors', () => {
    const props = { roles: ['player'], scoutApplication: false, locale: 'fr', country: 'MA' };
    expect(prepareEvent('signup_completed', props, { ...server, minor: true })).toEqual({ record: true, properties: { roles: ['player'], scoutApplication: false, locale: 'fr' } });
    expect(prepareEvent('signup_completed', props, server)).toEqual({ record: true, properties: props });
  });

  it('bounds client batches', () => {
    const ev = { name: 'page_viewed', properties: { path: '/' } };
    expect(TrackEventsRequest.safeParse({ events: Array(20).fill(ev) }).success).toBe(true);
    expect(TrackEventsRequest.safeParse({ events: Array(21).fill(ev) }).success).toBe(false);
    expect(TrackEventsRequest.safeParse({ events: [] }).success).toBe(false);
  });

  it('flag updates change only what is sent', () => {
    expect(UpdateFeatureFlagRequest.parse({ enabled: true })).toEqual({ enabled: true });
    expect(UpdateFeatureFlagRequest.safeParse({}).success).toBe(false);
    expect(UpdateFeatureFlagRequest.safeParse({ key: 'x' }).success).toBe(false);
  });
});
