import { type LogEntry, tagColor } from '@/lib/game/log';

export function ShotLog({ entries }: { entries: LogEntry[] }) {
  return (
    <section className="w-[270px]" aria-label="Shot log" aria-live="polite">
      <h2 className="stencil mb-[7px] text-brass">Shot log</h2>
      <ol className="flex flex-col gap-1">
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-baseline gap-2 animate-sb-rise">
            <span
              className={`w-[26px] shrink-0 font-mono text-[9px] font-medium leading-normal tracking-[0.1em] ${tagColor(entry.tag)}`}
            >
              {entry.tag}
            </span>
            <span className="font-mono text-[10px] font-light leading-normal tracking-[0.06em] text-parchment/60">
              {entry.text}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
