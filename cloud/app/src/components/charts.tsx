import { useId, useState, type ReactNode } from 'react';

/**
 * The Insights page's charts, drawn in SVG with the design system's tokens (so light and dark
 * follow the theme): a stacked column chart by day, and horizontal bars for a breakdown. Each has
 * a hover/focus tooltip, a legend when it has more than one series, and a table for screen
 * readers. Series colors carry meaning (status tones) or are the one primary hue; never ranked.
 */

export interface Series {
  key: string;
  label: string;
  /** Tailwind fill and background classes for the series, e.g. `fill-success-500 dark:fill-success-400`. */
  fill: string;
  swatch: string;
  values: number[];
}

const H = 140;
const PAD_TOP = 8;
const PAD_BOTTOM = 18;

/** A nice round top for the y-axis. */
function niceMax(n: number): number {
  if (n <= 4) return Math.max(1, n);
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= n) return m * p;
  return 10 * p;
}

const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function DailyColumns({
  days,
  series,
  title,
  empty,
  details,
}: {
  days: string[];
  series: Series[];
  title: string;
  empty?: ReactNode;
  /** More lines for a day's tooltip, as [label, value]. */
  details?: Array<Array<[string, number]>>;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const totals = days.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const top = niceMax(Math.max(0, ...totals));
  const n = days.length;
  const W = Math.max(280, n * 12);
  const slot = W / Math.max(1, n);
  const bar = Math.max(2, Math.min(18, slot * 0.62));
  const plot = H - PAD_TOP - PAD_BOTTOM;
  const y = (v: number) => PAD_TOP + plot - (v / top) * plot;
  const ticks = [0, top / 2, top].filter((t, i, a) => a.indexOf(t) === i && Number.isInteger(t));
  const labelEvery = Math.max(1, Math.ceil(n / 6));
  const nothing = totals.every((t) => t === 0);

  return (
    <figure className="flex flex-col gap-2" aria-labelledby={`${id}-t`}>
      <figcaption id={`${id}-t`} className="sr-only">
        {title}
      </figcaption>
      {series.length > 1 && <Legend series={series} />}
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" preserveAspectRatio="none" aria-hidden="true" onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <line key={t} x1={0} x2={W} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray={t === 0 ? undefined : '2 3'} />
          ))}
          {days.map((day, i) => {
            let base = 0;
            const x = i * slot + (slot - bar) / 2;
            return (
              <g key={day}>
                {hover === i && <rect x={i * slot} y={PAD_TOP} width={slot} height={plot} className="fill-muted" />}
                {series.map((s, si) => {
                  const v = s.values[i] ?? 0;
                  if (!v) return null;
                  const y0 = y(base);
                  base += v;
                  const y1 = y(base);
                  // A 2px surface gap between stacked segments; the top segment's end rounded.
                  const gap = si > 0 && base - v > 0 ? 1.5 : 0;
                  const isTop = series.slice(si + 1).every((o) => !(o.values[i] ?? 0));
                  return <rect key={s.key} x={x} y={y1} width={bar} height={Math.max(0.5, y0 - y1 - gap)} rx={isTop ? Math.min(3, bar / 2) : 0} className={s.fill} />;
                })}
                <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
        </svg>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-between text-[11px] text-muted-foreground" aria-hidden="true">
          {days.map((d, i) => (i % labelEvery === 0 || i === n - 1 ? <span key={d}>{dayLabel(d)}</span> : null))}
        </div>
        <div className="pointer-events-none absolute right-0 top-0 text-[11px] text-muted-foreground" aria-hidden="true">
          {top}
        </div>
        {nothing && empty && <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">{empty}</div>}
        {hover !== null && !nothing && (
          <div
            role="status"
            className="pointer-events-none absolute top-2 z-10 min-w-36 rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-medium"
            style={hover > n / 2 ? { right: `${((n - hover) / n) * 100}%` } : { left: `${((hover + 1) / n) * 100}%` }}
          >
            <div className="mb-1 font-semibold text-foreground">{dayLabel(days[hover]!)}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span className={`inline-block h-2 w-2 rounded-sm ${s.swatch}`} />
                  {s.label}
                </span>
                <span className="font-medium tabular-nums text-foreground">{s.values[hover] ?? 0}</span>
              </div>
            ))}
            {details?.[hover]?.map(([label, v]) => (
              <div key={label} className="flex items-center justify-between gap-3 text-muted-foreground">
                <span>{label}</span>
                <span className="tabular-nums text-foreground">{v}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>Day</th>
            {series.map((s) => (
              <th key={s.key}>{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((d, i) => (
            <tr key={d}>
              <td>{d}</td>
              {series.map((s) => (
                <td key={s.key}>{s.values[i] ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function Legend({ series }: { series: Pick<Series, 'key' | 'label' | 'swatch'>[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className={`inline-block h-2.5 w-2.5 rounded-sm ${s.swatch}`} aria-hidden="true" />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

export interface BarRow {
  key: string;
  label: ReactNode;
  value: number;
  /** The text after the bar; defaults to the value. */
  display?: ReactNode;
  hint?: string;
}

/** Horizontal bars, one hue, longest first as given. */
export function Bars({ rows, max, fill = 'bg-primary-500 dark:bg-primary-400', label }: { rows: BarRow[]; max?: number; fill?: string; label: string }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="flex flex-col gap-2" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm sm:grid-cols-[minmax(6rem,10rem)_minmax(0,1fr)_auto]" title={r.hint}>
          <span className="min-w-0 break-words sm:truncate">{r.label}</span>
          <span className="col-span-2 row-start-2 h-2.5 overflow-hidden rounded-full bg-muted sm:col-span-1 sm:row-start-auto" aria-hidden="true">
            <span className={`block h-full rounded-full ${fill}`} style={{ width: `${Math.max(r.value > 0 ? 2 : 0, (r.value / top) * 100)}%` }} />
          </span>
          <span className="col-start-2 row-start-1 min-w-10 text-right font-medium tabular-nums sm:col-start-auto sm:row-start-auto">{r.display ?? r.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** A rate as a thin meter with its 95% interval as a lighter band; for small samples the band says how little is known. */
export function RateMeter({ rate, low, high, label }: { rate: number | null; low: number | null; high: number | null; label: string }) {
  if (rate === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex min-w-24 items-center gap-2" title={low !== null && high !== null ? `${label}: 95% interval ${Math.round(low * 100)}–${Math.round(high * 100)}%` : label}>
      <span className="relative h-2 w-16 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        {low !== null && high !== null && <span className="absolute inset-y-0 bg-primary-200 dark:bg-primary-800" style={{ left: `${low * 100}%`, width: `${(high - low) * 100}%` }} />}
        <span className="absolute inset-y-0 w-0.5 bg-primary-600 dark:bg-primary-300" style={{ left: `calc(${rate * 100}% - 1px)` }} />
      </span>
      <span className="tabular-nums">{Math.round(rate * 100)}%</span>
    </span>
  );
}
