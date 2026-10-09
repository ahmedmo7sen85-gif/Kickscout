import { evaluateFlag } from '@fp/domain';
import type { Actor, FlagAudience, FlagDefinition, FlagSubject, Role } from '@fp/domain';
import type { Database } from '@fp/db';
import type { Deps } from '../deps.js';

export interface StoredFlag extends FlagDefinition {
  description: string;
  clientVisible: boolean;
  updatedBy: string | null;
  updatedAt: Date;
}

/** How long an instance trusts its copy of the flags table. Admin changes on this instance clear it at once. */
export const FLAG_CACHE_TTL_MS = 30_000;

const caches = new WeakMap<Database, { at: number; flags: Map<string, StoredFlag> }>();

function toAudience(v: unknown): FlagAudience {
  const a = (v ?? {}) as { roles?: unknown; countries?: unknown };
  return {
    ...(Array.isArray(a.roles) ? { roles: a.roles.filter((r): r is Role => typeof r === 'string') } : {}),
    ...(Array.isArray(a.countries) ? { countries: a.countries.filter((c): c is string => typeof c === 'string') } : {}),
  };
}

export async function loadFlags(db: Database, now = Date.now()): Promise<Map<string, StoredFlag>> {
  const cached = caches.get(db);
  if (cached && now - cached.at < FLAG_CACHE_TTL_MS) return cached.flags;
  const rows = await db.selectFrom('feature_flags').selectAll().orderBy('key').execute();
  const flags = new Map(rows.map((r) => [r.key, {
    key: r.key, description: r.description, enabled: r.enabled, rolloutPercentage: r.rollout_percentage, audience: toAudience(r.audience),
    clientVisible: r.client_visible, updatedBy: r.updated_by, updatedAt: r.updated_at,
  } satisfies StoredFlag]));
  caches.set(db, { at: now, flags });
  return flags;
}

export function invalidateFlags(db: Database) {
  caches.delete(db);
}

/** The evaluation subject for a caller: their id, roles and sign-up country; signed-out callers by anonymous key. */
export async function flagSubject(deps: Deps, actor: Actor | null, anonKey: string | null): Promise<FlagSubject> {
  if (!actor) return { key: anonKey, roles: [], country: null };
  const age = await deps.db.selectFrom('age_records').select('country_code').where('user_id', '=', actor.userId).executeTakeFirst();
  return { key: actor.userId, roles: actor.roles, country: age?.country_code ?? null };
}

/**
 * Server-side check. Unknown flags are off, so removing a flag row turns its feature off rather
 * than breaking it. Nothing safety-critical may depend on a flag.
 */
export async function isEnabled(deps: Deps, key: string, actor: Actor | null, anonKey: string | null = null): Promise<boolean> {
  const flag = (await loadFlags(deps.db)).get(key);
  if (!flag) return false;
  return evaluateFlag(flag, await flagSubject(deps, actor, anonKey));
}

/** Every client-visible flag, evaluated for the caller. */
export async function evaluateClientFlags(deps: Deps, actor: Actor | null, anonKey: string | null): Promise<Record<string, boolean>> {
  const [flags, subject] = await Promise.all([loadFlags(deps.db), flagSubject(deps, actor, anonKey)]);
  const out: Record<string, boolean> = {};
  for (const f of flags.values()) if (f.clientVisible) out[f.key] = evaluateFlag(f, subject);
  return out;
}
