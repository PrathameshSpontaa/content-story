// Checks AI batch outputs and splits them into one file per post.
// Usage: node scripts/ingest.mjs <cards|groups>
//   reads  data/ai_out/<step>/*.json   (each a JSON array written by the model)
//   writes data/<step>/<post_id>.json  (only items that pass the checks)
import { basename, join } from 'node:path';
import { DATA, listJson, loadWorld, readJson, writeJson } from './lib.mjs';

const step = process.argv[2];
if (!['cards', 'groups'].includes(step)) {
  console.log('Usage: node scripts/ingest.mjs <cards|groups>');
  process.exit(1);
}

const { postById, commentById } = loadWorld();
const normalize = (s) => String(s ?? '').normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
const problems = [];
const fixes = { claim_ids: 0, quotes_removed: 0, group_ids: 0, foreign_comments: 0, duplicate_comments: 0, bad_samples: 0 };
let written = 0;

const expected = new Set(
  listJson(join(DATA, 'inputs', step)).flatMap((f) => readJson(f).map((x) => (step === 'cards' ? x.post_id : x.post.post_id))),
);
const sentComments = new Map();
if (step === 'groups') {
  for (const f of listJson(join(DATA, 'inputs', 'groups'))) for (const x of readJson(f)) sentComments.set(x.post.post_id, new Set(x.comments.map((c) => c.comment_id)));
}

function checkCard(card) {
  const post = postById.get(card.post_id);
  const missing = ['about', 'type', 'category'].filter((k) => typeof card[k] !== 'string' || !card[k].trim());
  if (typeof card.newsworthy !== 'boolean') missing.push('newsworthy');
  if (missing.length) return `missing ${missing.join(', ')}`;
  card.entities = Array.isArray(card.entities) ? card.entities.filter((e) => e?.name) : [];
  card.events = Array.isArray(card.events) ? card.events.filter((e) => e?.what) : [];
  card.claims = Array.isArray(card.claims) ? card.claims.filter((c) => c?.text) : [];
  const source = normalize(`${post.text} ${post.transcript}`);
  card.claims.forEach((claim, i) => {
    const id = `${card.post_id}#c${i + 1}`;
    if (claim.claim_id !== id) {
      claim.claim_id = id;
      fixes.claim_ids += 1;
    }
    // A quote the model can't show verbatim is worse than no quote.
    if (claim.quote && !source.includes(normalize(claim.quote))) {
      claim.quote = null;
      fixes.quotes_removed += 1;
    }
  });
  return null;
}

function checkGroups(result) {
  const allowed = sentComments.get(result.post_id) ?? new Set();
  const seen = new Set();
  result.dropped = (result.dropped ?? []).filter((id) => allowed.has(id) && !seen.has(id) && seen.add(id));
  result.groups = (Array.isArray(result.groups) ? result.groups : []).map((g, i) => {
    const id = `${result.post_id}#g${i + 1}`;
    if (g.group_id !== id) fixes.group_ids += 1;
    const ids = [];
    for (const cid of g.comment_ids ?? []) {
      if (!allowed.has(cid)) fixes.foreign_comments += 1;
      else if (seen.has(cid)) fixes.duplicate_comments += 1;
      else {
        seen.add(cid);
        ids.push(cid);
      }
    }
    const samples = (g.sample_ids ?? []).filter((s) => ids.includes(s));
    fixes.bad_samples += (g.sample_ids ?? []).length - samples.length;
    return { ...g, group_id: id, comment_ids: ids, sample_ids: samples.length ? samples : ids.slice(0, 3) };
  }).filter((g) => g.comment_ids.length);
  result.creator_replies = (result.creator_replies ?? []).filter((r) => commentById.get(r.comment_id)?.is_creator);
  const unassigned = [...allowed].filter((id) => !seen.has(id));
  if (unassigned.length > allowed.size * 0.2) return `${unassigned.length} of ${allowed.size} comments not placed in any group`;
  return null;
}

const done = new Set();
for (const file of listJson(join(DATA, 'ai_out', step))) {
  let items;
  try {
    const parsed = readJson(file);
    items = Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    problems.push(`${file}: ${err.message}`);
    continue;
  }
  // Outputs follow input order, so a mistyped post_id can be recovered from its position.
  const inputs = readJson(join(DATA, 'inputs', step, basename(file)), []);
  for (const [index, item] of items.entries()) {
    if (item && !postById.has(item.post_id)) {
      const atIndex = step === 'cards' ? inputs[index]?.post_id : inputs[index]?.post?.post_id;
      if (atIndex && !done.has(atIndex) && String(item.post_id).slice(0, 3) === atIndex.slice(0, 3)) {
        problems.push(`${file}: repaired post_id ${item.post_id} → ${atIndex} (same position in the input)`);
        item.post_id = atIndex;
        fixes.post_ids_by_position = (fixes.post_ids_by_position ?? 0) + 1;
      }
    }
    if (!item || !postById.has(item.post_id)) {
      problems.push(`${file}: unknown post_id ${item?.post_id}`);
      continue;
    }
    const issue = step === 'cards' ? checkCard(item) : checkGroups(item);
    if (issue) {
      problems.push(`${item.post_id}: ${issue}`);
      continue;
    }
    writeJson(join(DATA, step, `${item.post_id}.json`), item);
    done.add(item.post_id);
    written += 1;
  }
}

const missing = [...expected].filter((id) => !done.has(id));
console.log(`ingest ${step}: ${written} written, ${problems.length} rejected, ${missing.length} of ${expected.size} expected posts still missing`);
console.log('fixes:', fixes);
problems.slice(0, 20).forEach((p) => console.log(`  rejected: ${p}`));
if (missing.length) console.log(`  missing: ${missing.slice(0, 30).join(', ')}${missing.length > 30 ? ' …' : ''}`);
