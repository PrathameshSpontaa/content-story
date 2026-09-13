// Billing talks to payment providers only through this interface, so moving from the fake
// provider to Razorpay (or adding another) never touches credits or subscription logic.
//
// Provider
//   name
//   createPlan({ planId, name, pricePaise })                    → { providerPlanId }
//   createSubscription({ workspaceId, providerPlanId, planId }) → { providerSubscriptionId, checkout }
//   createTopupOrder({ workspaceId, amountPaise, credits })     → { providerOrderId, checkout }
//   verifyWebhook(rawBody, headers)                             → boolean
//   parseWebhook(rawBody, headers)                              → BillingEvent | null
//
// BillingEvent
//   { provider, eventId, type, workspaceId, planId, providerSubscriptionId, providerPaymentId,
//     providerOrderId, amountPaise, credits, periodStart, periodEnd }
//   type: 'subscription.activated' | 'subscription.charged' | 'subscription.past_due'
//       | 'subscription.cancelled' | 'topup.paid' | 'payment.failed'
import { fakeProvider } from './fake.js';
import { razorpayProvider } from './razorpay.js';

export function getPaymentProvider(name = process.env.PAYMENT_PROVIDER || 'fake') {
  if (name === 'fake') return fakeProvider;
  if (name === 'razorpay') return razorpayProvider();
  throw new Error(`Unknown payment provider "${name}"`);
}
