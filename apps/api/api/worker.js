// Vercel function that processes queued videos and runs storage maintenance. It ships the ffmpeg/ffprobe binaries
// copied into ../bin at build time; they are copied to /tmp first if the deployment lost their executable bit.
import { accessSync, chmodSync, constants, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function executable(name) {
  const shipped = fileURLToPath(new URL(`../bin/${name}`, import.meta.url));
  try {
    accessSync(shipped, constants.X_OK);
    return shipped;
  } catch {
    mkdirSync('/tmp/bin', { recursive: true });
    const copy = `/tmp/bin/${name}`;
    try {
      accessSync(copy, constants.X_OK);
    } catch {
      copyFileSync(shipped, copy);
      chmodSync(copy, 0o755);
    }
    return copy;
  }
}

process.env.FFMPEG_PATH ||= executable('ffmpeg');
process.env.FFPROBE_PATH ||= executable('ffprobe');

export { default } from '@fp/worker/serverless';
