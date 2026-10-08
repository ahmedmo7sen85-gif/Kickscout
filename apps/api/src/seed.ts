/**
 * Demo seed data for development and previews. Every row is marked `is_demo` and the web app
 * labels it "Demo". Refuses to run in production unless explicitly allowed, so fake people never
 * appear as real users.
 *
 *   DATABASE_URL=... DOB_ENCRYPTION_KEY=... node dist/seed.js
 *
 * Demo videos point at the 20 promo clips under DEMO_MEDIA_PREFIX (default `promo/`) on the CDN,
 * e.g. promo/01_stepover.mp4 and promo/01_stepover.jpg. Upload the rendered clips there.
 */
import { createDb } from '@fp/db';
import { encrypt } from './platform/crypto.js';
import { newId } from './platform/ids.js';

export const PROMO_CLIPS = [
  ['01_stepover', 'step_over'], ['02_elastico', 'elastico'], ['03_rainbow_flick', 'rainbow_flick'], ['04_cruyff_turn', 'cruyff_turn'],
  ['05_roulette', 'roulette'], ['06_nutmeg', 'nutmeg'], ['07_la_croqueta', 'dribbling'], ['08_first_touch', 'first_touch'],
  ['09_juggling', 'juggling'], ['10_ball_mastery', 'ball_control'], ['11_outside_foot_pass', 'passing'], ['12_long_range_shot', 'shooting'],
  ['13_free_kick', 'free_kick'], ['14_volley', 'volley'], ['15_speed_dribble', 'speed'], ['16_1v1_showcase', 'one_v_one'],
  ['17_ball_recovery', 'defending'], ['18_skill_combo', 'freestyle'], ['19_talent_showcase', 'dribbling'], ['20_hero_your_skill_your_moment', 'dribbling'],
] as const;

const PLAYERS = [
  { handle: 'demo_winger_eg', name: 'Demo Winger', country: 'EG', region: 'EG-cairo', position: 'LW', foot: 'left' },
  { handle: 'demo_playmaker_sa', name: 'Demo Playmaker', country: 'SA', region: 'SA-riyadh', position: 'AM', foot: 'right' },
  { handle: 'demo_striker_ae', name: 'Demo Striker', country: 'AE', region: 'AE-dubai', position: 'ST', foot: 'right' },
  { handle: 'demo_freestyler_eg', name: 'Demo Freestyler', country: 'EG', region: 'EG-alexandria', position: 'CM', foot: 'both' },
  { handle: 'demo_defender_qa', name: 'Demo Defender', country: 'QA', region: 'QA', position: 'CB', foot: 'right' },
] as const;

