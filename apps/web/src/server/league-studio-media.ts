import { promises as fs } from "node:fs";
import path from "node:path";
import OpenAI, { toFile } from "openai";
import { getRepoRoot } from "@/lib/paths";
import { loadLeagueWeek } from "@/lib/league-week";
import { imageMime, listPrivateJson, readStudioAsset, saveStudioAsset, studioDirectory, studioId,
  type StudioAsset, type StudioBoard, type StudioScene } from "./league-studio-core";
import type { StudioProfile } from "./league-studio-store";

const MAX_REFERENCES = 8;
const MAX_HEADSHOT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_MEMORY_BYTES = 12_000;
export type StudioSceneReference = { asset: StudioAsset; bytes: Buffer; identity: string };
type CastMember = { identity: string; memberId?: string; playerId?: number; profile?: StudioProfile };
export type StudioReferencePlan = CastMember & { assetId?: string };

async function sceneCast(board: StudioBoard, scene: StudioScene, profiles: StudioProfile[]): Promise<CastMember[]> {
  studioId(board.id); studioId(scene.id);
  if (!board.scenes.some((candidate) => candidate.id === scene.id)) throw new Error("This scene does not belong to the selected storyboard");
  if (!Number.isInteger(board.season) || board.season < 2000 || board.season > 2100
    || !Number.isInteger(board.week) || board.week < 1 || board.week > 18) throw new Error("Invalid storyboard season or week");
  if (!Array.isArray(scene.memberIds) || !Array.isArray(scene.playerIds)) throw new Error("The scene cast is missing");
  const count = scene.memberIds.length + scene.playerIds.length;
  if (!count) throw new Error("This scene needs at least one real GM or player image reference");
  if (count > MAX_REFERENCES) throw new Error("A scene can include at most eight image references. Split the scene without dropping anyone from its cast.");
  if (new Set(scene.memberIds).size !== scene.memberIds.length || new Set(scene.playerIds).size !== scene.playerIds.length) {
    throw new Error("The scene lists the same person or player more than once");
  }
  const members = new Map<string, StudioProfile>();
  for (const profile of profiles) {
    studioId(profile.id);
    if (members.has(profile.id)) throw new Error("GM profile identifiers must be unique");
    members.set(profile.id, profile);
  }
  const cast: CastMember[] = scene.memberIds.map((id) => {
    studioId(id);
    const profile = members.get(id);
    if (!profile) throw new Error(`The scene names an unknown GM profile: ${id}`);
    return { memberId: id, profile, identity: `GM: ${profile.displayName} (member ${id}, fantasy team ${profile.teamId})` };
  });
  if (scene.playerIds.length) {
    const { report } = await loadLeagueWeek(board.season, board.week);
    if (!report) throw new Error("The cached league week is required to verify NFL player identities");
    const players = new Map(report.teams.flatMap((team) => team.players.map((player) => [player.id, player] as const)));
    for (const id of scene.playerIds) {
      if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid NFL player identifier");
      const player = players.get(id);
      if (!player) throw new Error(`Player ${id} is not in the cached ${board.season} Week ${board.week} league data`);
      cast.push({ playerId: id, identity: `NFL player: ${player.name} (ESPN player ${id}, ${player.position})` });
    }
  }
  return cast;
}

function matches(asset: StudioAsset, person: CastMember): boolean {
  return (asset.kind === "portrait" || asset.kind === "reference")
    && (person.memberId !== undefined ? asset.memberId === person.memberId && asset.playerId === undefined
      : asset.playerId === person.playerId && asset.memberId === undefined);
}

