import * as C from '@fp/contracts';
import { describe, expect, it } from 'vitest';
import * as L from '@/lib/constants';

describe('client enum copies match the contracts', () => {
  it.each([
    ['POSITIONS', L.POSITIONS, C.Position.options],
    ['FEET', L.FEET, C.Foot.options],
    ['SKILL_KEYS', L.SKILL_KEYS, C.SkillKey.options],
    ['AGE_BANDS', L.AGE_BANDS, C.AgeBand.options],
    ['FEED_TABS', L.FEED_TABS, C.FeedTab.options],
    ['RADAR_CATEGORIES', L.RADAR_CATEGORIES, C.RadarCategory.options],
    ['REPORT_REASONS', L.REPORT_REASONS, C.ReportReason.options],
    ['VIDEO_CONTENT_TYPES', L.VIDEO_CONTENT_TYPES, C.VideoContentType.options],
    ['VIDEO_STATUSES', L.VIDEO_STATUSES, C.VideoStatus.options],
    ['VIDEO_CONTEXTS', L.VIDEO_CONTEXTS, C.VideoContext.options],
    ['VISIBILITIES', L.VISIBILITIES, C.Visibility.options],
    ['CONSENT_PURPOSES', L.CONSENT_PURPOSES, C.ConsentPurpose.options],
  ])('%s', (_name, local, contract) => {
    expect([...local]).toEqual([...contract]);
  });

  it('upload limits equal the contract limits', () => {
    expect(L.MAX_UPLOAD_BYTES).toBe(C.MAX_UPLOAD_BYTES);
    expect(L.MAX_DURATION_MS).toBe(C.MAX_DURATION_MS);
  });

  it('normalises hashtags like the server', () => {
    expect(L.normalizeHashtag('#ElasticoChallenge')).toBe('elasticochallenge');
    expect(L.normalizeHashtag('مهارة_اليوم')).toBe('مهارة_اليوم');
    expect(L.normalizeHashtag('bad tag')).toBeNull();
    expect(C.Hashtag.parse('#ElasticoChallenge')).toBe('elasticochallenge');
  });
});
