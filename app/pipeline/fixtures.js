// Reads the dry-run week (dryrun/data) so the pipeline can run in fake mode without calling Apify
// or Gemini: raw actor output per platform, TikTok subtitles, and the checked cards and groups.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FALLBACK = 'D:/Projects/Codeamesh/POC/Content-Story/dryrun/data';

export const isFake = () => process.env.PIPELINE_PROVIDER === 'fake';

// DRYRUN_DATA wins; otherwise the repo's own dryrun/data when it has data, else the main checkout.
export function fixtureDir() {
  if (process.env.DRYRUN_DATA) return resolve(process.env.DRYRUN_DATA);
  const local = resolve(HERE, '..', '..', 'dryrun', 'data');
  return existsSync(join(local, 'raw')) ? local : FALLBACK;
}

function readJsonIf(file) {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

// Raw actor items saved by the dry run at raw/<platform>/<label>.json, or null when absent.
export function readRawFixture(platform, label) {
  return readJsonIf(join(fixtureDir(), 'raw', platform, `${label}.json`));
}

// The dry run's collection window; the raw files only hold posts from these dates.
export function readFixtureMeta() {
  return readJsonIf(join(fixtureDir(), 'raw', 'meta.json'));
}

// Subtitle text (VTT) the dry run downloaded for a TikTok video, or null.
export function readTikTokSubtitle(videoId) {
  const file = join(fixtureDir(), 'raw', 'tiktok', 'subtitles', `${videoId}.vtt`);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

// One checked AI output per post: cards/<post_id>.json or groups/<post_id>.json.
export function readFixtureOutput(step, postId) {
  return readJsonIf(join(fixtureDir(), step, `${postId}.json`));
}
