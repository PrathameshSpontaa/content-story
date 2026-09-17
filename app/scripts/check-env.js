// Prints which environment variables are set for a given service role and exits 1 if a
// required one is missing. Never prints a value.
//
// Usage:  node scripts/check-env.js [web|worker|cron|all]      (default: web)
//         npm run check:env -- worker
//
// Locally the names come from .env.local (see lib/env.js); on Render from the service's
// environment group (see render.yaml). "default" is what the code uses when the variable is
// unset; render.yaml may set a different value in the environment group.
import { loadEnv } from '../lib/env.js';

loadEnv();

const ROLES = ['web', 'worker', 'cron'];
const role = (process.argv[2] ?? 'web').toLowerCase();
if (role !== 'all' && !ROLES.includes(role)) {
  console.error(`Unknown role "${role}". Use one of: ${ROLES.join(', ')}, all.`);
  process.exit(2);
}

// required: which roles cannot start without the variable.
// requiredIf: required only while a switch has a value (a list: while all of them do).
// optional: which roles read it if present. def: the default the code uses when unset.
const PIPELINE_REAL = { key: 'PIPELINE_PROVIDER', isNot: 'fake', unsetMeans: 'real', roles: ['worker'] };
const VARS = [
  // database
  { key: 'DATABASE_URL', required: ['web', 'worker', 'cron'], note: 'Render: fromDatabase' },
  { key: 'DATABASE_SSL', optional: ['web', 'worker', 'cron'], def: 'true', note: '"false" only for a local database' },
  { key: 'DATABASE_POOL_MAX', optional: ['web', 'worker'], def: '10' },

  // app identity
  { key: 'APP_URL', required: ['web', 'worker'], note: 'links in emails and invites; unset falls back to the production URL' },
  { key: 'ADMIN_EMAILS', required: ['web', 'worker'], note: 'comma-separated; /admin access and ops emails' },

  // sign-in (Clerk). Without both, a production web service answers 503 on app pages.
  { key: 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', required: ['web'], note: 'Clerk dashboard > API keys' },
  { key: 'CLERK_SECRET_KEY', required: ['web'], note: 'Clerk dashboard > API keys' },

  // payments (Razorpay). Keys are required only when PAYMENT_PROVIDER=razorpay.
  { key: 'PAYMENT_PROVIDER', optional: ['web'], def: 'fake', note: 'fake | razorpay' },
  { key: 'RAZORPAY_KEY_ID', requiredIf: { key: 'PAYMENT_PROVIDER', is: 'razorpay', unsetMeans: 'fake', roles: ['web'] } },
  { key: 'RAZORPAY_KEY_SECRET', requiredIf: { key: 'PAYMENT_PROVIDER', is: 'razorpay', unsetMeans: 'fake', roles: ['web'] } },
  { key: 'RAZORPAY_WEBHOOK_SECRET', requiredIf: { key: 'PAYMENT_PROVIDER', is: 'razorpay', unsetMeans: 'fake', roles: ['web'] }, note: 'Dashboard > Webhooks, not the API secret' },
  { key: 'TOPUP_PAISE_PER_CREDIT', optional: ['web'], def: '100' },
  { key: 'CREDIT_INR', optional: ['web'], def: '1', note: 'rupee value of one credit (/admin/runs)' },
  { key: 'USD_INR', optional: ['web', 'worker'], def: '84', note: 'rupees per dollar (/admin/runs and npm run margin)' },

  // collection and AI (worker). PIPELINE_PROVIDER=fake needs none of the paid keys.
  { key: 'PIPELINE_PROVIDER', optional: ['worker'], def: 'real', note: 'fake | real; fake needs local dryrun/data' },
  { key: 'APIFY_TOKEN', requiredIf: { key: 'PIPELINE_PROVIDER', isNot: 'fake', unsetMeans: 'real', roles: ['worker'] }, note: 'Apify console > Settings > Integrations' },
  { key: 'APIFY_DAILY_CAP_USD', optional: ['worker'], def: '10', note: 'render.yaml: 3 staging, 10 production' },
  { key: 'AI_PROVIDER', optional: ['worker'], def: 'openai', note: 'openai | gemini' },
  { key: 'OPENAI_API_KEY', requiredIf: [PIPELINE_REAL, { key: 'AI_PROVIDER', is: 'openai', unsetMeans: 'openai', roles: ['worker'] }], note: 'platform.openai.com > API keys, in a project with credits' },
  { key: 'OPENAI_CHEAP_MODEL', optional: ['worker'], def: 'gpt-5.6-luna', note: 'cards and comment groups' },
  { key: 'OPENAI_STRONG_MODEL', optional: ['worker'], def: 'gpt-5.4-mini', note: 'grouping, narrative, writing, AI editor' },
  { key: 'OPENAI_CHEAP_EFFORT', optional: ['worker'], def: 'low', note: 'reasoning effort: none | low | medium | high' },
  { key: 'OPENAI_STRONG_EFFORT', optional: ['worker'], def: 'medium' },
  { key: 'OPENAI_DAILY_CAP_USD', optional: ['worker'], def: '5', note: 'render.yaml: 2 staging, 5 production' },
  { key: 'GEMINI_API_KEY', requiredIf: [PIPELINE_REAL, { key: 'AI_PROVIDER', is: 'gemini', unsetMeans: 'openai', roles: ['worker'] }], note: 'Google AI Studio, paid project' },
  { key: 'GEMINI_CHEAP_MODEL', optional: ['worker'], def: 'gemini-3.5-flash-lite' },
  { key: 'GEMINI_STRONG_MODEL', optional: ['worker'], def: 'gemini-3.8-flash' },
  { key: 'GEMINI_DAILY_CAP_USD', optional: ['worker'], def: '5' },
  { key: 'COLLECT_MIN_HOURS', optional: ['worker'], def: '', note: 'leave unset on Render: the admin settings interval decides; set only to override for a manual run' },
  { key: 'COMMENTS_PER_RUN', optional: ['worker'], def: '1500', note: 'comment budget per collection run' },
  { key: 'KEYWORD_MIN_HOURS', optional: ['worker'], def: '20', note: 'a brand or topic is searched at most once in this many hours' },
  { key: 'FINDER_MODEL', optional: ['web'], def: 'the strong model', note: 'model that finds creators’ channels with web search' },
  { key: 'FINDER_DAILY_LIMIT', optional: ['web'], def: '60', note: 'paid channel lookups per workspace per day' },
  { key: 'STORY_DORMANT_DAYS', optional: ['worker'], def: '4' },
  { key: 'DRYRUN_DATA', optional: ['worker'], def: '', note: 'local only, with PIPELINE_PROVIDER=fake' },

  // email (Resend). Without RESEND_API_KEY emails are logged, not sent.
  { key: 'RESEND_API_KEY', optional: ['web', 'worker'], def: '', note: 'unset = emails recorded, not sent' },
  { key: 'EMAIL_FROM', requiredIf: { key: 'RESEND_API_KEY', isSet: true, roles: ['web', 'worker'] }, note: 'domain verified in Resend' },

  // public contact page
  { key: 'SUPPORT_EMAIL', optional: ['web'], def: '' },
  { key: 'SUPPORT_PHONE', optional: ['web'], def: '' },
  { key: 'BUSINESS_ADDRESS', optional: ['web'], def: '' },
];

const isSet = (key) => (process.env[key] ?? '').trim() !== '';

function requirement(v, r) {
  if (v.required?.includes(r)) return 'required';
  const conditions = v.requiredIf ? [].concat(v.requiredIf) : [];
  if (conditions[0]?.roles.includes(r)) {
    const states = conditions.map((c) => {
      // An unset switch means its code default (PAYMENT_PROVIDER fake, PIPELINE_PROVIDER real, AI_PROVIDER openai).
      const value = (process.env[c.key] ?? '').trim() || c.unsetMeans || '';
      const active = c.isSet ? value !== '' : c.is ? value === c.is : value !== c.isNot;
      return { active, text: active ? `${c.key}${c.isSet ? ' set' : ` is ${value}`}` : `${c.key}${c.isSet ? ' unset' : c.is ? ` is not ${c.is}` : ` is ${value}`}` };
    });
    return states.every((s) => s.active)
      ? `required (${states.map((s) => s.text).join(', ')})`
      : `optional (${states.filter((s) => !s.active).map((s) => s.text).join(', ')})`;
  }
  if (v.optional?.includes(r)) return 'optional';
  return null;
}

const pad = (s, n) => String(s).padEnd(n);
let failed = false;

for (const r of role === 'all' ? ROLES : [role]) {
  const rows = VARS.map((v) => ({ v, req: requirement(v, r) }))
    .filter((x) => x.req)
    .map((x) => ({ ...x, when: x.req.startsWith('required') || !x.v.def ? x.req : `${x.req}, default ${x.v.def}` }));
  const keyWidth = Math.max(...rows.map((x) => x.v.key.length)) + 2;
  const whenWidth = Math.max(...rows.map((x) => x.when.length)) + 2;
  console.log(`\n${r.toUpperCase()}  (${rows.length} variables)\n${'─'.repeat(keyWidth + whenWidth + 30)}`);
  console.log(`${pad('VARIABLE', keyWidth)}${pad('STATUS', 10)}${pad('WHEN', whenWidth)}NOTES`);
  for (const section of ['required', 'optional']) {
    for (const { v, req, when } of rows) {
      if (!req.startsWith(section)) continue;
      const set = isSet(v.key);
      const status = set ? 'set' : section === 'required' ? 'MISSING' : 'unset';
      if (!set && section === 'required') failed = true;
      console.log(`${pad(v.key, keyWidth)}${pad(status, 10)}${pad(when, whenWidth)}${v.note ?? ''}`);
    }
  }
}

console.log('');
if (failed) {
  console.error(`Missing required variables for role "${role}". Add them to .env.local (local) or the Render environment group.`);
  process.exit(1);
}
console.log(`All required variables for role "${role}" are set.`);
