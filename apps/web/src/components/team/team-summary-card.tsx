import type { ReactNode } from "react";

type Props = {
  eyebrow?: string;
  title?: string;
  children: ReactNode;
};

export function TeamSummaryCard({ eyebrow, title, children }: Props) {
  return (
    <div className="team-summary__card">
      {eyebrow ? <span className="team-summary__eyebrow">{eyebrow}</span> : null}
      {title ? <h3>{title}</h3> : null}
      {children}
    </div>
  );
}



