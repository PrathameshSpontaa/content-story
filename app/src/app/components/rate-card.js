'use client';

import Link from 'next/link';
import { useState } from 'react';
import { fmtNum } from '../../../lib/format.js';
import { fmtINR } from '../../../lib/pricing.js';

const REPORT_TYPICAL = 500; // credits, mid-way through the 300–800 quote range
const TOPUP_STEP = 5000;
const LIMITS = { creators: [1, 100], brands: [0, 40], reports: [0, 12] };

// The plans as a rate card, with a calculator underneath that stamps the column that fits.
export default function RateCard({ plans, trial, prices, startHref, planHref }) {
  const [counts, setCounts] = useState({ creators: 12, brands: 2, reports: 1 });
  const perCreator = prices.track_creator_day?.credits ?? 20;
  const perBrand = prices.track_keyword_day?.credits ?? 40;
  const need = counts.creators * perCreator * 30 + counts.brands * perBrand * 30 + counts.reports * REPORT_TYPICAL;
  const fit = plans.find((p) => p.credits_per_period >= need && p.max_tracked_creators >= counts.creators && p.max_tracked_keywords >= counts.brands) ?? null;
  const largest = plans[plans.length - 1];
  const fitId = fit?.id ?? largest?.id;
  const topup = fit || !largest ? 0 : Math.ceil(Math.max(0, need - largest.credits_per_period) / TOPUP_STEP) * TOPUP_STEP;
  const set = (key, value) => {
    const [min, max] = LIMITS[key];
    setCounts((c) => ({ ...c, [key]: Math.min(max, Math.max(min, Math.round(Number(value)) || 0)) }));
  };

  const columns = [
    {
      id: 'trial',
      name: 'Free trial',
      price: '₹0',
      per: 'to start',
      credits: `${fmtNum(trial.credits)} once`,
      creators: trial.maxSources,
      brands: trial.maxKeywords,
      seats: trial.seats,
      pay: 'No card',
      cta: 'Start free',
      href: startHref,
    },
    ...plans.map((p) => ({
      id: p.id,
      name: p.name,
      price: fmtINR(p.price_paise),
      per: 'per month',
      credits: `${fmtNum(p.credits_per_period)} a month`,
      creators: p.max_tracked_creators,
      brands: p.max_tracked_keywords,
      seats: p.max_seats,
      pay: 'UPI or card',
      cta: `Start ${p.name}`,
      href: planHref,
      lead: p.id === 'pro',
    })),
  ];
  const cell = (c, content, extra = '') => (
    <td key={c.id} className={`${c.lead ? 'lead ' : ''}${extra}`.trim() || undefined}>
      {content}
    </td>
  );
  const row = (label, render, extra) => (
    <tr>
      <td>{label}</td>
      {columns.map((c) => cell(c, render(c), extra))}
    </tr>
  );
  const stepper = (key, label) => (
    <div className="ld-step">
      <label htmlFor={`rc-${key}`}>{label}</label>
      <span className="ld-ctrl">
        <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} onClick={() => set(key, counts[key] - 1)}>
          −
        </button>
        <input id={`rc-${key}`} type="number" min={LIMITS[key][0]} max={LIMITS[key][1]} value={counts[key]} onChange={(e) => set(key, e.target.value)} />
        <button type="button" aria-label={`More ${label.toLowerCase()}`} onClick={() => set(key, counts[key] + 1)}>
          +
        </button>
      </span>
    </div>
  );

  return (
    <>
      <div className="ld-ratewrap">
        <table className="ld-rate">
          <thead>
            <tr>
              <th />
              {columns.map((c) => (
                <th key={c.id} className={`${c.lead ? 'lead' : ''}${c.id === fitId ? ' reco' : ''}`.trim() || undefined}>
                  <div className="pn">
                    {c.name}
                    {c.lead ? <span className="ld-tag">Most teams</span> : null}
                    <span className="ld-tag fit">Fits you</span>
                  </div>
                  <div className="pr">
                    {c.price}
                    <small>{c.per}</small>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row('Credits', (c) => c.credits, 'cr')}
            {row('Creators or subreddits', (c) => fmtNum(c.creators))}
            {row('Brands or topics', (c) => fmtNum(c.brands))}
            {row('Seats', (c) => fmtNum(c.seats))}
            {row('Private stories from who you follow', () => 'Included', 'y')}
            {row('Story reports', () => 'Quoted per report', 'n')}
            {row('Payment', (c) => c.pay)}
            <tr>
              <td />
              {columns.map((c) => (
                <td key={c.id} className={c.lead ? 'lead' : undefined}>
                  <Link className={`btn ${c.lead ? 'primary' : 'ghost'}`} href={c.href}>
                    {c.cta}
                  </Link>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="ld-calc">
        <div className="ld-calc-in">
          <h3>What would you follow?</h3>
          <p className="ld-hint">Set the counts. The column that fits gets a stamp.</p>
          {stepper('creators', 'Creators or subreddits')}
          {stepper('brands', 'Brands or topics')}
          {stepper('reports', 'Story reports a month')}
        </div>
        <div className="ld-calc-out">
          <p className="big">
            {fmtNum(need)}
            <small>credits a month</small>
          </p>
          <p className="line">
            {fit ? (
              <>
                <b>{fit.name}</b> covers it with {fmtNum(fit.credits_per_period - need)} credits to spare for reports.
              </>
            ) : (
              <>
                <b>{largest?.name ?? 'Agency'}</b>
                {topup ? ` plus a ${fmtNum(topup)}-credit top-up` : ''}. For more than {fmtNum(largest?.max_tracked_creators ?? 100)} creators, ask us for a custom plan.
              </>
            )}
          </p>
          <Link className="btn primary lg" href={fit ? planHref : planHref}>
            Start {fit?.name ?? largest?.name ?? 'now'}
          </Link>
        </div>
      </div>
    </>
  );
}
