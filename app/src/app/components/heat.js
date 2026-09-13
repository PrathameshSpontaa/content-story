import { HEAT_HELP } from '../../../lib/format.js';

export const heatLabel = (heat) => (heat >= 55 ? 'Hot' : heat >= 30 ? 'Rising' : 'Steady');

// Heat as five bars and a word; the number stays in the tooltip.
export default function Heat({ value }) {
  const heat = Number(value) || 0;
  const level = Math.max(1, Math.min(5, Math.ceil(heat / 14)));
  return (
    <span className={`heat h${level}`} title={`Heat ${heat} of 100. ${HEAT_HELP}`}>
      <span className="heat-bars" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="heat-word">{heatLabel(heat)}</span>
    </span>
  );
}
