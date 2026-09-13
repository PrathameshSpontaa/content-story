// Subscriptions, top-ups and payment webhooks. Credits are granted only by verified payment
// events, exactly once per paid invoice or top-up, however many times a webhook is delivered.
import { createHash } from 'node:crypto';
import { pool, tx } from './db.js';
import { addCredits } from './credits.js';
import { getPaymentProvider } from './payments/index.js';

// Starts a plan subscription. Credits arrive with the first paid invoice, not before.
export async function startSubscription(workspaceId, planId, provider = getPaymentProvider()) {
  const { rows } = await pool.query('select * from plans where id = $1 and active', [planId]);
  const plan = rows[0];
  if (!plan) throw new Error(`Plan "${planId}" not found`);

  let providerPlanId = plan.provider_plan_ids?.[provider.name];
  if (!providerPlanId) {
    ({ providerPlanId } = await provider.createPlan({ planId, name: plan.name, pricePaise: Number(plan.price_paise) }));
    await pool.query(`update plans set provider_plan_ids = provider_plan_ids || jsonb_build_object($2::text, $3::text) where id = $1`, [
      planId,
      provider.name,
      providerPlanId,
    ]);
  }

  const { providerSubscriptionId, checkout } = await provider.createSubscription({ workspaceId, providerPlanId, planId });
  await pool.query(`insert into subscriptions (workspace_id, plan_id, provider, provider_subscription_id) values ($1, $2, $3, $4)`, [
    workspaceId,
    planId,
    provider.name,
    providerSubscriptionId,
  ]);
  return { providerSubscriptionId, checkout };
}

// Starts a one-time credit top-up. Credits arrive when the payment is captured.
export async function startTopup(workspaceId, credits, provider = getPaymentProvider()) {
  const paisePerCredit = Number(process.env.TOPUP_PAISE_PER_CREDIT || 100);
  const amountPaise = Math.round(credits * paisePerCredit);
  return { amountPaise, ...(await provider.createTopupOrder({ workspaceId, amountPaise, credits })) };
}

// Verifies, records once, then applies a webhook. Returns the HTTP status to send back;
// a 500 makes the provider retry, and a retry of an already applied event is a no-op.
export async function handleWebhook(provider, rawBody, headers) {
  if (!provider.verifyWebhook(rawBody, headers)) return { status: 401, result: 'invalid signature' };

  const payload = JSON.parse(rawBody);
  const event = provider.parseWebhook(rawBody, headers);
  const eventId = event?.eventId ?? headers['x-razorpay-event-id'] ?? createHash('sha256').update(rawBody).digest('hex');

  const { rows } = await pool.query(
    `insert into webhook_events (provider, event_id, type, payload) values ($1, $2, $3, $4)
     on conflict (provider, event_id) do update set received_at = now()
     returning processed_at`,
    [provider.name, eventId, payload.event ?? event?.type ?? 'unknown', payload],
  );
  if (rows[0].processed_at) return { status: 200, result: 'duplicate' };

  try {
    if (event) await applyEvent(event);
    await pool.query(`update webhook_events set processed_at = now(), error = null where provider = $1 and event_id = $2`, [provider.name, eventId]);
    return { status: 200, result: event ? 'processed' : 'ignored' };
  } catch (err) {
    await pool.query(`update webhook_events set error = $3 where provider = $1 and event_id = $2`, [provider.name, eventId, String(err.message).slice(0, 500)]);
    return { status: 500, result: 'failed', error: err.message };
  }
}

async function setSubscriptionStatus(event, status) {
  await pool.query(
    `update subscriptions
        set status = $1,
            current_period_start = coalesce($2::timestamptz, current_period_start),
            current_period_end = coalesce($3::timestamptz, current_period_end)
      where provider = $4 and provider_subscription_id = $5`,
    [status, event.periodStart, event.periodEnd, event.provider, event.providerSubscriptionId],
  );
}

async function applyEvent(event) {
  switch (event.type) {
    case 'subscription.activated':
      return setSubscriptionStatus(event, 'active');
    case 'subscription.past_due':
      return setSubscriptionStatus(event, 'past_due');
    case 'subscription.cancelled':
      return setSubscriptionStatus(event, 'cancelled');

    case 'subscription.charged': {
      const subscription = await tx(async (client) => {
        const { rows } = await client.query(
          `select s.id, s.workspace_id, p.credits_per_period, p.price_paise
             from subscriptions s join plans p on p.id = s.plan_id
            where s.provider = $1 and s.provider_subscription_id = $2
            for update of s`,
          [event.provider, event.providerSubscriptionId],
        );
        const row = rows[0];
        if (!row) throw new Error(`Unknown subscription ${event.providerSubscriptionId}`);
        await client.query(
          `update subscriptions
              set status = 'active',
                  current_period_start = coalesce($1::timestamptz, current_period_start),
                  current_period_end = coalesce($2::timestamptz, current_period_end)
            where id = $3`,
          [event.periodStart, event.periodEnd, row.id],
        );
        await client.query(
          `insert into payments (workspace_id, subscription_id, provider, provider_payment_id, kind, status, amount_paise, credits)
           values ($1, $2, $3, $4, 'subscription', 'captured', $5, $6)
           on conflict (provider, provider_payment_id) do nothing`,
          [row.workspace_id, row.id, event.provider, event.providerPaymentId, event.amountPaise ?? row.price_paise, row.credits_per_period],
        );
        return row;
      });
      return addCredits(subscription.workspace_id, subscription.credits_per_period, {
        kind: 'grant',
        reference: `payment:${event.providerPaymentId}`,
        idempotencyKey: `${event.provider}:grant:${event.providerPaymentId}`,
        note: 'Plan credits for a paid invoice',
      });
    }

    case 'topup.paid': {
      if (!event.workspaceId || !(event.credits > 0)) throw new Error('Top-up event is missing its workspace or credits');
      await pool.query(
        `insert into payments (workspace_id, provider, provider_payment_id, provider_order_id, kind, status, amount_paise, credits)
         values ($1, $2, $3, $4, 'topup', 'captured', $5, $6)
         on conflict (provider, provider_payment_id) do nothing`,
        [event.workspaceId, event.provider, event.providerPaymentId, event.providerOrderId, event.amountPaise, event.credits],
      );
      return addCredits(event.workspaceId, event.credits, {
        kind: 'purchase',
        reference: `payment:${event.providerPaymentId}`,
        idempotencyKey: `${event.provider}:topup:${event.providerPaymentId}`,
        note: 'Credit top-up',
      });
    }

    case 'payment.failed':
      if (!event.workspaceId || !event.providerPaymentId) return;
      await pool.query(
        `insert into payments (workspace_id, provider, provider_payment_id, provider_order_id, kind, status, amount_paise, credits)
         values ($1, $2, $3, $4, $5, 'failed', coalesce($6, 0), 0)
         on conflict (provider, provider_payment_id) do update set status = 'failed'`,
        [event.workspaceId, event.provider, event.providerPaymentId, event.providerOrderId, event.providerSubscriptionId ? 'subscription' : 'topup', event.amountPaise],
      );
      return;

    default:
      return;
  }
}
