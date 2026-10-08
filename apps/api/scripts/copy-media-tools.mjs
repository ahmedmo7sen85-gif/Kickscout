// Copies the static ffmpeg/ffprobe binaries into ./bin so the Vercel worker function can ship them (see vercel.json).
// Skipped quietly where the installers have no binary for this platform (e.g. macOS dev machines without them).
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const out = new URL('../bin/', import.meta.url);
mkdirSync(out, { recursive: true });
for (const [name, pkg] of [['ffmpeg', '@ffmpeg-installer/ffmpeg'], ['ffprobe', '@ffprobe-installer/ffprobe']]) {
  let src;
  try {
    src = require(pkg).path;
  } catch (err) {
    console.warn(`copy-media-tools: ${pkg} has no binary here (${err.message}); skipping`);
    continue;
  }
  const dest = new URL(name, out);
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  console.log(`copy-media-tools: ${name} <- ${src}`);
}
