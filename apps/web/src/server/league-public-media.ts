import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { getDataRoot } from "@/lib/paths";
import { loadLeagueWeek, type LeagueWeek } from "@/lib/league-week";
import type { LeagueImageCrop, LeagueTeamImage, PublicLeagueEpisodeResponse, WeekLeagueMedia } from "@/lib/league-media";
import type { StudioEpisodeSelection } from "@/lib/studio-episode";
import type { PhotoTemplate } from "@/types/studio-photos";
import { listPrivateJson, readPrivateJson, readStudioAsset, studioDirectory, studioId, type StudioAsset, type StudioBoard } from "./league-studio-core";
import { savedStudioEpisode } from "./league-studio-episode";
import { LeagueStudioStore } from "./league-studio-store";

export const publicMediaHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
type DisplayCrop = { memberId: string; photoId: string; crop: LeagueImageCrop; kind?: "photo" | "portrait"; peopleNames?: string[] };
function validId(value: unknown): value is string { try { studioId(value); return true; } catch { return false; } }
export function publicMediaSelection(search: URLSearchParams): StudioEpisodeSelection | null {
  const values = ["season", "week", "teamId"].map((key) => search.get(key));
  if (values.some((value) => !value || !/^\d{1,7}$/.test(value))) return null;
  const [season, week, teamId] = values.map(Number);
  return season >= 2000 && season <= 2100 && week >= 1 && week <= 18 && teamId >= 1 && teamId <= 1_000_000
    ? { season, week, teamId } : null;
}
export function publicMediaWeek(search: URLSearchParams): Pick<StudioEpisodeSelection, "season" | "week"> | null {
  const query = new URLSearchParams(search); query.set("teamId", "1");
  const selection = publicMediaSelection(query);
  return selection ? { season: selection.season, week: selection.week } : null;
}
function imageUrl(id: string, selection: Pick<StudioEpisodeSelection, "season" | "week">) {
  return `/api/league/images/${encodeURIComponent(id)}?season=${selection.season}&week=${selection.week}`;
}
function validCrop(crop: LeagueImageCrop | undefined): crop is LeagueImageCrop {
  return !!crop && [crop.x, crop.y, crop.width, crop.height].every((value) => typeof value === "number" && Number.isFinite(value))
    && crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0
    && crop.x + crop.width <= 1 && crop.y + crop.height <= 1;
}
async function displayCrops(): Promise<DisplayCrop[]> {
  try {
    const data = await readPrivateJson<{ version: number; crops: DisplayCrop[] }>(path.join(studioDirectory(), "display-crops.json"), 256 * 1024);
    if (data.version !== 1 || !Array.isArray(data.crops) || data.crops.length > 128) return [];
    return data.crops.filter((entry) => entry && validId(entry.memberId) && validId(entry.photoId) && validCrop(entry.crop));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function teamLogos(season: number): Promise<Map<number, string>> {
  const file = path.join(getDataRoot(), "out", "espn", String(season), "teams.csv");
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 3 * 1024 * 1024) return new Map();
    const rows = parse(await fs.readFile(file, "utf8"), { columns: true, skip_empty_lines: true }) as { team_id: string; logo?: string }[];
    const logos = new Map<number, string>();
    for (const row of rows) {
      if (!/^\d+$/.test(row.team_id)) continue;
      try {
        const url = new URL(row.logo || "");
        if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) logos.set(Number(row.team_id), url.href);
      } catch { /* A missing custom logo leaves the team's initials available in the view. */ }
    }
    return logos;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map(); throw error; }
}

