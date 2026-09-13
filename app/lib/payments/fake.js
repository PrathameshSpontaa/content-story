// Development payment provider: behaves like a real one (IDs, signed webhooks) without money.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const SECRET = 'fake-webhook-secret';
const sign = (body) => createHmac('sha256', SECRET).update(body).digest('hex');

export const fakeProvider = {
  name: 'fake',

  async createPlan({ planId }) {
    return { providerPlanId: `fake_plan_${planId}` };
  },

  async createSubscription({ workspaceId, planId }) {
    const id = `fake_sub_${randomUUID()}`;
    return { providerSubscriptionId: id, checkout: { provider: 'fake', subscriptionId: id, workspaceId, planId } };
  },

  async createTopupOrder({ workspaceId, amountPaise, credits }) {
    const id = `fake_order_${randomUUID()}`;
    return { providerOrderId: id, checkout: { provider: 'fake', orderId: id, workspaceId, amountPaise, credits } };
  },

  verifyWebhook(rawBody, headers) {
    const given = Buffer.from(String(headers['x-fake-signature'] ?? ''));
    const expected = Buffer.from(sign(rawBody));
    return given.length === expected.length && timingSafeEqual(given, expected);
  },

  // Fake webhooks already carry a BillingEvent.
  parseWebhook(rawBody) {
    return JSON.parse(rawBody);
  },

  // Builds a signed webhook the way a provider would deliver it.
  simulate(event) {
    const body = JSON.stringify({ provider: 'fake', eventId: `fake_evt_${randomUUID()}`, ...event });
    return { body, headers: { 'x-fake-signature': sign(body) } };
  },
};
