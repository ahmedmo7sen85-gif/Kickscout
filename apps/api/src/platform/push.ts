import webpush from 'web-push';
import type { Config } from '../config.js';

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** What the service worker shows. `url` is a same-site path; the worker refuses anything else. */
export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export type PushResult = { ok: true } | { ok: false; gone: boolean; error: string };

export interface PushSender {
  readonly publicKey: string;
  send(target: PushTarget, message: PushMessage, opts: { ttlSeconds: number; urgency: 'very-low' | 'low' | 'normal' | 'high' }): Promise<PushResult>;
}

/**
 * Push services browsers actually use. The API makes outbound requests to stored endpoints, so an
 * allowlist stops a subscription from turning the sender into a request forwarder (SSRF).
 */
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com'];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Sends through the standard Web Push protocol with VAPID; payloads are encrypted for the browser. */
export class WebPushSender implements PushSender {
  constructor(
    readonly publicKey: string,
    private readonly privateKey: string,
    private readonly subject: string,
  ) {}

  async send(target: PushTarget, message: PushMessage, opts: { ttlSeconds: number; urgency: 'very-low' | 'low' | 'normal' | 'high' }): Promise<PushResult> {
    if (!isAllowedPushEndpoint(target.endpoint)) return { ok: false, gone: true, error: 'endpoint not allowed' };
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(message),
        {
          TTL: opts.ttlSeconds, urgency: opts.urgency, timeout: 10_000,
          // Topic: a newer message with the same tag replaces an undelivered older one (e.g. two goals while offline).
          topic: message.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined,
          vapidDetails: { subject: this.subject, publicKey: this.publicKey, privateKey: this.privateKey },
        },
      );
      return { ok: true };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404/410: the browser unsubscribed or the subscription expired; it will never work again.
      if (status === 404 || status === 410) return { ok: false, gone: true, error: `push service answered ${status}` };
      return { ok: false, gone: false, error: status ? `push service answered ${status}` : 'push service unreachable' };
    }
  }
}

export function pushSenderFromConfig(config: Config): PushSender | null {
  return config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY && config.VAPID_SUBJECT
    ? new WebPushSender(config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY, config.VAPID_SUBJECT)
    : null;
}