/** Public display choices use saved assignments and supplied labels, never face inference. */
export async function buildPublicLeagueMedia(report: LeagueWeek): Promise<WeekLeagueMedia> {
  const [state, photos, crops, logos] = await Promise.all([
    new LeagueStudioStore().read(), listPrivateJson<PhotoTemplate>(path.join(studioDirectory(), "photos"), 2000),
    displayCrops(), teamLogos(report.season),
  ]);
  const profiles = new Map(state.profiles.map((profile) => [profile.id, profile]));
  const checked = new Map<string, Promise<StudioAsset | null>>();
  const asset = (id: string) => {
    if (!validId(id)) return Promise.resolve(null);
    let pending = checked.get(id);
    if (!pending) { pending = readStudioAsset(id).then((value) => value.asset).catch(() => null); checked.set(id, pending); }
    return pending;
  };
  const knownMembers = (photo: PhotoTemplate) => [...new Set((photo.labels ?? [])
    .filter((label) => label.basis === "user_supplied" && label.memberId && profiles.has(label.memberId)).map((label) => label.memberId!))];
  const media: WeekLeagueMedia = { owners: {}, teamImages: {} };
  for (const team of report.teams) {
    const selection = { season: report.season, week: report.week, teamId: team.id };
    const owners = state.profiles.filter((profile) => profile.teamId === team.id && validId(profile.id));
    media.owners[team.id] = [];
    const images: LeagueTeamImage[] = [];
    const covered = new Set<string>();
    for (const owner of owners) {
      let portraitUrl: string | undefined;
      for (const assigned of owner.assets ?? []) {
        const stored = await asset(assigned.id);
        if (stored && (stored.kind === "portrait" || stored.kind === "reference") && stored.memberId === owner.id && stored.playerId === undefined) {
          portraitUrl = imageUrl(stored.id, selection);
          images.push({ teamId: team.id, imageUrl: portraitUrl, kind: "portrait", memberId: owner.id, peopleNames: [owner.displayName] });
          covered.add(owner.id); break;
        }
      }
      media.owners[team.id].push({ id: owner.id, name: owner.displayName, kind: "member", ...(portraitUrl ? { portraitUrl } : {}) });
      if (covered.has(owner.id)) continue;
      for (const approved of crops.filter((entry) => entry.memberId === owner.id)) {
        const photo = photos.find((candidate) => candidate.id === approved.photoId);
        if (!photo || !knownMembers(photo).includes(owner.id)) continue;
        const stored = await asset(photo.sourceAssetId);
        if (stored?.kind !== "source-photo") continue;
        const suppliedNames = new Set(photo.labels.filter((label) => label.basis === "user_supplied").map((label) => label.memberId && profiles.has(label.memberId) ? profiles.get(label.memberId)!.displayName : label.name));
        const peopleNames = approved.kind === "photo" && Array.isArray(approved.peopleNames) && approved.peopleNames.length
          && approved.peopleNames.every((name) => suppliedNames.has(name)) ? approved.peopleNames : [owner.displayName];
        if (approved.kind === "photo" && peopleNames.length === 1) continue;
        images.push({ teamId: team.id, imageUrl: imageUrl(stored.id, selection), kind: approved.kind === "photo" ? "photo" : "portrait", memberId: owner.id,
          peopleNames, imageWidth: photo.width, imageHeight: photo.height,
          crop: { x: approved.crop.x, y: approved.crop.y, width: approved.crop.width, height: approved.crop.height } });
        covered.add(owner.id); break;
      }
    }
    const remaining = new Set(owners.filter((owner) => !covered.has(owner.id)).map((owner) => owner.id));
    if (remaining.size) {
      const candidates = photos.map((photo) => ({ photo, members: knownMembers(photo) }))
        .filter(({ members }) => members.some((id) => remaining.has(id)))
        .sort((a, b) => b.members.filter((id) => remaining.has(id)).length - a.members.filter((id) => remaining.has(id)).length
          || a.photo.labels.length - b.photo.labels.length || a.photo.filename.localeCompare(b.photo.filename));
      for (const { photo } of candidates) {
        const stored = await asset(photo.sourceAssetId);
        if (stored?.kind !== "source-photo") continue;
        images.push({ teamId: team.id, imageUrl: imageUrl(stored.id, selection), kind: "photo",
          imageWidth: photo.width, imageHeight: photo.height,
          peopleNames: [...new Set(photo.labels.filter((label) => label.basis === "user_supplied").map((label) => label.memberId && profiles.has(label.memberId)
            ? profiles.get(label.memberId)!.displayName : label.name).filter((name) => typeof name === "string" && !!name.trim()))] });
        break;
      }
    }
    if (logos.has(team.id)) images.push({ teamId: team.id, imageUrl: logos.get(team.id)!, kind: "team-logo", peopleNames: [] });
    media.teamImages[team.id] = images;
  }
  return media;
}

