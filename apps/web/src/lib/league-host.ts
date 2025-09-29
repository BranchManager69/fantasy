export function hostToLeagueSlug(host?: string | null): string | null {
  if (!host) return null;
  const lower = host.toLowerCase();
  const parts = lower.split(".");
  if (parts.length < 3) return null; // expect <slug>.branch.bet
  return parts[0].replace(/[^a-z0-9-]/g, "");
}

export function defaultLeagueSlug(): string | null {
  return process.env.FANTASY_DEFAULT_LEAGUE || "fantasy";
}
