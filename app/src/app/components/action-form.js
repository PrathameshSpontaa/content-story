'use client';

import { startTransition, useActionState, useEffect, useRef } from 'react';

// Posts a form to a server action and shows the message it returns ({ ok, message }).
// Submits through a transition instead of <form action>, so an error keeps what was typed.
export default function ActionForm({ action, submitLabel, pendingLabel = 'Saving…', className = '', variant = 'primary', resetOnSuccess = true, children }) {
  const [state, dispatch, pending] = useActionState(action, null);
  const formRef = useRef(null);

  useEffect(() => {
    if (state?.ok && resetOnSuccess) formRef.current?.reset();
  }, [state, resetOnSuccess]);

  const onSubmit = (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => dispatch(data));
  };

  return (
    <form ref={formRef} onSubmit={onSubmit} className={`form ${className}`}>
      {children}
      <div className="form-foot">
        <button type="submit" className={`btn ${variant}`} disabled={pending}>
          {pending ? pendingLabel : submitLabel}
        </button>
      </div>
      {state?.message ? (
        <p role="status" className={`notice ${state.ok ? 'ok' : 'err'}`}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
