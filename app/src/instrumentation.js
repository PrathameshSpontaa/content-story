// Runs once when the Next.js server starts (Next.js "instrumentation"). On a single-service setup
// the web service also runs the background worker, as a child process of the web server:
// `node scripts/worker.js`, the same thing the separate worker service in render.yaml runs. That is
// what picks up the refresh queued when someone follows a creator, the scheduled collection, alerts
// and digests. Without it nothing is ever collected.
//
// A child process rather than an import: the job layer loads the pipeline with dynamic imports
// that the Next.js bundler cannot follow, and a crash in the pipeline must not take the web server
// down. The child inherits the web service's environment (DATABASE_URL, APIFY_TOKEN, GEMINI_API_KEY,
// caps), and is restarted if it exits.
//
// WORKER_IN_WEB turns it on or off: unset means on in production and off in development (the
// development database is often the live one, and `next dev` restarts often). Set it to "false" on
// the web service once a separate worker service runs, so the queue is not worked twice; pg-boss
// would cope, but the second process is wasted.

const OFF = new Set(['0', 'false', 'no', 'off']);
const ON = new Set(['1', 'true', 'yes', 'on']);
const RESTART_MS = 30_000;
const MAX_RESTART_MS = 10 * 60_000;

function wanted() {
  const flag = String(process.env.WORKER_IN_WEB ?? '').trim().toLowerCase();
  if (OFF.has(flag)) return false;
  if (ON.has(flag)) return true;
  return process.env.NODE_ENV === 'production';
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || !wanted()) return;
  // One worker per web server process, however many times register() is called.
  if (globalThis.__contentStoryWorker) return;
  globalThis.__contentStoryWorker = { child: null, stopping: false };

  const [{ spawn }, { existsSync }, { resolve }] = await Promise.all([import('node:child_process'), import('node:fs'), import('node:path')]);
  const script = resolve(process.cwd(), 'scripts', 'worker.js');
  if (!existsSync(script)) {
    console.error(`[web] WORKER_IN_WEB: ${script} does not exist, so the worker was not started. Run the web service from the app directory.`);
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error('[web] WORKER_IN_WEB: DATABASE_URL is not set, so the worker was not started.');
    return;
  }

  const state = globalThis.__contentStoryWorker;
  let delay = RESTART_MS;
  const start = () => {
    if (state.stopping) return;
    const startedAt = Date.now();
    const child = spawn(process.execPath, [script], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
    state.child = child;
    console.log(`[web] worker started in this service (pid ${child.pid}); set WORKER_IN_WEB=false once a separate worker service runs`);
    child.on('exit', (code, signal) => {
      state.child = null;
      if (state.stopping) return;
      // A worker that ran for a while gets a quick restart; one that keeps dying backs off.
      delay = Date.now() - startedAt > 5 * 60_000 ? RESTART_MS : Math.min(delay * 2, MAX_RESTART_MS);
      console.error(`[web] worker exited (${signal ?? `code ${code}`}); starting it again in ${Math.round(delay / 1000)}s`);
      setTimeout(start, delay).unref?.();
    });
    child.on('error', (err) => console.error(`[web] worker could not start: ${err.message}`));
  };

  const stop = (signal) => {
    state.stopping = true;
    if (state.child) state.child.kill(signal);
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop(signal));
  process.once('exit', () => stop('SIGTERM'));
  start();
}
