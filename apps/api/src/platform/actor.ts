import { sql } from 'kysely';
import type { Actor, AgeBand, ConsentPurpose, Role, UserStatus } from '@fp/domain';
import type { Database } from '@fp/db';
import type { Identity } from './auth.js';

/** Current consents for a subject: the latest decision per purpose, granted ones only. */
export async function currentConsents(db: Database, subjectId: string): Promise<Set<ConsentPurpose>> {
  const rows = await db
    .selectFrom('consents')
    .select(['purpose', 'granted'])
    .distinctOn('purpose')
    .where('subject_user_id', '=', subjectId)
    .orderBy('purpose')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return new Set(rows.filter((r) => r.granted).map((r) => r.purpose as ConsentPurpose));
}

export async function ageBandOf(db: Database, userId: string): Promise<AgeBand | null> {
  const row = await db.selectFrom('age_records').select('age_band').where('user_id', '=', userId).executeTakeFirst();
  return (row?.age_band as AgeBand | undefined) ?? null;
}

/** Builds the authorization actor from the database. Roles never come from the client or token. */
export async function loadActor(db: Database, identity: Identity): Promise<Actor | null> {
  const user = await db
    .selectFrom('users')
    .leftJoin('age_records', 'age_records.user_id', 'users.id')
    .select(['users.id', 'users.status', 'age_records.age_band'])
    .where('users.idp_subject', '=', identity.subject)
    .executeTakeFirst();
  if (!user) return null;

  const [roles, wards, consents] = await Promise.all([
    db.selectFrom('user_roles').select('role').where('user_id', '=', user.id).execute(),
    db
      .selectFrom('guardian_relationships')
      .select('minor_user_id')
      .where('guardian_user_id', '=', user.id)
      .where('status', '=', 'active')
      .execute(),
    currentConsents(db, user.id),
  ]);

  return {
    userId: user.id,
    roles: roles.map((r) => r.role as Role),
    status: user.status as UserStatus,
    ageBand: (user.age_band ?? 'adult') as AgeBand,
    mfa: identity.mfa,
    guardianOf: wards.map((w) => w.minor_user_id),
    consents,
  };
}

export const nowSql = sql<Date>`now()`;
