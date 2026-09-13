// Runs one AI step through Gemini, using the same prompts the Claude run used.
// Usage:
//   node scripts/run_gemini.mjs models              list models this key can use
//   node scripts/run_gemini.mjs <step> [parallel]   step: cards | groups | grouping | builder | writer | lens | edit
// Set DATA_DIR / OUT_DIR to keep a Gemini run beside the Claude one.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DATA, ROOT, listJson, readJson, writeJson } from './lib.mjs';
import { MODELS, generateJson, listModels } from './gemini.mjs';

const [step, parallelArg] = process.argv.slice(2);
const parallel = Number(parallelArg) || 4;

const each = (dir, outDir) => ({ inputs: () => listJson(join(DATA, 'inputs', dir)), out: (f) => join(DATA, outDir, basename(f)) });
const STEPS = {
  cards: { prompt: '01_story_card.md', tier: 'cheap', batch: true, ...each('cards', 'ai_out/cards') },
  groups: { prompt: '02_comment_groups.md', tier: 'cheap', batch: true, ...each('groups', 'ai_out/groups') },
  grouping: { prompt: '03_story_grouping.md', tier: 'strong', inputs: () => [join(DATA, 'inputs', 'grouping.json')], out: () => join(DATA, 'stories.json') },
  builder: { prompt: '04_narrative_builder.md', tier: 'strong', ...each('builder', 'narrative') },
  writer: { prompt: '05_story_writer.md', tier: 'strong', ...each('writer', 'written') },
  lens: { prompt: '06_platform_lens.md', tier: 'strong', ...each('lens', 'lens') },
  edit: { prompt: '07_feed_editor.md', tier: 'strong', ...each('edit', 'edit') },
};

const userMessage = (input, batch) =>
  batch
    ? `The input is a JSON array of ${input.length} items. Apply the instructions to each item and return a JSON array with exactly ${input.length} output objects, in the same order.\n\nInput:\n${JSON.stringify(input)}`
    : `Input:\n${JSON.stringify(input)}\n\nReturn only the JSON described under Output.`;

if (step === 'models') {
  const names = await listModels();
  console.log(names.join('\n'));
  console.log(`\ncheap tier: ${MODELS.cheap()} · strong tier: ${MODELS.strong()}`);
  for (const m of [MODELS.cheap(), MODELS.strong()]) if (!names.includes(m)) console.log(`warning: ${m} is not available to this key`);
} else if (!STEPS[step]) {
  console.log(`Usage: node scripts/run_gemini.mjs <models|${Object.keys(STEPS).join('|')}> [parallel]`);
  process.exitCode = 1;
} else {
  const config = STEPS[step];
  const system = readFileSync(join(ROOT, 'prompts', config.prompt), 'utf8');
  const model = MODELS[config.tier]();
  const files = config.inputs();
  const queue = [...files];
  let done = 0;
  let failed = 0;
  let skipped = 0;
  const started = Date.now();

  const worker = async () => {
    while (queue.length) {
      const file = queue.shift();
      const label = basename(file, '.json');
      // Re-runs only redo what's missing; FORCE=1 redoes everything.
      if (!process.env.FORCE && step !== 'grouping' && existsSync(config.out(file))) {
        skipped += 1;
        continue;
      }
      try {
        const input = readJson(file);
        const output = await generateJson({ model, system, user: userMessage(input, config.batch), step, label });
        writeJson(config.out(file), output);
        done += 1;
        console.log(`[${step}] ${label} done`);
      } catch (err) {
        failed += 1;
        console.log(`[${step}] ${label} failed: ${err.message.slice(0, 240)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, files.length) }, worker));

  const cost = readJson(join(DATA, 'ai_cost', `${step}.json`), []).reduce((sum, r) => sum + (r.usd ?? 0), 0);
  console.log(`${step}: ${done} done, ${failed} failed, ${skipped} already done · ${model} · ${Math.round((Date.now() - started) / 1000)}s · $${cost.toFixed(4)} logged for this step`);
  process.exitCode = failed ? 1 : 0;
}
