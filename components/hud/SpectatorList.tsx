'use client';

export function SpectatorList({ spectators }: { spectators: { name: string }[] }) {
  if (spectators.length === 0) return null;

  return (
    <aside className="pointer-events-auto w-[190px] rounded-md border border-white/80 bg-white/95 p-3 shadow-[0_8px_24px_rgba(0,0,0,.28)]" aria-label="Spectators">
      <h2 className="stencil mb-1.5 text-abyss">Spectators · {spectators.length}</h2>
      <ul className="max-h-[92px] space-y-1 overflow-y-auto pr-1">
        {spectators.map((spectator, index) => (
          <li key={`${spectator.name}-${index}`} className="font-mono text-[10px] text-slate-deep">
            {spectator.name}
          </li>
        ))}
      </ul>
    </aside>
  );
}
