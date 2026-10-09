import { describe, expect, it } from 'vitest';
import { makeScanPicture } from '@/app/play/scan/ScanView';
import { sy } from '@/components/play/Pitch';

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, sy(a.y) - sy(b.y));

/** Small deterministic generator so the test covers many pictures the same way every run. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('scan drill pictures', () => {
  it('always has exactly one free teammate and marks every other one', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const pic = makeScanPicture(seeded(seed));
      expect(pic.team).toHaveLength(4);
      expect(pic.free).toBeGreaterThanOrEqual(0);
      expect(pic.free).toBeLessThan(4);
      pic.team.forEach((p, i) => {
        const nearest = Math.min(...pic.opp.map((o) => dist(o, p)));
        if (i === pic.free) expect(nearest, `seed ${seed}`).toBeGreaterThan(18);
        else expect(nearest, `seed ${seed}`).toBeLessThan(7);
      });
      for (const p of [...pic.team, ...pic.opp]) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(100);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('pitch focus', () => {
  it('frames the action with a margin and a minimum length, inside the pitch', async () => {
    const { focusRange } = await import('@/components/play/Pitch');
    expect(focusRange([])).toEqual([0, 100]);
    expect(focusRange([20, 50])).toEqual([5, 65]);
    expect(focusRange([10, 70])).toEqual([0, 80]);
    expect(focusRange([2, 10])).toEqual([0, 60]);
    expect(focusRange([95, 99])).toEqual([40, 100]);
    expect(focusRange([5, 95])).toEqual([0, 100]);
  });
});
