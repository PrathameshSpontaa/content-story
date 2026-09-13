'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

function loadCheckout() {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve(window.Razorpay);
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve(window.Razorpay);
    script.onerror = () => reject(new Error('Razorpay Checkout didn’t load. Check your connection and try again.'));
    document.body.appendChild(script);
  });
}

// Buy buttons for credit packs. The server creates the order; Razorpay Checkout takes the payment;
// the server verifies the signature and adds the credits.
export default function TopupPacks({ packs, beginTopup, confirmTopup, email, name, disabled }) {
  const router = useRouter();
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);

  async function buy(credits) {
    setBusy(credits);
    setMessage(null);
    try {
      const started = await beginTopup(credits);
      if (started.error) throw new Error(started.error);
      if (started.done) {
        setMessage({ ok: true, text: started.message });
        router.refresh();
        return;
      }
      const Razorpay = await loadCheckout();
      await new Promise((resolve) => {
        let failure = null;
        const checkout = new Razorpay({
          key: started.key,
          order_id: started.orderId,
          amount: started.amount,
          currency: started.currency,
          name: 'Content-Story',
          description: `${credits.toLocaleString('en-IN')} credits`,
          prefill: { email, name },
          theme: { color: '#141b24' },
          handler: async (response) => {
            const result = await confirmTopup({
              orderId: response.razorpay_order_id,
              paymentId: response.razorpay_payment_id,
              signature: response.razorpay_signature,
            });
            setMessage(result.error ? { ok: false, text: result.error } : { ok: true, text: result.message });
            router.refresh();
            resolve();
          },
          modal: {
            ondismiss: () => {
              setMessage({ ok: false, text: failure ?? 'Checkout closed before paying. No credits were added.' });
              resolve();
            },
          },
        });
        checkout.on('payment.failed', (response) => {
          failure = response.error?.description ? `Payment failed: ${response.error.description}` : 'The payment failed. No credits were added.';
        });
        checkout.open();
      });
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="packs-wrap">
      <div className="packs">
        {packs.map((pack) => (
          <div className="pack" key={pack.credits}>
            <b>{pack.credits.toLocaleString('en-IN')}</b>
            <span>credits</span>
            <em>{pack.price}</em>
            <button type="button" className="btn primary" disabled={disabled || busy !== null} onClick={() => buy(pack.credits)}>
              {busy === pack.credits ? 'Opening…' : 'Buy'}
            </button>
          </div>
        ))}
      </div>
      {message ? (
        <p role="status" className={`notice ${message.ok ? 'ok' : 'err'}`}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
