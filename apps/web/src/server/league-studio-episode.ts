import path from "node:path";
import { loadLeagueWeek } from "@/lib/league-week";
import type { StudioEpisodeCastMember, StudioEpisodeResponse, StudioEpisodeScene, StudioEpisodeSelection } from "@/lib/studio-episode";
import { listPrivateJson, readStudioAsset, studioDirectory, studioId, type StudioAsset, type StudioBoard, type StudioScene } from "./league-studio-core";
import { LeagueStudioStore, type StudioMemory, type StudioProfile } from "./league-studio-store";

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= max;
}
function validId(value: unknown): value is string {
  try { studioId(value); return true; } catch { return false; }
}
function sameIds(a: unknown, b: unknown) {
  return Array.isArray(a) && Array.isArray(b) && a.every((id) => typeof id === "string")
    && b.every((id) => typeof id === "string") && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}
function memoriesCurrent(board: StudioBoard, scene: StudioScene, current: StudioMemory[]) {
  if (!Array.isArray(scene.memoryIds) || scene.memoryIds.length > 12) return false;
  return scene.memoryIds.every((id) => {
    const saved = board.memories?.filter((memory) => memory.id === id);
    const latest = current.find((memory) => memory.id === id && memory.enabled);
    return validId(id) && saved?.length === 1 && latest && saved[0].text === latest.text
      && saved[0].confidence === latest.confidence && sameIds(saved[0].sourceIds, latest.sourceIds)
      && sameIds(saved[0].memberIds, latest.memberIds);
  });
}

/** A display-only projection; never returns source packets, profile backgrounds, or image prompts. */
export async function savedStudioEpisode(selection: StudioEpisodeSelection): Promise<StudioEpisodeResponse> {
  const { season, week, teamId } = selection;
  if (!Number.isInteger(season) || season < 2000 || season > 2100 || !Number.isInteger(week) || week < 1 || week > 18
    || !Number.isSafeInteger(teamId) || teamId < 1 || teamId > 1_000_000) throw new Error("Choose a valid season, week and team");
  const { report } = await loadLeagueWeek(season, week);
  const selected = report?.teams.find((team) => team.id === teamId);
  if (!report || !selected) return { episode: null, owners: {} };
  const matchupTeams = new Set([teamId]);
  if (report.teams.some((team) => team.id === selected.opponentId && team.opponentId === teamId)) matchupTeams.add(selected.opponentId);
  const boards = await listPrivateJson<StudioBoard>(path.join(studioDirectory(), "boards"), 2000);
  const board = boards.filter((candidate) => candidate.season === season && candidate.week === week && matchupTeams.has(candidate.teamId)
    && validId(candidate.id) && text(candidate.title, 160) && typeof candidate.createdAt === "string"
    && Number.isFinite(Date.parse(candidate.createdAt)) && Array.isArray(candidate.scenes))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id))[0];
  const [current, assets] = await Promise.all([
    new LeagueStudioStore().read(),
    listPrivateJson<StudioAsset>(path.join(studioDirectory(), "assets"), 2000),
  ]);
  const profiles = new Map(current.profiles.map((profile) => [profile.id, profile]));
  const players = new Map(report.teams.flatMap((team) => team.players.map((player) => [player.id, player] as const)));
  const checkedAssets = new Map<string, Promise<StudioAsset | null>>();
  const asset = (id: string) => {
    let pending = checkedAssets.get(id);
    if (!pending) {
      pending = readStudioAsset(id).then((saved) => saved.asset).catch(() => null);
      checkedAssets.set(id, pending);
    }
    return pending;
  };
  const assetUrl = (id: string) => `/api/studio/assets/${encodeURIComponent(id)}`;
  const portrait = async (person: { memberId?: string; playerId?: number }, profile?: StudioProfile, assignedOnly = false) => {
    const matching = (candidate: StudioAsset) => (candidate.kind === "portrait" || candidate.kind === "reference")
      && (person.memberId !== undefined ? candidate.memberId === person.memberId && candidate.playerId === undefined
        : candidate.playerId === person.playerId && candidate.memberId === undefined);
    const candidates = [...(profile?.assets?.map((item) => item.id) ?? []), ...(assignedOnly ? [] : assets.filter(matching).map((item) => item.id))];
    for (const id of new Set(candidates)) {
      if (!validId(id)) continue;
      const stored = await asset(id);
      if (stored && matching(stored)) return assetUrl(id);
    }
    return undefined;
  };
  const owners: StudioEpisodeResponse["owners"] = {};
  for (const id of matchupTeams) {
    owners[String(id)] = [];
    for (const profile of current.profiles.filter((candidate) => candidate.teamId === id && validId(candidate.id) && text(candidate.displayName, 120))) {
      const portraitUrl = await portrait({ memberId: profile.id }, profile, true);
      owners[String(id)].push({ id: profile.id, name: profile.displayName, kind: "member", ...(portraitUrl ? { portraitUrl } : {}) });
    }
  }
  if (!board) return { episode: null, owners };
  const scenes: StudioEpisodeScene[] = [];
  for (const scene of board.scenes.slice(0, 4)) {
    if (!scene || !validId(scene.id) || !["replay", "lineup", "result", "roast"].includes(scene.kind)
      || !text(scene.title, 120) || !text(scene.commentary, 1000) || !memoriesCurrent(board, scene, current.memories)
      || !Array.isArray(scene.memberIds) || !Array.isArray(scene.playerIds)
      || scene.memberIds.length + scene.playerIds.length < 1 || scene.memberIds.length + scene.playerIds.length > 6
      || new Set(scene.memberIds).size !== scene.memberIds.length || new Set(scene.playerIds).size !== scene.playerIds.length
      || scene.memberIds.some((id) => !validId(id) || !profiles.has(id))
      || scene.playerIds.some((id) => !Number.isSafeInteger(id) || id < 1 || !players.has(id))) continue;
    const cast: StudioEpisodeCastMember[] = [];
    for (const id of scene.memberIds) {
      const profile = profiles.get(id)!;
      const portraitUrl = await portrait({ memberId: id }, profile);
      cast.push({ id, name: profile.displayName, kind: "member", ...(portraitUrl ? { portraitUrl } : {}) });
    }
    for (const id of scene.playerIds) {
      const portraitUrl = await portrait({ playerId: id }) ?? `https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png`;
      cast.push({ id: String(id), name: players.get(id)!.name, kind: "player", portraitUrl });
    }
    const savedImage = scene.assetId && validId(scene.assetId) ? await asset(scene.assetId) : null;
    scenes.push({ id: scene.id, kind: scene.kind, title: scene.title, commentary: scene.commentary, cast,
      ...(savedImage?.kind === "generated" ? { assetUrl: assetUrl(savedImage.id) } : {}) });
  }
  return { episode: scenes.length ? { id: board.id, title: board.title, season: board.season, week: board.week,
    teamId: board.teamId, createdAt: board.createdAt, scenes } : null, owners };
}
