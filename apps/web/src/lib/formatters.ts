export function formatOwners(owners: string[]): string {
  if (owners.length === 0) return "Unclaimed";
  if (owners.length === 1) return owners[0];
  if (owners.length === 2) return `${owners[0]} & ${owners[1]}`;
  return `${owners[0]}, ${owners[1]} +`;
}

export function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

export function formatRecord(record: { wins: number; losses: number; ties: number }): string {
  return `${record.wins.toFixed(1)} – ${record.losses.toFixed(1)}`;
}

export function probabilityTone(probability: number): "favorable" | "coinflip" | "underdog" {
  if (probability >= 0.6) return "favorable";
  if (probability <= 0.4) return "underdog";
  return "coinflip";
}

export function probabilityClass(probability: number): string {
  const tone = probabilityTone(probability);
  if (tone === "favorable") return "bg-[rgba(34,197,94,0.08)]";
  if (tone === "underdog") return "bg-[rgba(249,115,22,0.08)]";
  return "bg-[rgba(96,165,250,0.08)]";
}

export function probabilityLabel(probability: number): string {
  const pct = Math.round(probability * 100);
  return `${pct}% win odds`;
}

export function formatMargin(margin: number): string {
  if (Number.isNaN(margin)) return "";
  if (Math.abs(margin) < 0.25) return "coin flip";
  if (margin > 0) return `favored by ${margin.toFixed(1)}`;
  return `needs ${Math.abs(margin).toFixed(1)}`;
}

export function formatFinalMargin(margin: number): string {
  if (Number.isNaN(margin)) return "";
  if (Math.abs(margin) < 0.25) return "Tied";
  if (margin > 0) return `Won by ${margin.toFixed(1)}`;
  return `Lost by ${Math.abs(margin).toFixed(1)}`;
}

export function formatLiveMargin(pointsFor: number | null, pointsAgainst: number | null): string {
  if (pointsFor === null || pointsAgainst === null) return "";
  const diff = pointsFor - pointsAgainst;
  if (Math.abs(diff) < 0.25) return "Currently tied";
  if (diff > 0) return `Leading by ${diff.toFixed(1)}`;
  return `Trailing by ${Math.abs(diff).toFixed(1)}`;
}
