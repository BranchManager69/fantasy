import type { ReactNode } from "react";

type Props = {
  eyebrow?: string;
  title?: string;
  children: ReactNode;
};

export function TeamSummaryCard({ eyebrow, title, children }: Props) {
  return (
    <div className="grid gap-2 rounded-[var(--radius-sm)] border border-[rgba(255,255,255,0.08)] bg-[rgba(8,14,28,0.72)] px-[18px] py-4">
      {eyebrow ? (
        <span className="text-[0.72rem] uppercase tracking-[0.16em] text-[var(--text-muted)]">{eyebrow}</span>
      ) : null}
      {title ? <h3 className="text-[1.05rem] font-semibold text-[var(--text-soft)]">{title}</h3> : null}
      {children}
    </div>
  );
}


