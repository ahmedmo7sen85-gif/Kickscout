import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '@fp/db';
import type { GuardianPolicy } from '@fp/domain';
import type { FrameHash } from './sampling.js';
import type { DuplicateSignals } from './types.js';

type Db = Kysely<DB> | Transaction<DB>;

/**
 * Duplicate Content Detector. Exact copies (sha256) and edited copies (perceptual frame hashes, mirror
 * images included) of videos already rejected or removed for their content, and byte-identical copies
 * of someone else's live video. A hash match is a strong hint, not proof: edited versions can differ a
 * lot, so everything else in the scan still runs, and a near match only sends the clip to a person.
 */
export class DuplicateContentDetector {
  constructor(private readonly db: Db) {}

  /** Byte-level checks, done before any frame leaves the platform. */
  async exact(videoId: string, ownerId: string, sha256: Buffer): Promise<Pick<DuplicateSignals, 'exactRejected' | 'otherOwnerDuplicate'>> {
    const rejected = await this.db.selectFrom('videos')
      .select(['id', 'legal_hold'])
      .where('sha256', '=', sha256)
      .where('id', '<>', videoId)
      .where((eb) => eb.or([eb('legal_hold', '=', true), eb.and([eb('safety_status', 'in', ['REJECTED', 'REMOVED']), eb('moderation', '=', 'rejected')])]))
      .orderBy('legal_hold', 'desc')
      .executeTakeFirst();
    const other = await this.db.selectFrom('videos')
      .select('id')
      .where('sha256', '=', sha256)
      .where('id', '<>', videoId)
      .where('owner_user_id', '<>', ownerId)
      .where('status', '<>', 'deleted')
      .where('deleted_at', 'is', null)
      .where('safety_status', 'not in', ['REJECTED', 'REMOVED'])
      .orderBy('created_at')
      .executeTakeFirst();
    return {
      exactRejected: rejected ? { videoId: rejected.id, childSafety: rejected.legal_hold } : null,
      otherOwnerDuplicate: other?.id ?? null,
    };
  }

  /** Frames of this clip that look like frames of a rejected video (stored hashes include mirror images). */
  async similar(videoId: string, hashes: readonly FrameHash[], policy: GuardianPolicy): Promise<DuplicateSignals['similarRejected']> {
    if (hashes.length === 0) return null;
    const probes = hashes.map((h) => h.hash.toString());
    const { rows } = await sql<{ video_id: string; matched: string; legal_hold: boolean }>`
      SELECT h.video_id, count(DISTINCT p.idx) AS matched, bool_or(v.legal_hold) AS legal_hold
      FROM unnest(${probes}::bigint[]) WITH ORDINALITY AS p(hash, idx)
      JOIN video_frame_hashes h ON bit_count((h.dhash # p.hash)::bit(64)) <= ${policy.hashMaxDistance}
      JOIN videos v ON v.id = h.video_id
      WHERE h.video_id <> ${videoId}
        AND (v.legal_hold OR (v.safety_status IN ('REJECTED', 'REMOVED') AND v.moderation = 'rejected'))
      GROUP BY h.video_id
      ORDER BY bool_or(v.legal_hold) DESC, count(DISTINCT p.idx) DESC
      LIMIT 1`.execute(this.db);
    const best = rows[0];
    if (!best) return null;
    const matched = Number(best.matched);
    const share = matched / hashes.length;
    if (matched < policy.hashMinFrames || share < policy.hashMinShare) return null;
    return { videoId: best.video_id, matchedFrames: matched, share: Math.round(share * 1000) / 1000, childSafety: best.legal_hold };
  }

  /** Keeps this clip's hashes so later re-uploads can be matched against it if it is ever rejected. */
  async store(videoId: string, hashes: readonly FrameHash[]): Promise<void> {
    await this.db.deleteFrom('video_frame_hashes').where('video_id', '=', videoId).execute();
    if (hashes.length === 0) return;
    await this.db.insertInto('video_frame_hashes').values(hashes.flatMap((h) => [
      { video_id: videoId, at_ms: h.atMs, dhash: h.hash.toString(), mirrored: false },
      { video_id: videoId, at_ms: h.atMs, dhash: h.mirrored.toString(), mirrored: true },
    ])).onConflict((oc) => oc.doNothing()).execute();
  }
}
