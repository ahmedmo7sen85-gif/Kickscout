import { describe, expect, it } from 'vitest';
import { detectContentType } from '@/app/upload/UploadFlow';
import { ageFrom } from '@/app/onboarding/OnboardingForm';
import { featuredSkills } from '@/app/u/[handle]/ProfileView';
import type { VideoView } from '@/lib/types';

describe('upload helpers', () => {
  it('detects allowed content types from type or extension', () => {
    expect(detectContentType({ type: 'video/mp4', name: 'a.mp4' })).toBe('video/mp4');
    expect(detectContentType({ type: '', name: 'clip.MOV' })).toBe('video/quicktime');
    expect(detectContentType({ type: '', name: 'clip.webm' })).toBe('video/webm');
    expect(detectContentType({ type: 'video/x-msvideo', name: 'clip.avi' })).toBeNull();
  });
});

describe('onboarding age hint', () => {
  it('computes whole years', () => {
    const now = new Date(2026, 9, 8);
    expect(ageFrom('2010-10-08', now)).toBe(16);
    expect(ageFrom('2010-10-09', now)).toBe(15);
    expect(ageFrom('nope', now)).toBeNull();
  });
});

describe('featured skills', () => {
  it('counts declared skills and player tags but ignores AI suggestions', () => {
    const v = (skill: VideoView['skill'], tags: VideoView['tags']) => ({ skill, tags }) as unknown as VideoView;
    const res = featuredSkills([
      v('elastico', [{ skill: 'dribbling', name: { en: '', ar: '' }, source: 'user', confidence: null }]),
      v('elastico', [{ skill: 'nutmeg', name: { en: '', ar: '' }, source: 'ai', confidence: 0.9 }]),
    ]);
    expect(res).toEqual([{ skill: 'elastico', count: 2 }, { skill: 'dribbling', count: 1 }]);
  });
});
