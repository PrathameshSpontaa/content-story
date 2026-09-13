// Razorpay behind the payment provider interface. Test and live mode differ only by keys.
import { createHmac, timingSafeEqual } from 'node:crypto';
import Razorpay from 'razorpay';
import { requireEnv } from '../env.js';

const hmac = (secret, message) => createHmac('sha256', secret).update(message).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const fromUnix = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null);

// Checkout success callbacks are only trusted after these server-side checks.
export function verifySubscriptionPayment({ paymentId, subscriptionId, signature }) {
  return safeEqual(hmac(requireEnv('RAZORPAY_KEY_SECRET'), `${paymentId}|${subscriptionId}`), signature);
}

export function verifyOrderPayment({ orderId, paymentId, signature }) {
  return safeEqual(hmac(requireEnv('RAZORPAY_KEY_SECRET'), `${orderId}|${paymentId}`), signature);
}

// Razorpay event → provider-neutral BillingEvent type. Anything else is ignored.
const EVENT_TYPES = {
  'subscription.authenticated': 'subscription.activated',
  'subscription.activated': 'subscription.activated',
  'subscription.charged': 'subscription.charged',
  'subscription.pending': 'subscription.past_due',
  'subscription.halted': 'subscription.past_due',
  'subscription.cancelled': 'subscription.cancelled',
  'subscription.completed': 'subscription.cancelled',
  'order.paid': 'topup.paid',
  'payment.failed': 'payment.failed',
};

export function razorpayProvider() {
  const client = new Razorpay({ key_id: requireEnv('RAZORPAY_KEY_ID'), key_secret: requireEnv('RAZORPAY_KEY_SECRET') });

  return {
    name: 'razorpay',

    async createPlan({ planId, name, pricePaise }) {
      const plan = await client.plans.create({
        period: 'monthly',
        interval: 1,
        item: { name, amount: pricePaise, currency: 'INR', description: `${name} plan` },
        notes: { plan_id: planId },
      });
      return { providerPlanId: plan.id };
    },

    async createSubscription({ workspaceId, providerPlanId, planId }) {
      const subscription = await client.subscriptions.create({
        plan_id: providerPlanId,
        total_count: 120,
        quantity: 1,
        customer_notify: 1,
        notes: { workspace_id: workspaceId, plan_id: planId },
      });
      return { providerSubscriptionId: subscription.id, checkout: { key: process.env.RAZORPAY_KEY_ID, subscription_id: subscription.id } };
    },

    async createTopupOrder({ workspaceId, amountPaise, credits }) {
      const order = await client.orders.create({
        amount: amountPaise,
        currency: 'INR',
        receipt: `topup_${Date.now()}`,
        notes: { workspace_id: workspaceId, credits: String(credits) },
      });
      return { providerOrderId: order.id, checkout: { key: process.env.RAZORPAY_KEY_ID, order_id: order.id, amount: amountPaise, currency: 'INR' } };
    },

    fetchOrder(orderId) {
      return client.orders.fetch(orderId);
    },

    verifyOrderPayment,

    // X-Razorpay-Signature is HMAC-SHA256 of the raw body, keyed with the webhook secret
    // set in the Dashboard (not the API key secret).
    verifyWebhook(rawBody, headers) {
      const signature = headers['x-razorpay-signature'];
      return Boolean(signature) && safeEqual(hmac(requireEnv('RAZORPAY_WEBHOOK_SECRET'), rawBody), signature);
    },

    parseWebhook(rawBody, headers) {
      const body = JSON.parse(rawBody);
      const type = EVENT_TYPES[body.event];
      if (!type) return null;
      const subscription = body.payload?.subscription?.entity;
      const payment = body.payload?.payment?.entity;
      const order = body.payload?.order?.entity;
      const notes = { ...(order?.notes ?? {}), ...(payment?.notes ?? {}), ...(subscription?.notes ?? {}) };
      const event = {
        provider: 'razorpay',
        eventId: headers['x-razorpay-event-id'] ?? `${body.event}:${payment?.id ?? subscription?.id ?? order?.id}`,
        type,
        workspaceId: notes.workspace_id ?? null,
        planId: notes.plan_id ?? null,
        providerSubscriptionId: subscription?.id ?? payment?.subscription_id ?? null,
        providerPaymentId: payment?.id ?? null,
        providerOrderId: order?.id ?? payment?.order_id ?? null,
        amountPaise: payment?.amount ?? order?.amount ?? null,
        credits: notes.credits ? Number(notes.credits) : null,
        periodStart: fromUnix(subscription?.current_start),
        periodEnd: fromUnix(subscription?.current_end),
      };
      // Subscription invoices also raise order.paid; only our top-up orders carry a credits note.
      if (type === 'topup.paid' && !event.credits) return null;
      return event;
    },
  };
}
