export function SimulationLegend() {
  return (
    <footer className="flex flex-wrap gap-[14px] text-[0.85rem] text-[var(--text-muted)]">
      <span className="inline-flex items-center gap-2 rounded-[var(--radius-sm)] border border-[rgba(148,163,184,0.2)] bg-[rgba(15,23,42,0.6)] px-[10px] py-[6px]">
        <span
          aria-hidden
          className="h-2 w-[18px] rounded-full bg-[rgba(34,197,94,0.7)]"
        />
        Favorable (&gt;60% win odds)
      </span>
      <span className="inline-flex items-center gap-2 rounded-[var(--radius-sm)] border border-[rgba(148,163,184,0.2)] bg-[rgba(15,23,42,0.6)] px-[10px] py-[6px]">
        <span
          aria-hidden
          className="h-2 w-[18px] rounded-full bg-[rgba(96,165,250,0.7)]"
        />
        Tight contest (40–60%)
      </span>
      <span className="inline-flex items-center gap-2 rounded-[var(--radius-sm)] border border-[rgba(148,163,184,0.2)] bg-[rgba(15,23,42,0.6)] px-[10px] py-[6px]">
        <span
          aria-hidden
          className="h-2 w-[18px] rounded-full bg-[rgba(249,115,22,0.75)]"
        />
        Underdog (&lt;40% win odds)
      </span>
    </footer>
  );
}
