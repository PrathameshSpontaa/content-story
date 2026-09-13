// Replaces each narrative's reactions with the re-mapped ones from data/ai_out/reactions/,
// after checking group IDs, angle indexes and relations. The first mapping is kept as reactions_v1.
// Usage: node scripts/merge_reactions.mjs
import { join } from 'node:path';
import { DATA, listJson, readJson, writeJson } from './lib.mjs';

const RELATIONS = new Set(['agrees', 'disagrees', 'asks']);

for (const file of listJson(join(DATA, 'ai_out', 'reactions'))) {
  const out = readJson(file);
  const narrativeFile = join(DATA, 'narrative', `${out.story_id}.json`);
  const narrative = readJson(narrativeFile, null);
  const input = readJson(join(DATA, 'inputs', 'reactions', `${out.story_id}.json`), null);
  if (!narrative || !input) {
    console.log(`${out.story_id}: missing narrative or reaction input, skipped`);
    continue;
  }

  const groupIds = new Set(input.comment_groups.map((g) => g.group_id));
  const seen = new Set();
  const kept = [];
  let rejected = 0;
  for (const r of out.reactions ?? []) {
    const isNull = r.angle_index === null;
    const validAngle = isNull || (Number.isInteger(r.angle_index) && r.angle_index >= 0 && r.angle_index < narrative.angles.length);
    const key = `${r.group_id}|${r.angle_index}`;
    if (!groupIds.has(r.group_id) || !validAngle || (!isNull && !RELATIONS.has(r.relation)) || seen.has(key)) {
      rejected += 1;
      continue;
    }
    seen.add(key);
    kept.push({ group_id: r.group_id, angle_index: r.angle_index, relation: isNull ? null : r.relation });
  }

  const covered = new Set(kept.map((r) => r.group_id));
  const missing = [...groupIds].filter((id) => !covered.has(id));
  narrative.reactions_v1 ??= narrative.reactions;
  narrative.reactions = kept;
  writeJson(narrativeFile, narrative);

  const perAngle = narrative.angles
    .map((a, i) => {
      const rel = kept.filter((r) => r.angle_index === i);
      const count = (k) => rel.filter((r) => r.relation === k).length;
      return `"${a.title}" +${count('agrees')}/-${count('disagrees')}/?${count('asks')}`;
    })
    .join(' · ');
  console.log(`${out.story_id}: ${kept.length} reactions, ${rejected} rejected, ${missing.length} groups unmapped`);
  console.log(`  groups per angle (agree/disagree/ask): ${perAngle}`);
}
