import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// DATA_DIR and OUT_DIR let a second run (e.g. Gemini) live beside the first without overwriting it.
export const DATA = process.env.DATA_DIR ? resolve(ROOT, process.env.DATA_DIR) : join(ROOT, 'data');
export const OUT = process.env.OUT_DIR ? resolve(ROOT, process.env.OUT_DIR) : join(ROOT, 'out');

export const PLATFORM_NAMES = {
  x: 'X', youtube: 'YouTube', instagram: 'Instagram', linkedin: 'LinkedIn', tiktok: 'TikTok', reddit: 'Reddit',
};

// AI steps sometimes wrap JSON in a code fence or add a BOM; accept both.
export function parseJsonLoose(raw, label = 'input') {
  let text = raw.replace(/^﻿/, '').trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1];
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Bad JSON in ${label}: ${err.message}`);
  }
}

export function readJson(file, fallback) {
  if (!existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing file: ${file}`);
  }
  return parseJsonLoose(readFileSync(file, 'utf8'), file);
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

export function listJson(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f));
}

export function resetDir(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

export function loadEnv() {
  for (const name of ['.env', '.env.local']) {
    const file = join(ROOT, name);
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

export const truncate = (value, max) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

export const round1 = (n) => Math.round(n * 10) / 10;

// A comment liked by thousands represents more people than one nobody liked.
export const commentWeight = (likes) => 1 + Math.log1p(Math.max(0, Number(likes) || 0));

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// Loads posts, comments and every AI output into lookup maps.
export function loadWorld() {
  const posts = readJson(join(DATA, 'posts.json'));
  const comments = readJson(join(DATA, 'comments.json'));
  const postById = new Map(posts.map((p) => [p.post_id, p]));
  const commentById = new Map(comments.map((c) => [c.comment_id, c]));
  const groupById = new Map();
  const claimById = new Map();
  const cardByPost = new Map();
  const groupsByPost = new Map();

  for (const file of listJson(join(DATA, 'cards'))) {
    const card = readJson(file);
    cardByPost.set(card.post_id, card);
    for (const claim of card.claims || []) claimById.set(claim.claim_id, { ...claim, post_id: card.post_id });
  }
  for (const file of listJson(join(DATA, 'groups'))) {
    const result = readJson(file);
    groupsByPost.set(result.post_id, result);
    for (const group of result.groups || []) groupById.set(group.group_id, { ...group, post_id: result.post_id });
  }
  return { posts, comments, postById, commentById, groupById, claimById, cardByPost, groupsByPost };
}
