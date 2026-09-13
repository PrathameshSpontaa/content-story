// Payment webhooks: POST /api/webhooks/razorpay (and /api/webhooks/fake outside production).
// The raw body is read as text because signatures are computed over the exact bytes sent.
import { handleWebhook } from '../../../../../lib/billing.js';
import { getPaymentProvider } from '../../../../../lib/payments/index.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request, { params }) {
  const { provider: name } = await params;
  if (name === 'fake' && process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  let provider;
  try {
    provider = getPaymentProvider(name);
  } catch {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  const rawBody = await request.text();
  const headers = Object.fromEntries([...request.headers].map(([key, value]) => [key.toLowerCase(), value]));
  const { status, result } = await handleWebhook(provider, rawBody, headers);
  return Response.json({ result }, { status });
}