function selectedSceneMemories(board: StudioBoard, scene: StudioScene): NonNullable<StudioBoard["memories"]> {
  if (!Array.isArray(scene.memoryIds) || scene.memoryIds.length > 12
    || new Set(scene.memoryIds).size !== scene.memoryIds.length) throw new Error("The scene has an invalid list of league memories");
  const sourceIds = new Set(board.sourceIds);
  const memories = scene.memoryIds.map((id) => {
    studioId(id);
    const candidates = (board.memories ?? []).filter((memory) => memory.id === id);
    if (candidates.length !== 1) throw new Error("A memory cited by this scene is unavailable. Create a new episode from the current league history.");
    const memory = candidates[0];
    if (typeof memory.text !== "string" || !memory.text.trim() || memory.text.length > 3000
      || !Array.isArray(memory.sourceIds) || !memory.sourceIds.length || memory.sourceIds.length > 20
      || memory.sourceIds.some((sourceId) => typeof sourceId !== "string" || !sourceId.trim() || sourceId.length > 100 || !sourceIds.has(sourceId))
      || !Array.isArray(memory.memberIds) || memory.memberIds.length > 16
      || !["explicit", "inferred"].includes(memory.confidence)) {
      throw new Error("A scene memory is missing valid source references or confidence. Create a new episode from the current league history.");
    }
    memory.memberIds.forEach(studioId);
    return { id, text: memory.text, sourceIds: memory.sourceIds, memberIds: memory.memberIds, confidence: memory.confidence };
  });
  if (Buffer.byteLength(JSON.stringify(memories), "utf8") > MAX_MEMORY_BYTES) {
    throw new Error("This scene cites too much league history for one image. Select fewer memories before rendering.");
  }
  return memories;
}

/** Resolve the full cast before downloading anything or reserving an image request. */
export async function buildSceneReferences(board: StudioBoard, scene: StudioScene, profiles: StudioProfile[]): Promise<StudioReferencePlan[]> {
  const cast = await sceneCast(board, scene, profiles);
  selectedSceneMemories(board, scene);
  const assets = await listPrivateJson<StudioAsset>(path.join(studioDirectory(), "assets"), 2000);
  const plan: StudioReferencePlan[] = [];
  for (const person of cast) {
    let chosen: StudioAsset | undefined;
    for (const entry of person.profile?.assets ?? []) {
      const { asset } = await readStudioAsset(studioId(entry.id));
      if (!matches(asset, person)) throw new Error(`The image assigned to ${person.profile!.displayName} does not match that GM's identity`);
      chosen ??= asset;
    }
    chosen ??= assets.find((asset) => matches(asset, person));
    if (person.memberId && !chosen) {
      throw new Error(`Add a matching portrait for ${person.profile!.displayName} before rendering this scene. A substitute face will not be generated.`);
    }
    plan.push({ ...person, assetId: chosen?.id });
  }
  return plan;
}

