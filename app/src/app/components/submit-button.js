'use client';

import { useFormStatus } from 'react-dom';

// A form's submit button that shows it's working while the server action runs.
export default function SubmitButton({ children, pendingLabel, className = 'btn primary', disabled = false, title }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending || disabled} title={title} aria-busy={pending}>
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
