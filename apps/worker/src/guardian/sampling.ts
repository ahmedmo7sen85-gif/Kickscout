import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { GuardianPolicy } from '@fp/domain';
import { run } from '../media.js';
import type { MediaTools } from '../media.js';
import type { Frame } from './types.js';

type Sampling = GuardianPolicy['sampling'];

/** Frames this close together (ms) count as the same moment. */
const SAME_MOMENT_MS = 150;

const clampTo = (durationMs: number) => (t: number) => Math.max(0, Math.min(Math.round(t), Math.max(0, durationMs - 50)));

function dedupe(times: number[]): number[] {
  const out: number[] = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    if (out.length === 0 || t - out.at(-1)! >= SAME_MOMENT_MS) out.push(t);
  }
  return out;
}

/**
 * Screening timestamps over the whole clip: an even spread (one frame per `intervalMs`, within the
 * frame limits) plus a frame just after each scene cut, so a short scene spliced between football
 * shots is always seen. Never just the opening seconds.
 */
export function planScreenTimestamps(durationMs: number, s: Sampling, sceneCutsMs: readonly number[] = []): { atMs: number; source: Frame['source'] }[] {
  const clamp = clampTo(durationMs);
  const n = Math.max(s.minFrames, Math.min(s.maxFrames, Math.ceil(durationMs / s.intervalMs)));
  const even = Array.from({ length: n }, (_, i) => clamp(((i + 0.5) * durationMs) / n));
  const scenes = dedupe(sceneCutsMs.map((t) => clamp(t + 100))).filter((t) => even.every((e) => Math.abs(e - t) >= SAME_MOMENT_MS));
  // Too many cuts (a fast montage): keep an even selection of them.
  const keptScenes = scenes.length <= s.maxSceneFrames ? scenes : Array.from({ length: s.maxSceneFrames }, (_, i) => scenes[Math.floor((i * scenes.length) / s.maxSceneFrames)]!);
  const tagged = [...even.map((atMs) => ({ atMs, source: 'interval' as const })), ...keptScenes.map((atMs) => ({ atMs, source: 'scene' as const }))];
  const seen = new Set<number>();
  return tagged.sort((a, b) => a.atMs - b.atMs).filter((f) => (seen.has(f.atMs) ? false : (seen.add(f.atMs), true)));
}

/**
 * Deep-pass timestamps: dense frames around each suspicious moment, closest first, skipping moments
 * already sampled, up to `deepMaxFrames`.
 */
export function planDeepTimestamps(durationMs: number, s: Sampling, suspiciousMs: readonly number[], alreadyMs: readonly number[]): number[] {
  const clamp = clampTo(durationMs);
  const candidates: { t: number; distance: number }[] = [];
  for (const center of suspiciousMs) {
    for (let d = -s.deepWindowMs; d <= s.deepWindowMs; d += s.deepStepMs) {
      if (d === 0) continue;
      candidates.push({ t: clamp(center + d), distance: Math.abs(d) });
    }
  }
  const out: number[] = [];
  for (const c of candidates.sort((a, b) => a.distance - b.distance || a.t - b.t)) {
    if (out.length >= s.deepMaxFrames) break;
    if ([...alreadyMs, ...out].some((t) => Math.abs(t - c.t) < SAME_MOMENT_MS)) continue;
    out.push(c.t);
  }
  return out.sort((a, b) => a - b);
}

/** An even selection of `count` frames (for skill tags when nothing looked risky). */
export function evenSubset<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  return Array.from({ length: count }, (_, i) => items[Math.floor(((i + 0.5) * items.length) / count)]!);
}

/** Times (ms) where the picture changes sharply, from ffmpeg's scene score on a small copy of the video. */
export async function detectSceneCuts(tools: MediaTools, input: string, threshold: number): Promise<number[]> {
  if (threshold <= 0) return [];
  const r = await run(
    tools.ffmpeg,
    ['-nostdin', '-hide_banner', '-i', input, '-an', '-vf', `scale=160:-2,select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'],
    120_000,
  );
  if (r.timedOut || r.code !== 0) return []; // best effort: the even spread still covers the clip
  return [...r.stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Math.round(Number(m[1]) * 1000)).filter((t) => Number.isFinite(t));
}

const longSideScale = (max: number) => `scale=w='if(gte(iw,ih),min(${max},iw),-2)':h='if(gte(iw,ih),-2,min(${max},ih))'`;

/** Extracts a JPEG at each timestamp (~`longSide` px). Seeks that land past the end produce no frame and are skipped. */
export async function extractFramesAt(
  tools: MediaTools,
  input: string,
  dir: string,
  planned: readonly { atMs: number; source: Frame['source'] }[],
  longSide: number,
): Promise<Frame[]> {
  const frames: Frame[] = [];
  for (const [i, p] of planned.entries()) {
    const file = path.join(dir, `g-${p.source}-${i}-${p.atMs}.jpg`);
    const r = await run(
      tools.ffmpeg,
      ['-nostdin', '-v', 'error', '-y', '-ss', (p.atMs / 1000).toFixed(3), '-i', input, '-frames:v', '1', '-vf', longSideScale(longSide), '-q:v', '4', file],
      60_000,
    );
    if (r.timedOut) throw new Error('frame extraction timed out');
    if ((await stat(file).catch(() => null))?.size) frames.push({ data: await readFile(file), atMs: p.atMs, source: p.source });
  }
  return frames;
}

// ---------------------------------------------------------------- perceptual hashes

export interface FrameHash {
  atMs: number;
  /** 64-bit difference hash as a signed bigint (Postgres bigint). */
  hash: bigint;
  /** Hash of the mirror image. */
  mirrored: bigint;
}

function grayPixels(tools: MediaTools, jpeg: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn(tools.ffmpeg, ['-nostdin', '-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-vf', 'scale=9:8:flags=area,format=gray', '-f', 'rawvideo', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks);
      resolve(code === 0 && out.length === 72 ? out : null);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(jpeg);
  });
}

/** dHash of a 9x8 grayscale picture: one bit per horizontal neighbour pair. */
export function dhash(px: Uint8Array | Buffer, mirror = false): bigint {
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const at = (col: number) => px[y * 9 + (mirror ? 8 - col : col)]!;
      bits = (bits << 1n) | (at(x) < at(x + 1) ? 1n : 0n);
    }
  }
  return BigInt.asIntN(64, bits);
}

/** Flat pictures (black frames, fades, plain pitch) hash alike whatever they show, so they are not used for matching. */
function informative(px: Buffer): boolean {
  const mean = px.reduce((a, b) => a + b, 0) / px.length;
  const variance = px.reduce((a, b) => a + (b - mean) ** 2, 0) / px.length;
  return Math.sqrt(variance) >= 6;
}

export async function hashFrames(tools: MediaTools, frames: readonly Frame[]): Promise<FrameHash[]> {
  const out: FrameHash[] = [];
  for (const f of frames) {
    const px = await grayPixels(tools, f.data);
    if (px && informative(px)) out.push({ atMs: f.atMs, hash: dhash(px), mirrored: dhash(px, true) });
  }
  return out;
}

export function hamming(a: bigint, b: bigint): number {
  let x = BigInt.asUintN(64, a ^ b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}
