import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { MediaRejection } from './errors.js';

export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
}

export const LIMITS = {
  minDurationMs: 1_000,
  maxDurationMs: 180_000,
  minShortSide: 240,
  maxLongSide: 4096,
  outputMaxShortSide: 720,
  frameLongSide: 512,
  decodeTimeoutMs: 180_000,
  ffmpegTimeoutMs: 600_000,
} as const;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a binary with an argument array (never a shell), capturing bounded output, killing it after `timeoutMs`. */
export function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const cap = 4 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < cap) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < cap) stderr += d.toString('utf8');
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function runOk(bin: string, args: string[], timeoutMs: number, what: string): Promise<RunResult> {
  const r = await run(bin, args, timeoutMs);
  if (r.timedOut) throw new Error(`${what} timed out after ${timeoutMs} ms`);
  if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 500)}`);
  return r;
}

export async function sha256File(file: string): Promise<Buffer> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest();
}

// ---------------------------------------------------------------- probing

const ProbeStream = z.object({
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  duration: z.string().optional(),
  disposition: z.record(z.string(), z.number()).optional(),
  tags: z.record(z.string(), z.string()).optional(),
  side_data_list: z.array(z.object({ rotation: z.number().optional() }).loose()).optional(),
}).loose();

const ProbeOutput = z.object({
  streams: z.array(ProbeStream).default([]),
  format: z.object({
    format_name: z.string().optional(),
    duration: z.string().optional(),
    tags: z.record(z.string(), z.string()).optional(),
  }).loose().optional(),
}).loose();

export type DetectedFormat = 'mp4' | 'mov' | 'webm';

export interface ProbeInfo {
  format: DetectedFormat;
  /** Display dimensions (rotation applied). */
  width: number;
  height: number;
  /** Full file duration; null when the container does not record one (common for browser-recorded WebM). */
  durationMs: number | null;
  videoCodec: string;
  hasAudio: boolean;
}

const WEBM_VIDEO = new Set(['vp8', 'vp9', 'av1']);
const WEBM_AUDIO = new Set(['vorbis', 'opus']);

const seconds = (s: string | undefined) => {
  const n = s === undefined ? Number.NaN : Number.parseFloat(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
};

/** Inspects the real bytes. Throws MediaRejection when the file is not an acceptable video container. */
export async function probe(tools: MediaTools, file: string): Promise<ProbeInfo> {
  const r = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 60_000);
  if (r.timedOut) throw new MediaRejection('The file could not be read in time.');
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  const parsed = ProbeOutput.safeParse(json);
  if (r.code !== 0 || !parsed.success || !parsed.data.format?.format_name) {
    throw new MediaRejection('This file is not a video we can read. Upload an MP4, MOV or WebM video.');
  }
  const { streams, format } = parsed.data;
  const names = format!.format_name!.split(',');
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video || !video.codec_name || !video.width || !video.height) {
    throw new MediaRejection('The file has no video track.');
  }
  const audio = streams.filter((s) => s.codec_type === 'audio');

  let detected: DetectedFormat;
  if (names.includes('mov') || names.includes('mp4')) {
    detected = format!.tags?.major_brand?.trim() === 'qt' ? 'mov' : 'mp4';
  } else if (names.includes('webm') || names.includes('matroska')) {
    // ffprobe reports Matroska and WebM alike; WebM is Matroska restricted to these codecs.
    const webmCodecs = WEBM_VIDEO.has(video.codec_name) && audio.every((a) => a.codec_name && WEBM_AUDIO.has(a.codec_name));
    if (!webmCodecs) throw new MediaRejection('MKV files are not supported. Upload an MP4, MOV or WebM video.');
    detected = 'webm';
  } else {
    throw new MediaRejection(`Unsupported file type (${names[0]}). Upload an MP4, MOV or WebM video.`);
  }

  const rotation = video.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? Number(video.tags?.rotate ?? 0);
  const quarterTurn = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  return {
    format: detected,
    width: quarterTurn ? video.height : video.width,
    height: quarterTurn ? video.width : video.height,
    durationMs: seconds(format!.duration) ?? seconds(video.duration),
    videoCodec: video.codec_name,
    hasAudio: audio.length > 0,
  };
}

/**
 * Decodes every frame of the first video and audio track, discarding the output. Any decoder error means a
 * corrupt or truncated file. Returns the decoded duration, which covers containers without a recorded duration.
 */
export async function decodeCheck(tools: MediaTools, file: string): Promise<{ decodedMs: number | null }> {
  const r = await run(
    tools.ffmpeg,
    ['-nostdin', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'],
    LIMITS.decodeTimeoutMs,
  );
  if (r.timedOut) throw new MediaRejection('The video took too long to check. Try a shorter or smaller file.');
  if (r.code !== 0 || r.stderr.trim() !== '') {
    throw new MediaRejection('The video is damaged or incomplete and could not be played. Try exporting it again.');
  }
  const times = [...r.stdout.matchAll(/^out_time_us=(\d+)$/gm)].map((m) => Number(m[1]));
  const last = times.at(-1);
  return { decodedMs: last && last > 0 ? Math.round(last / 1000) : null };
}

export interface TrimWindow {
  startMs: number;
  durationMs: number;
}

/** Applies the uploader's trim to the real duration and enforces the length and resolution rules. */
export function validate(info: ProbeInfo, fullDurationMs: number, trimStartMs: number | null, trimEndMs: number | null): TrimWindow {
  const start = trimStartMs ?? 0;
  const end = Math.min(trimEndMs ?? fullDurationMs, fullDurationMs);
  if (start >= fullDurationMs) throw new MediaRejection('The trim starts after the end of the video.');
  const duration = end - start;
  if (duration < LIMITS.minDurationMs) throw new MediaRejection('The video is shorter than 1 second after trimming.');
  if (duration > LIMITS.maxDurationMs) {
    throw new MediaRejection(`The video is ${Math.round(duration / 1000)} seconds long after trimming; the limit is 180 seconds.`);
  }
  const short = Math.min(info.width, info.height);
  const long = Math.max(info.width, info.height);
  if (short < LIMITS.minShortSide) throw new MediaRejection(`The video resolution (${info.width}x${info.height}) is too low; the minimum is 240p.`);
  if (long > LIMITS.maxLongSide) throw new MediaRejection(`The video resolution (${info.width}x${info.height}) is above the 4096 pixel limit.`);
  return { startMs: start, durationMs: duration };
}

// ---------------------------------------------------------------- outputs

const secs = (ms: number) => (ms / 1000).toFixed(3);

/** Even dimensions, at most `max` on the short side, never upscaled, orientation kept. */
const shortSideScale = (max: number) =>
  `scale=w='if(lte(iw,ih),trunc(min(${max},iw)/2)*2,-2)':h='if(lte(iw,ih),-2,trunc(min(${max},ih)/2)*2)',setsar=1`;

const longSideScale = (max: number) => `scale=w='if(gte(iw,ih),min(${max},iw),-2)':h='if(gte(iw,ih),-2,min(${max},ih))'`;

/** H.264 + AAC MP4, web-optimised (moov first), trimmed. */
export async function transcode(tools: MediaTools, input: string, output: string, trim: TrimWindow): Promise<void> {
  await runOk(
    tools.ffmpeg,
    [
      '-nostdin', '-v', 'error', '-y',
      '-ss', secs(trim.startMs), '-i', input, '-t', secs(trim.durationMs),
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', shortSideScale(LIMITS.outputMaxShortSide),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-movflags', '+faststart', '-map_metadata', '-1',
      output,
    ],
    LIMITS.ffmpegTimeoutMs,
    'transcode',
  );
}

/** Thumbnail from ~1 s in, or the midpoint of clips shorter than 2 s. Expects the already trimmed output. */
export async function thumbnail(tools: MediaTools, input: string, output: string, durationMs: number): Promise<void> {
  const at = durationMs >= 2_000 ? 1_000 : durationMs / 2;
  await runOk(
    tools.ffmpeg,
    ['-nostdin', '-v', 'error', '-y', '-ss', secs(at), '-i', input, '-frames:v', '1', '-q:v', '3', output],
    60_000,
    'thumbnail',
  );
}

/** `count` evenly spaced JPEG frames, ~512 px on the long side. Returns their paths and timestamps. */
export async function extractFrames(
  tools: MediaTools,
  input: string,
  dir: string,
  durationMs: number,
  count = 6,
): Promise<{ path: string; atMs: number }[]> {
  const frames: { path: string; atMs: number }[] = [];
  for (let i = 0; i < count; i++) {
    const atMs = Math.round(((i + 0.5) * durationMs) / count);
    const path = `${dir}/frame-${i}.jpg`;
    await runOk(
      tools.ffmpeg,
      ['-nostdin', '-v', 'error', '-y', '-ss', secs(atMs), '-i', input, '-frames:v', '1', '-vf', longSideScale(LIMITS.frameLongSide), '-q:v', '4', path],
      60_000,
      'frame extraction',
    );
    // A seek right at the end of a stream can legitimately produce no frame.
    if ((await stat(path).catch(() => null))?.size) frames.push({ path, atMs });
  }
  return frames;
}
