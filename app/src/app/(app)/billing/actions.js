'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { PaymentError, checkoutMode, confirmCheckoutTopup, recordTopupPaid, startTopup } from '../../../../lib/billing.js';
import { getPaymentProvider } from '../../../../lib/payments/index.js';
import { TOPUP_PACKS } from '../../../../lib/pricing.js';
import { requireSession } from '../../../../lib/session.js';

const paisePerCredit = () => Number(process.env.TOPUP_PAISE_PER_CREDIT || 100);

// Creates the order on the server. In development without Razorpay, the payment is simulated.
export async function beginTopupAction(credits) {
  const session = await requireSession();
  const pack = Number(credits);
  if (!TOPUP_PACKS.includes(pack)) return { error: 'Choose one of the credit packs.' };
  const mode = checkoutMode();
  if (!mode.provider) return { error: 'Payments aren’t switched on for this site yet.' };

  try {
    if (mode.provider === 'fake') {
      await recordTopupPaid({
        provider: 'fake',
        workspaceId: session.workspace.id,
        providerPaymentId: `fake_pay_${randomUUID()}`,
        providerOrderId: `fake_order_${randomUUID()}`,
        amountPaise: pack * paisePerCredit(),
        credits: pack,
      });
      revalidatePath('/billing');
      return { done: true, message: `Simulated payment: ${pack.toLocaleString('en-IN')} credits added.` };
    }
    const { amountPaise, providerOrderId, checkout } = await startTopup(session.workspace.id, pack, getPaymentProvider('razorpay'));
    return { key: checkout.key, orderId: providerOrderId, amount: amountPaise, currency: 'INR' };
  } catch (err) {
    console.error(err);
    return { error: 'We couldn’t start the payment. Nothing was charged; try again in a minute.' };
  }
}

export async function confirmTopupAction({ orderId, paymentId, signature }) {
  const session = await requireSession();
  try {
    const result = await confirmCheckoutTopup(getPaymentProvider('razorpay'), {
      workspaceId: session.workspace.id,
      orderId: String(orderId ?? ''),
      paymentId: String(paymentId ?? ''),
      signature: String(signature ?? ''),
    });
    revalidatePath('/billing');
    return { message: result.applied ? 'Payment received. Your credits are ready to use.' : 'Payment received. These credits were already added.' };
  } catch (err) {
    if (err instanceof PaymentError) return { error: err.message };
    console.error(err);
    return { error: `We couldn’t confirm payment ${paymentId}. If you were charged, contact support with that payment ID.` };
  }
}
