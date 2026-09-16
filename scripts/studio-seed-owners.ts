import { promises as fs } from "node:fs";
import path from "node:path";
import { LeagueStudioStore } from "../apps/web/src/server/league-studio-store";
import { studioDirectory, writePrivateJson } from "../apps/web/src/server/league-studio-core";

async function main() {
  const args = process.argv.slice(2);
  const sourceIndex = args.indexOf("--source");
  if (sourceIndex < 0 || !args[sourceIndex + 1]) throw new Error("Supply --source <cached ESPN league JSON>. Use --same-person <full name> only for a confirmed duplicate-account owner.");
  const confirmed = new Set(args.flatMap((arg, index) => arg === "--same-person" ? [args[index + 1]?.trim().toLowerCase()] : []));
  const source = path.resolve(args[sourceIndex + 1]);
  const file = await fs.stat(source);
  if (file.size > 20 * 1024 * 1024) throw new Error("The league source exceeds 20 MB");
  const raw = JSON.parse(await fs.readFile(source, "utf8"));
  const league = Array.isArray(raw) ? raw[0] : raw;
  if (!Array.isArray(league.members) || !Array.isArray(league.teams)) throw new Error("The league source needs members and teams");
  type Member = { id: string; firstName: string; lastName: string; displayName?: string };
  type Team = { id: number; name: string; owners: string[] };
  const members = new Map<string, Member>(league.members.map((member: Member) => [member.id, member]));
  const titleCase = (word: string) => word ? word[0].toUpperCase() + word.slice(1) : word;
  const fullName = (member: Member) => `${member.firstName.trim().split(/\s+/).map(titleCase).join(" ")} ${member.lastName.trim().split(/\s+/).map(titleCase).join(" ")}`.trim();
  const groups = new Map<string, { profileId: string; name: string; teamId: number; team: string; accountIds: string[]; aliases: string[] }>();
  for (const team of league.teams as Team[]) for (const accountId of team.owners) {
    const member = members.get(accountId);
    if (!member) throw new Error("A team owner has no matching league member");
    const name = fullName(member);
    const key = name.toLowerCase();
    if (!name) throw new Error("An owner needs a name before a profile can be created");
    let group = groups.get(key);
    if (group && (!confirmed.has(key) || group.teamId !== team.id)) throw new Error(`Multiple accounts share the name ${name}. Confirm the identity mapping before importing them.`);
    if (!group) {
      group = { profileId: key.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), name, teamId: team.id, team: team.name.trim(), accountIds: [], aliases: [] };
      groups.set(key, group);
    }
    group.accountIds.push(accountId);
    if (member.displayName && !member.displayName.includes("@")) group.aliases.push(member.displayName.trim());
  }
  const store = new LeagueStudioStore();
  const existing = await store.read();
  for (const group of groups.values()) {
    const prior = existing.profiles.find((profile) => profile.id === group.profileId);
    if (prior && prior.teamId !== group.teamId) throw new Error(`The saved team for ${group.name} differs; resolve that mapping first.`);
    await store.saveProfile(prior ?? { id: group.profileId, teamId: group.teamId, displayName: group.name,
      aliases: [...new Set(group.aliases)], background: "", roastNotes: "", avoidTopics: [] });
  }
  await writePrivateJson(path.join(studioDirectory(), "owner-accounts.json"), {
    source: path.basename(source), season: league.seasonId, updatedAt: new Date().toISOString(),
    confirmedSamePersonNames: [...confirmed], owners: [...groups.values()],
  });
  const csv = (value: unknown) => `"${String(value).replace(/"/g, '""')}"`;
  const rows = [["photo_folder", "owner_name", "team_id", "team_name", "espn_account_count"],
    ...[...groups.values()].map((owner) => [owner.profileId, owner.name, owner.teamId, owner.team, owner.accountIds.length])];
  await fs.writeFile(path.join(studioDirectory(), "owner-roster.csv"), rows.map((row) => row.map(csv).join(",")).join("\n") + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ profiles: groups.size, teams: league.teams.length, accountCount: [...groups.values()].reduce((n, owner) => n + owner.accountIds.length, 0), roster: path.join(studioDirectory(), "owner-roster.csv") }));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Owner import failed"); process.exitCode = 1; });
