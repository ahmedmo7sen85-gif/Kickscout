/**
 * Browser side of Web Push. Permission is only ever requested from `enablePush`, which the UI calls
 * from an explicit button press after explaining what alerts are. The service worker (`/sw.js`)
 * shows the notification; the page never uses the Notification constructor for alerts.
 */

export type PushSupport = 'supported' | 'unsupported' | 'insecure';

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return 'supported';
}

export function permission(): NotificationPermission | 'unsupported' {
  return typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported';
}

/** VAPID public keys are URL-safe base64; PushManager wants the raw bytes. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  return existing ?? navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

/** The current push subscription of this browser, without asking for anything. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'supported') return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

export type EnableResult = { ok: true; subscription: PushSubscriptionJSON } | { ok: false; reason: 'denied' | 'unsupported' | 'failed' };

/** Asks for permission (from a user gesture) and subscribes this browser with the server's public key. */
export async function enablePush(publicKey: string): Promise<EnableResult> {
  if (pushSupport() !== 'supported') return { ok: false, reason: 'unsupported' };
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, reason: 'denied' };
  try {
    const reg = await registration();
    await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
    return { ok: true, subscription: sub.toJSON() };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** Unsubscribes this browser; returns the endpoint that was removed (to tell the server). */
export async function disablePush(): Promise<string | null> {
  const sub = await currentSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => false);
  return endpoint;
}