export async function publicLeagueEpisode(selection: StudioEpisodeSelection): Promise<PublicLeagueEpisodeResponse> {
  const { report } = await loadLeagueWeek(selection.season, selection.week);
  const selected = report?.teams.find((team) => team.id === selection.teamId);
  if (!report || !selected) return { episode: null, owners: {}, teamImages: {} };
  const scope = new Set([selected.id]);
  if (report.teams.some((team) => team.id === selected.opponentId && team.opponentId === selected.id)) scope.add(selected.opponentId);
  const [saved, media] = await Promise.all([savedStudioEpisode(selection), buildPublicLeagueMedia(report)]);
  const url = (value: string | undefined) => {
    if (!value) return undefined;
    const prefix = "/api/studio/assets/";
    if (!value.startsWith(prefix)) return value;
    const id = value.slice(prefix.length);
    return validId(id) ? imageUrl(id, selection) : undefined;
  };
  const episode = saved.episode ? { ...saved.episode, scenes: saved.episode.scenes.map((scene) => ({ ...scene,
    ...(scene.assetUrl ? { assetUrl: url(scene.assetUrl) } : {}),
    cast: scene.cast.map((person) => ({ ...person, ...(person.portraitUrl ? { portraitUrl: url(person.portraitUrl) } : {}) })),
  })) } : null;
  return { episode,
    owners: Object.fromEntries([...scope].map((id) => [id, media.owners[id] ?? []])),
    teamImages: Object.fromEntries([...scope].map((id) => [id, media.teamImages[id] ?? []])),
  };
}

/** Shared URLs can serve only assets selected by a current public league projection. */
export async function readPublicLeagueImage(selection: Pick<StudioEpisodeSelection, "season" | "week">, id: string) {
  if (!validId(id)) return null;
  const { report } = await loadLeagueWeek(selection.season, selection.week);
  if (!report) return null;
  let metadata: StudioAsset;
  try { metadata = await readPrivateJson<StudioAsset>(path.join(studioDirectory(), "assets", `${id}.json`)); } catch { return null; }
  if (metadata.id !== id || metadata.kind === "cutout") return null;
  let allowed = false;
  if (["source-photo", "portrait", "reference"].includes(metadata.kind)) {
    const view = await buildPublicLeagueMedia(report);
    const urls = [...Object.values(view.teamImages).flat().map((item) => item.imageUrl), ...Object.values(view.owners).flat().map((item) => item.portraitUrl)];
    allowed = urls.some((url) => url === imageUrl(id, selection));
  }
  if (!allowed && ["generated", "portrait", "reference"].includes(metadata.kind)) {
    const boards = await listPrivateJson<StudioBoard>(path.join(studioDirectory(), "boards"), 2000);
    const teams = new Set(boards.filter((board) => board.season === selection.season && board.week === selection.week && report.teams.some((team) => team.id === board.teamId)
      && board.scenes.some((scene) => scene.assetId === id || (metadata.memberId && scene.memberIds.includes(metadata.memberId))
        || (metadata.playerId && scene.playerIds.includes(metadata.playerId)))).map((board) => board.teamId));
    for (const teamId of teams) {
      const { episode } = await savedStudioEpisode({ ...selection, teamId });
      const urls = episode?.scenes.flatMap((scene) => [scene.assetUrl, ...scene.cast.map((person) => person.portraitUrl)]) ?? [];
      if (urls.includes(`/api/studio/assets/${id}`)) { allowed = true; break; }
    }
  }
  if (!allowed) return null;
  try { const { asset, bytes } = await readStudioAsset(id); return { bytes, mime: asset.mime, etag: `"${id}"` }; } catch { return null; }
}
