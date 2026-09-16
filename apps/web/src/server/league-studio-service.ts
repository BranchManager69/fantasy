import OpenAI from "openai";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getRepoRoot } from "@/lib/paths";
import { loadLeagueWeek } from "@/lib/league-week";
import { AnalystBudget } from "./analyst-budget";
import { recoverPendingAnalystCleanup } from "./analyst-cleanup";
import { createAnalystContext } from "./analyst-context";
import { runAnalyst } from "./analyst-runner";
import { LeagueStudioStore, type StudioMemory } from "./league-studio-store";
import { buildSceneReferences, prepareSceneReferences, renderStudioScene } from "./league-studio-media";
import { collectionFile, listPrivateJson, readPrivateJson, studioDirectory, studioId, writePrivateJson, type StudioAsset, type StudioBoard, type StudioJob, type StudioScene } from "./league-studio-core";

export const studioStore = new LeagueStudioStore();
export const studioBudget = new AnalystBudget({ directory: path.join(studioDirectory(), "agent-runs"), dailyLimit: Number(process.env.FANTASY_STUDIO_DAILY_LIMIT || 20) });
const imageBudget = new AnalystBudget({ directory: path.join(studioDirectory(), "image-runs"), dailyLimit: Number(process.env.FANTASY_STUDIO_IMAGE_DAILY_LIMIT || 4) });
const processState = globalThis as typeof globalThis & { __fantasyStudio?: { owner: string; busy: boolean } };
const state = processState.__fantasyStudio ??= { owner: `${process.pid}:${randomUUID()}`, busy: false };
export function studioClient() {
  if (!process.env.OPENAI_API_KEY) throw new Error("The studio's AI connection is not configured");
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 20_000 });
}
export function parseStudioJson(text: string): Record<string, unknown> {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const result: unknown = JSON.parse(clean);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("The model returned an invalid structured result");
  return result as Record<string, unknown>;
}
async function prompt(name: "culture" | "producer" | "writer") {
  return fs.readFile(path.join(getRepoRoot(), "prompts", "studio", `${name}.md`), "utf8");
}
type Update = (stage: string, done?: number, total?: number) => Promise<void>;
async function agentStep(role: "culture" | "producer" | "writer", packet: unknown, update: Update, selection = { season: 2026, week: 1, teamId: 0 }) {
  const client = studioClient();
  for (let attempt = 0; attempt < 8; attempt++) {
    await recoverPendingAnalystCleanup({ client, budget: studioBudget });
    if (!(await studioBudget.status()).busy) break;
    const active = await studioBudget.activeReceipt();
    if (active?.status !== "cleanup_pending" || attempt === 7) throw new Error("The previous AI session is still closing. Your saved work can be resumed shortly.");
    await update("Waiting for the previous AI session to finish closing");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const initialEvidence = JSON.stringify(packet);
  if (Buffer.byteLength(initialEvidence) > 24_000) throw new Error("The selected context is too large. Shorten the background or select fewer memories.");
  return runAnalyst({ client, budget: studioBudget, ...selection,
    question: role === "culture" ? "Extract useful, sourced league memories from this message batch." : role === "producer" ? "Plan the episode from these facts and people." : "Check the facts and edit this episode for the league.",
    writer: { model: (role === "writer" ? process.env.FANTASY_STUDIO_WRITER_MODEL : process.env.FANTASY_STUDIO_MODEL) || "gpt-6-astra", instructions: await prompt(role) },
    context: { tools: [], call: async () => { throw new Error("No additional source tools are available in this stage"); }, sources: [], initialEvidence, evidenceLabel: `studio_${role}_sources` },
    maxOutputChars: 22000,
    onProgress: async (progress) => update(`${role === "culture" ? "Reading league history" : role === "producer" ? "Choosing the scenes" : "Editing the episode"}: ${progress.message}`),
  });
}
export async function startStudioJob(kind: StudioJob["kind"], execute: (job: StudioJob, update: Update) => Promise<string | undefined>) {
  if (state.busy) throw new Error("The studio is finishing another task. Its progress is shown below.");
  state.busy = true;
  const now = new Date().toISOString();
  const job: StudioJob = { id: `job-${randomUUID()}`, kind, status: "running", stage: "Starting", progress: { done: 0, total: 1 }, owner: state.owner, createdAt: now, updatedAt: now };
  const persist = () => writePrivateJson(collectionFile("jobs", job.id), job);
  const update: Update = async (stage, done, total) => {
    job.stage = stage; job.updatedAt = new Date().toISOString();
    if (done !== undefined) job.progress.done = done;
    if (total !== undefined) job.progress.total = total;
    await persist();
  };
  try { await persist(); } catch (error) { state.busy = false; throw error; }
  // The task belongs to the server. Closing a browser observer does not abandon it.
  void execute(job, update).then(async (resultId) => {
    job.resultId = resultId;
    if (job.status === "running") { job.status = "completed"; job.progress.done = job.progress.total; }
    await update(job.status === "paused" ? job.stage : "Finished");
  }).catch(async (error: unknown) => {
    job.status = "failed";
    job.error = error instanceof Error ? error.message.slice(0, 600) : "The studio could not finish this task";
    await update("Could not finish").catch(() => undefined);
  }).finally(() => { state.busy = false; });
  return job;
}
export async function analyzeStudioImport(importId: string) {
  studioId(importId);
  const chunks = await studioStore.listChunks(importId);
  if (!chunks.length) throw new Error("This source has no readable messages");
  return startStudioJob("analyze", async (job, update) => {
    const file = collectionFile("analysis", importId);
    let completed: string[] = [];
    try { completed = (await readPrivateJson<{ completed: string[] }>(file)).completed; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const profiles = (await studioStore.read()).profiles.map((p) => ({ id: p.id, displayName: p.displayName, aliases: p.aliases }));
    let saved = 0;
    for (const chunk of chunks) {
      if (completed.includes(chunk.id)) continue;
      await update(`Reading message batch ${completed.length + 1} of ${chunks.length}`, completed.length, chunks.length);
      if ((await studioBudget.status()).remaining === 0) {
        job.status = "paused";
        await update(`Saved progress after ${completed.length} batches. Resume when the daily allowance resets.`);
        return importId;
      }
      const result = await agentStep("culture", { profiles, messages: chunk.messages }, update);
      const output = parseStudioJson(result.answer);
      if (!Array.isArray(output.memories) || output.memories.length > 12) throw new Error("The memory extractor returned an invalid batch");
      const validation = await studioStore.addMemories(importId, output.memories);
      if (validation.failures.length && !validation.accepted.length) throw new Error(`The extracted memories did not pass source checks: ${validation.failures[0].reason}`);
      saved += validation.accepted.length;
      completed.push(chunk.id);
      await writePrivateJson(file, { completed, updatedAt: new Date().toISOString(), lastRun: job.id, rejected: validation.failures });
      await update(`Saved ${saved} memories from ${completed.length} of ${chunks.length} batches`, completed.length, chunks.length);
    }
    return importId;
  });
}

function boundedString(value: unknown, max: number, label: string) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${label}`);
  return value.trim();
}
export function validateStudioBoard(value: Record<string, unknown>, allowed: { evidenceIds: Set<string>; memoryIds: Set<string>; memberIds: Set<string>; playerIds: Set<number> }) {
  const title = boundedString(value.title, 160, "episode title");
  if (!Array.isArray(value.scenes) || value.scenes.length < 1 || value.scenes.length > 4) throw new Error("An episode needs between one and four scenes");
  const seen = new Set<string>();
  const strings = (input: unknown, values: Set<string>, label: string) => {
    if (!Array.isArray(input) || input.length > 12 || input.some((id) => typeof id !== "string" || !values.has(id))) throw new Error(`Unknown ${label} in the episode`);
    return [...new Set(input)] as string[];
  };
  const scenes = value.scenes.map((raw: unknown): StudioScene => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid scene");
    const scene = raw as Record<string, unknown>;
    const id = studioId(scene.id);
    if (seen.has(id)) throw new Error("Duplicate scene identifier");
    seen.add(id);
    if (!["replay", "lineup", "result", "roast"].includes(String(scene.kind))) throw new Error("Unknown scene type");
    const evidenceIds = strings(scene.evidenceIds, allowed.evidenceIds, "football evidence");
    if (!evidenceIds.length) throw new Error("Every scene must cite football evidence");
    const memberIds = strings(scene.memberIds, allowed.memberIds, "league member");
    if (!Array.isArray(scene.playerIds) || scene.playerIds.some((id) => !Number.isInteger(id) || !allowed.playerIds.has(id))) throw new Error("Unknown player in the episode");
    const playerIds = [...new Set(scene.playerIds)] as number[];
    if (playerIds.length + memberIds.length < 1 || playerIds.length + memberIds.length > 6) throw new Error("A scene must include between one and six people");
    return { id, kind: scene.kind as StudioScene["kind"], title: boundedString(scene.title, 120, "scene title"),
      commentary: boundedString(scene.commentary, 1000, "commentary"), evidenceIds,
      memoryIds: strings(scene.memoryIds, allowed.memoryIds, "league memory"), memberIds, playerIds,
      imageBrief: boundedString(scene.imageBrief, 2400, "image direction") };
  });
  return { title, scenes };
}
export async function createStudioBoard(selection: { season: number; week: number; teamId: number; direction?: string }) {
  const { season, week, teamId } = selection;
  const context = await createAnalystContext(season, week, teamId);
  const seed = JSON.parse(context.initialEvidence);
  const { report } = await loadLeagueWeek(season, week);
  if (!report) throw new Error("That week's league evidence is unavailable");
  const studio = await studioStore.read();
  const memberIds = studio.profiles.filter((p) => [teamId, seed.matchup.opponent.id].includes(p.teamId)).map((p) => p.id);
  const culture = await studioStore.getContext(memberIds, selection.direction?.slice(0, 300), 8);
  const evidence: Record<string, unknown> = {
    [`matchup-${teamId}`]: seed.matchup,
    [`lineup-${teamId}`]: seed.best_lineup,
    "league-results": report.teams.map((team) => ({ id: team.id, name: team.name, score: team.score, opponentId: team.opponentId, final: team.final })),
  };
  const game = await context.call("get_game_moments", {}) as { moments?: { id: string }[]; lead?: unknown };
  for (const moment of game.moments ?? []) evidence[`play-${moment.id}`] = moment;
  if (game.lead) evidence["verified-feature-play"] = game.lead;
  const players = [...new Map(report.teams.filter((team) => [teamId, seed.matchup.opponent.id].includes(team.id)).flatMap((team) => team.players).map((p) => [p.id, { id: p.id, name: p.name }])).values()];
  const profiles = culture.profiles.map((profile) => ({ ...profile, background: profile.background.slice(0, 1000), roastNotes: profile.roastNotes.slice(0, 800), assets: undefined }));
  const packet = { season, week, teamId, direction: String(selection.direction || "").slice(0, 2000), evidence, profiles, memories: culture.memories, players };
  while (Buffer.byteLength(JSON.stringify(packet)) > 18_000 && packet.memories.length) packet.memories.pop();
  const allowed = boardAllowed(packet);
  return startStudioJob("storyboard", async (job, update) => {
    await update("Choosing stories from the matchup and league history", 0, 2);
    const producer = await agentStep("producer", packet, update, selection);
    const draft = validateStudioBoard(parseStudioJson(producer.answer), allowed);
    await writePrivateJson(path.join(studioDirectory(), "drafts", `${job.id}.json`), { packet, draft, producerRunId: producer.runId });
    job.resultId = job.id;
    await update("Checking the facts and editing the commentary", 1, 2);
    return finishStudioDraft({ packet, draft }, job, update, producer.runId);
  });
}
type DraftPacket = {
  season: number; week: number; teamId: number; direction: string; evidence: Record<string, unknown>;
  profiles: { id: string; background: string; roastNotes: string; avoidTopics: string[] }[];
  memories: NonNullable<StudioBoard["memories"]>; players: { id: number; name: string }[];
};
function boardAllowed(packet: DraftPacket) {
  return { evidenceIds: new Set(Object.keys(packet.evidence)), memoryIds: new Set(packet.memories.map((m) => m.id)), memberIds: new Set(packet.profiles.map((p) => p.id)), playerIds: new Set(packet.players.map((p) => p.id)) };
}
async function finishStudioDraft(saved: { packet: DraftPacket; draft: { title: string; scenes: StudioScene[] } }, job: StudioJob, update: Update, producerRunId?: string) {
  const { packet, draft } = saved;
  if ((await studioBudget.status()).remaining === 0) {
    job.status = "paused";
    await update("The scene plan is saved. Resume editing when the daily allowance resets.");
    return job.resultId;
  }
  const selectedEvidence = new Set(draft.scenes.flatMap((scene) => scene.evidenceIds));
  const selectedMemories = new Set(draft.scenes.flatMap((scene) => scene.memoryIds));
  const selectedPlayers = new Set(draft.scenes.flatMap((scene) => scene.playerIds));
  const editorPacket = { ...packet,
    evidence: Object.fromEntries(Object.entries(packet.evidence).filter(([id]) => selectedEvidence.has(id))),
    memories: packet.memories.filter((memory) => selectedMemories.has(memory.id)),
    players: packet.players.filter((player) => selectedPlayers.has(player.id)), draft };
  const edited = await agentStep("writer", editorPacket, update, packet);
  const board: StudioBoard = { id: `episode-${randomUUID()}`, ...validateStudioBoard(parseStudioJson(edited.answer), boardAllowed(packet)),
    season: packet.season, week: packet.week, teamId: packet.teamId, createdAt: new Date().toISOString(),
    model: process.env.FANTASY_STUDIO_WRITER_MODEL || "gpt-6-astra", evidence: packet.evidence,
    sourceIds: [...new Set(packet.memories.flatMap((memory) => memory.sourceIds))], memories: packet.memories,
    promptVersions: { producer: createHash("sha256").update(await prompt("producer")).digest("hex"), writer: createHash("sha256").update(await prompt("writer")).digest("hex") },
    runIds: [...(producerRunId ? [producerRunId] : []), edited.runId] };
  await writePrivateJson(collectionFile("boards", board.id), board);
  return board.id;
}
export async function resumeStudioDraft(jobId: string) {
  const saved = await readPrivateJson<{ packet: DraftPacket; draft: { title: string; scenes: StudioScene[] }; producerRunId?: string }>(path.join(studioDirectory(), "drafts", `${studioId(jobId)}.json`));
  validateStudioBoard(saved.draft, boardAllowed(saved.packet));
  return startStudioJob("storyboard", async (job, update) => {
    job.resultId = jobId;
    await update("Resuming the saved scene plan", 1, 2);
    return finishStudioDraft(saved, job, update, saved.producerRunId);
  });
}
export function assertSceneMemoriesCurrent(board: Pick<StudioBoard, "memories">, scene: Pick<StudioScene, "memoryIds">, current: StudioMemory[]) {
  for (const id of scene.memoryIds) {
    const saved = board.memories?.find((memory) => memory.id === id);
    const latest = current.find((memory) => memory.id === id && memory.enabled);
    if (!saved || !latest || saved.text !== latest.text || saved.confidence !== latest.confidence
      || JSON.stringify([...saved.sourceIds].sort()) !== JSON.stringify([...latest.sourceIds].sort())
      || JSON.stringify([...saved.memberIds].sort()) !== JSON.stringify([...latest.memberIds].sort())) {
      throw new Error("A memory used in this scene has changed or been turned off. Create a new episode before rendering it.");
    }
  }
}
export async function renderStudioBoardScene(boardId: string, sceneId: string) {
  const board = await readPrivateJson<StudioBoard>(collectionFile("boards", boardId));
  const scene = board.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error("That scene is unavailable");
  const current = await studioStore.read();
  const profiles = current.profiles;
  assertSceneMemoriesCurrent(board, scene, current.memories);
  // Missing identity references fail before an image allowance is reserved.
  await buildSceneReferences(board, scene, profiles);
  return startStudioJob("render", async (job, update) => {
    await update("Gathering the cast's reference photos", 0, 1);
    const preparedReferences = await prepareSceneReferences(board, scene, profiles);
    const runId = await imageBudget.reserve();
    job.imageRunId = runId;
    try {
      await update(`Composing the image with ${preparedReferences.length} reference photos`, 0, 1);
      const asset = await renderStudioScene({ client: studioClient(), board, scene, profiles, preparedReferences });
      scene.assetId = asset.id;
      await writePrivateJson(collectionFile("boards", boardId), board);
      await imageBudget.record(runId, { status: "completed" });
      return asset.id;
    } catch (error) {
      await imageBudget.record(runId, { status: "outcome_unconfirmed", errorCode: "image_failed" });
      throw error;
    } finally { await imageBudget.finish(runId, { noRemoteSessionCreated: true }); }
  });
}
export async function updateStudioScene(boardId: string, sceneId: string, changes: { commentary?: unknown; imageBrief?: unknown }) {
  if (state.busy) throw new Error("Wait for the current studio task before editing its scene");
  const board = await readPrivateJson<StudioBoard>(collectionFile("boards", boardId));
  const scene = board.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error("That scene is unavailable");
  if (changes.commentary !== undefined) scene.commentary = boundedString(changes.commentary, 1000, "commentary");
  if (changes.imageBrief !== undefined) scene.imageBrief = boundedString(changes.imageBrief, 2400, "image direction");
  delete scene.assetId;
  await writePrivateJson(collectionFile("boards", boardId), board);
  return board;
}
export async function studioSnapshot() {
  const [studio, assets, boards, jobs, league] = await Promise.all([
    studioStore.read(), listPrivateJson<StudioAsset>(path.join(studioDirectory(), "assets"), 500),
    listPrivateJson<StudioBoard>(path.join(studioDirectory(), "boards")), listPrivateJson<StudioJob>(path.join(studioDirectory(), "jobs")), loadLeagueWeek(2026, 1),
  ]);
  for (const job of jobs) {
    if (job.status !== "running" || job.owner === state.owner) continue;
    const pid = Number(job.owner.split(":")[0]);
    if (!Number.isInteger(pid) || pid < 1) continue;
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      job.status = "interrupted"; job.stage = "Interrupted by a server restart. Saved import progress can be resumed.";
      if (job.kind === "render" && job.imageRunId) {
        job.stage = "The server restarted during image generation. The result is unconfirmed; the request remains counted against the allowance.";
        const active = await imageBudget.activeReceipt();
        if (active?.runId === job.imageRunId) {
          await imageBudget.record(job.imageRunId, { status: "outcome_unconfirmed", errorCode: "server_restart" });
          await imageBudget.finish(job.imageRunId, { noRemoteSessionCreated: true });
        }
      }
      await writePrivateJson(collectionFile("jobs", job.id), job);
    }
  }
  if (process.env.OPENAI_API_KEY) await recoverPendingAnalystCleanup({ client: studioClient(), budget: studioBudget });
  return { state: studio, assets: assets.map(({ prompt: _prompt, ...asset }) => asset), boards, jobs,
    teams: league.report?.teams.map((team) => ({ id: team.id, name: team.name })) ?? [],
    players: [...new Map((league.report?.teams ?? []).flatMap((team) => team.players).map((p) => [p.id, { id: p.id, name: p.name }])).values()],
    limits: { text: await studioBudget.status(), images: await imageBudget.status() } };
}
