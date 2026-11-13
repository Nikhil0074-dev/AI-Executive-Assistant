import { hourTicks, segment } from '../lib/time';
import type { Slot } from '../lib/types';

/** One row per participant: busy blocks (coral) with the proposed slot overlaid in ultramarine. */
export default function Timeline({ slot, tz }: { slot: Slot; tz: string }) {
  const { start: t0, end: t1, rows } = slot.timeline;
  const proposed = segment(slot.startUtc, slot.endUtc, t0, t1);
  return (
    <div className="timeline" role="img" aria-label="Busy periods for each participant with the proposed time highlighted">
      <div className="tl-axis">
        {hourTicks(t0, t1, tz).filter((_, i) => i % 2 === 0).map((t) => (
          <span key={t.pct} style={{ left: `${t.pct}%` }}>{t.label}</span>
        ))}
      </div>
      {rows.map((row) => (
        <div className="tl-row" key={row.email}>
          <span className="tl-name">{row.label}</span>
          <div className={`tl-track ${row.status}`}>
            {hourTicks(t0, t1, tz).map((t) => <i key={t.pct} className="tick" style={{ left: `${t.pct}%` }} />)}
            {row.status === 'unknown'
              ? <em>availability unknown</em>
              : row.busy.map((b, i) => {
                  const s = segment(b.start, b.end, t0, t1);
                  return <b key={i} className="busy" style={{ left: `${s.left}%`, width: `${s.width}%` }} />;
                })}
            <u className="proposed" style={{ left: `${proposed.left}%`, width: `${proposed.width}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