async function downloadHeadshot(playerId: number, identity: string): Promise<StudioSceneReference> {
  const sourceUrl = `https://a.espncdn.com/i/headshots/nfl/players/full/${playerId}.png`;
  const response = await fetch(sourceUrl, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  const discard = () => { void response.body?.cancel().catch(() => undefined); };
  if (!response.ok || response.redirected) { discard(); throw new Error(`The ESPN image for player ${playerId} could not be loaded`); }
  const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (!["image/png", "image/jpeg", "image/webp"].includes(mime ?? "")) { discard(); throw new Error(`ESPN did not return an image for player ${playerId}`); }
  const length = response.headers.get("content-length");
  if (length && (!Number.isSafeInteger(Number(length)) || Number(length) < 1 || Number(length) > MAX_HEADSHOT_BYTES)) {
    discard();
    throw new Error("The player image exceeds the 8 MB download limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The player image response was empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HEADSHOT_BYTES) throw new Error("The player image exceeds the 8 MB download limit");
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  if (imageMime(bytes) !== mime) throw new Error("The player image type does not match its contents");
  const asset = await saveStudioAsset(bytes, { kind: "reference", playerId, label: identity, sourceUrl });
  return { asset, bytes, identity };
}

export async function prepareSceneReferences(board: StudioBoard, scene: StudioScene, profiles: StudioProfile[]): Promise<StudioSceneReference[]> {
  const plan = await buildSceneReferences(board, scene, profiles);
  const references: StudioSceneReference[] = [];
  for (const person of plan) {
    if (person.assetId) {
      const reference = await readStudioAsset(person.assetId);
      if (!matches(reference.asset, person)) throw new Error("A stored image no longer matches its cast member");
      references.push({ ...reference, identity: person.identity });
    } else {
      references.push(await downloadHeadshot(person.playerId!, person.identity));
    }
  }
  return references;
}

async function validatePrepared(board: StudioBoard, scene: StudioScene, profiles: StudioProfile[], references: StudioSceneReference[]) {
  const cast = await sceneCast(board, scene, profiles);
  if (cast.length !== references.length) throw new Error("Every cast member must have an image reference before rendering");
  const checked: StudioSceneReference[] = [];
  for (let i = 0; i < cast.length; i++) {
    const reference = references[i];
    const saved = await readStudioAsset(studioId(reference.asset.id));
    if (!matches(saved.asset, cast[i]) || !saved.bytes.equals(reference.bytes)) throw new Error("An image reference does not match the selected cast");
    checked.push({ ...saved, identity: cast[i].identity });
  }
  return checked;
}

export async function renderStudioScene(options: {
  client: OpenAI; board: StudioBoard; scene: StudioScene; profiles: StudioProfile[];
  preparedReferences?: StudioSceneReference[];
  onProgress?: (message: string) => void | Promise<void>;
}): Promise<StudioAsset> {
  const { client, board, scene, profiles } = options;
  const progress = async (message: string) => { try { await options.onProgress?.(message); } catch { /* Progress must not discard an image. */ } };
  await progress("Checking the complete cast and reference images...");
  const references = options.preparedReferences
    ? await validatePrepared(board, scene, profiles, options.preparedReferences)
    : await prepareSceneReferences(board, scene, profiles);
  const memories = selectedSceneMemories(board, scene);
  const evidence: Record<string, unknown> = {};
  for (const id of scene.evidenceIds) {
    if (!Object.hasOwn(board.evidence, id)) throw new Error("The scene cites football evidence that is unavailable");
    evidence[id] = board.evidence[id];
  }
  const template = await fs.readFile(path.join(getRepoRoot(), "prompts", "studio", "image.md"), "utf8");
  const prompt = `${template.trim()}\n\nSCENE_DATA_JSON\n${JSON.stringify({
    season: board.season, week: board.week,
    scene: { kind: scene.kind, title: scene.title, imageBrief: scene.imageBrief, commentary: scene.commentary,
      evidenceIds: scene.evidenceIds, memoryIds: scene.memoryIds },
    references: references.map((reference, i) => ({ image: i + 1, identity: reference.identity, assetId: reference.asset.id })),
    castBoundaries: scene.memberIds.map((id) => { const profile = profiles.find((entry) => entry.id === id)!;
      return { memberId: id, displayName: profile.displayName, avoidTopics: profile.avoidTopics }; }),
    suppliedEvidence: evidence,
    suppliedMemories: memories,
  })}\nEND_SCENE_DATA_JSON`;
  if (prompt.length > 32_000) throw new Error("This scene has too much evidence for one image request");
  const model = process.env.FANTASY_STUDIO_IMAGE_MODEL || "gpt-image-2.5-sunburst";
  const files = await Promise.all(references.map((reference, i) => toFile(reference.bytes,
    `reference-${i + 1}.${reference.asset.mime === "image/jpeg" ? "jpg" : reference.asset.mime.split("/")[1]}`,
    { type: reference.asset.mime })));
  await progress("Rendering the scene with its reference images...");
  const result = await client.images.edit({ model, image: files, prompt, n: 1, size: "1536x1024", quality: "medium", output_format: "webp" },
    { timeout: 180_000, signal: AbortSignal.timeout(180_000), maxRetries: 0 });
  const encoded = result.data?.length === 1 ? result.data[0].b64_json : undefined;
  if (!encoded || encoded.length > Math.ceil(MAX_OUTPUT_BYTES / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("The image service did not return one valid image within the size limit");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error("The image service returned invalid image bytes");
  const asset = await saveStudioAsset(bytes, { kind: "generated", label: scene.title,
    referenceIds: references.map((reference) => reference.asset.id), prompt, model });
  await progress("Scene image saved.");
  return asset;
}