export async function seed(databaseUrl: string, dobKey: Buffer, mediaPrefix = 'promo') {
  const db = createDb(databaseUrl, 2);
  const regions = new Map((await db.selectFrom('regions').select(['id', 'code']).execute()).map((r) => [r.code, r.id]));
  const exists = await db.selectFrom('users').select('id').where('is_demo', '=', true).executeTakeFirst();
  if (exists) {
    await db.destroy();
    return { created: false };
  }
  await db.transaction().execute(async (tx) => {
    const playerIds: string[] = [];
    for (const p of PLAYERS) {
      const id = newId();
      playerIds.push(id);
      await tx.insertInto('users').values({ id, idp_subject: `demo:${p.handle}`, email: null, status: 'active', is_demo: true }).execute();
      await tx.insertInto('age_records').values({ user_id: id, dob_encrypted: encrypt(dobKey, '2000-01-01'), country_code: p.country, age_band: 'adult', guardian_required: false }).execute();
      await tx.insertInto('profiles').values({ user_id: id, handle: p.handle, display_name: p.name, bio: 'Demo account for previews. Not a real player.', region_id: regions.get(p.region) ?? regions.get(p.country) ?? null }).execute();
      await tx.insertInto('user_roles').values({ user_id: id, role: 'player' }).execute();
      await tx.insertInto('player_profiles').values({ user_id: id, primary_position: p.position, preferred_foot: p.foot }).execute();
      await tx.insertInto('privacy_settings').values({ user_id: id }).execute();
    }

    // Clips 01-19 go to the demo players in turn; clip 20 is the landing-page hero and is not a feed video.
    const now = Date.now();
    for (const [i, [stem, skill]] of PROMO_CLIPS.slice(0, 19).entries()) {
      const id = newId();
      const owner = playerIds[i % playerIds.length]!;
      const title = stem.slice(3).split('_').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
      const at = new Date(now - (19 - i) * 3600_000);
      await tx.insertInto('videos').values({
        id, owner_user_id: owner, status: 'published', original_key: `demo/${stem}.mp4`, declared_type: 'video/mp4', size_bytes: 1,
        title: `${title} (AI-generated demo)`, description: 'AI-generated promotional clip used as demo content.', skill_key: skill,
        context: 'freestyle', visibility: 'public', duration_ms: 5000, width: 704, height: 1280,
        playback_key: `${mediaPrefix}/${stem}.mp4`, thumbnail_key: `${mediaPrefix}/${stem}.jpg`, moderation: 'safe', created_at: at, published_at: at,
      }).execute();
      // Curated tags, entered as the uploader's own tags: no AI output is faked.
      await tx.insertInto('video_skills').values({ video_id: id, skill_key: skill, source: 'user' }).execute();
      await tx.insertInto('video_hashtags').values([{ video_id: id, tag: 'kickscout' }, { video_id: id, tag: skill.replace(/_/g, '') }]).execute();
    }

    const scoutId = newId();
    await tx.insertInto('users').values({ id: scoutId, idp_subject: 'demo:demo_scout', status: 'active', is_demo: true }).execute();
    await tx.insertInto('age_records').values({ user_id: scoutId, dob_encrypted: encrypt(dobKey, '1985-01-01'), country_code: 'EG', age_band: 'adult', guardian_required: false }).execute();
    await tx.insertInto('profiles').values({ user_id: scoutId, handle: 'demo_scout', display_name: 'Demo Scout', bio: 'Demo scout account. Not a real scout.', verified_at: new Date() }).execute();
    await tx.insertInto('user_roles').values([{ user_id: scoutId, role: 'fan' }, { user_id: scoutId, role: 'scout' }]).execute();
    await tx.insertInto('privacy_settings').values({ user_id: scoutId }).execute();
    await tx.insertInto('verification_requests').values({ id: newId(), user_id: scoutId, kind: 'scout', status: 'approved', organization: 'Demo Academy', evidence: 'Seeded demo data', decided_at: new Date() }).execute();

    const day = 86400_000;
    for (const [slug, en, ar, skill] of [
      ['elastico-challenge', '#ElasticoChallenge', '#تحدي_الإلاستيكو', 'elastico'],
      ['freestyle-challenge', '#FreestyleChallenge', '#تحدي_الفريستايل', 'freestyle'],
      ['first-touch-challenge', '#FirstTouchChallenge', '#تحدي_اللمسة_الأولى', 'first_touch'],
    ] as const) {
      await tx.insertInto('challenges').values({
        id: newId(), slug, title: JSON.stringify({ en, ar }), skill_key: skill, hashtag: slug.replace(/-/g, ''), is_demo: true,
        description: JSON.stringify({ en: `Demo challenge. Upload your best ${skill.replace(/_/g, ' ')} clip.`, ar: 'تحدٍ تجريبي. ارفع أفضل مقطع لديك.' }),
        starts_at: new Date(now - day), ends_at: new Date(now + 30 * day),
      }).onConflict((oc) => oc.column('slug').doNothing()).execute();
    }
  });
  await db.destroy();
  return { created: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  const key = process.env.DOB_ENCRYPTION_KEY;
  if (!url || !key) throw new Error('DATABASE_URL and DOB_ENCRYPTION_KEY are required');
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'yes') {
    throw new Error('refusing to seed demo data in production (set ALLOW_DEMO_SEED=yes for a labelled preview environment)');
  }
  const r = await seed(url, Buffer.from(key, 'base64'), process.env.DEMO_MEDIA_PREFIX ?? 'promo');
  console.log(r.created ? 'demo data created (all rows marked is_demo)' : 'demo data already present');
}
