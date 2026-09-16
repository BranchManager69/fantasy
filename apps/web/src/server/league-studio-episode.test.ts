import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { GET as getEpisode } from "../app/api/studio/episode/route";
import { GET as getSession } from "../app/api/studio/session/route";
import { createStudioSession, STUDIO_COOKIE } from "./league-studio-auth";
import { savedStudioEpisode } from "./league-studio-episode";
import { collectionFile, saveStudioAsset, studioDirectory, writePrivateJson, type StudioBoard, type StudioScene } from "./league-studio-core";
import type { StudioEpisodeResponse } from "@/lib/studio-episode";
import type { StudioMemory, StudioState } from "./league-studio-store";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aioAAAAASUVORK5CYII=", "base64");
const selection = { season: 2026, week: 1, teamId: 8 };

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fantasy-studio-episode-"));
  const keys = ["DATA_ROOT", "FANTASY_STUDIO_TOKEN", ...Object.keys(process.env).filter((key) => key.startsWith("FANTASY_DATA_ROOT__"))];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.DATA_ROOT = directory;
  process.env.FANTASY_STUDIO_TOKEN = "synthetic-studio-episode-test-token-123456789";
  t.after(async () => {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await fs.rm(directory, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Viewing an episode must not call the network"); });
  const portrait = await saveStudioAsset(png, { kind: "portrait", memberId: "alex", label: "Alex" });
  const playerPortrait = await saveStudioAsset(png, { kind: "reference", playerId: 123, label: "Verified Player" });
  const generated = await saveStudioAsset(png, { kind: "generated", label: "Scene", prompt: "PRIVATE_IMAGE_PROMPT", model: "PRIVATE_MODEL", referenceIds: [portrait.id, playerPortrait.id] });
  const memory: StudioMemory = { id: "mem-private", kind: "running_joke", text: "PRIVATE_MEMORY_SOURCE", memberIds: ["alex"], sourceIds: ["source-private"], confidence: "explicit", enabled: true,
    importId: "PRIVATE_IMPORT_ID", createdAt: "2026-09-16T00:00:00Z", updatedAt: "2026-09-16T00:00:00Z" };
  const state: StudioState = { schema: 1, updatedAt: "2026-09-16T00:00:00Z", imports: [], memories: [memory], profiles: [{ id: "alex", displayName: "Alex", teamId: 8, aliases: ["PRIVATE_ALIAS"], background: "PRIVATE_BACKGROUND", roastNotes: "PRIVATE_ROAST_NOTES", avoidTopics: ["PRIVATE_BOUNDARY"], assets: [{ id: portrait.id, kind: "portrait" }] }] };
  const scene: StudioScene = { id: "scene-one", kind: "result", title: "The result", commentary: "Alex left the good points on the bench.", memberIds: ["alex"], playerIds: [123], evidenceIds: ["PRIVATE_EVIDENCE_ID"], memoryIds: [memory.id], imageBrief: "PRIVATE_IMAGE_BRIEF", assetId: generated.id };
  const board: StudioBoard = { id: "board-latest", title: "Week one", ...selection, createdAt: "2026-09-16T02:00:00Z", model: "PRIVATE_MODEL", scenes: [scene], evidence: { PRIVATE_EVIDENCE: true }, sourceIds: ["source-private"], memories: [{ ...memory }] };
  const league = path.join(directory, "out", "league", "2026");
  await fs.mkdir(league, { recursive: true });
  await fs.writeFile(path.join(league, "week_1.json"), JSON.stringify({ season: 2026, week: 1, teams: [
    { id: 8, opponentId: 14, players: [{ id: 123, name: "Verified Player", position: "RB" }] },
    { id: 14, opponentId: 8, players: [] }, { id: 99, opponentId: 100, players: [] },
  ] }));
  const saveState = () => writePrivateJson(path.join(studioDirectory(), "state.json"), state);
  const saveBoard = () => writePrivateJson(collectionFile("boards", board.id), board);
  await saveState(); await saveBoard();
  const cookie = await createStudioSession(process.env.FANTASY_STUDIO_TOKEN);
  const request = (query = "season=2026&week=1&teamId=8", authorized = true) => new Request(`https://fantasy.example/api/studio/episode?${query}`, {
    headers: authorized ? { cookie: `${STUDIO_COOKIE}=${cookie}` } : {},
  });
  const owners = { "8": [{ id: "alex", name: "Alex", kind: "member", portraitUrl: `/api/studio/assets/${portrait.id}` }], "14": [] };
  return { directory, board, scene, state, memory, portrait, playerPortrait, generated, saveBoard, saveState, request, owners };
}

test("episode GET requires authentication before inspecting selection or private state", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(studioDirectory(), "state.json"), "PRIVATE_CORRUPT_STATE");
  for (const query of ["season=2026&week=1&teamId=8", "teamId=../../secret"]) {
    const response = await getEpisode(f.request(query, false));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { error: "Sign in to view saved episodes" });
  }
});

test("latest matching episode projects display fields only and supports the opponent selection", async (t) => {
  const f = await fixture(t);
  f.board.teamId = 14;
  await f.saveBoard();
  await writePrivateJson(collectionFile("boards", "older"), { ...f.board, id: "older", teamId: 8, createdAt: "2026-09-16T01:00:00Z" });
  await writePrivateJson(collectionFile("boards", "unrelated"), { ...f.board, id: "unrelated", teamId: 99, createdAt: "2026-09-16T03:00:00Z" });
  await writePrivateJson(collectionFile("boards", "other-week"), { ...f.board, id: "other-week", week: 2, createdAt: "2026-09-16T04:00:00Z" });
  const response = await getEpisode(f.request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json() as StudioEpisodeResponse;
  assert.deepEqual(body, { episode: { id: f.board.id, title: "Week one", season: 2026, week: 1, teamId: 14, createdAt: f.board.createdAt,
    scenes: [{ id: f.scene.id, kind: "result", title: f.scene.title, commentary: f.scene.commentary,
      assetUrl: `/api/studio/assets/${f.generated.id}`, cast: [
        { id: "alex", name: "Alex", kind: "member", portraitUrl: `/api/studio/assets/${f.portrait.id}` },
        { id: "123", name: "Verified Player", kind: "player", portraitUrl: `/api/studio/assets/${f.playerPortrait.id}` },
      ] }] }, owners: f.owners });
  const serialized = JSON.stringify(body);
  for (const secret of ["PRIVATE_", "source-private", "mem-private", "memoryIds", "evidenceIds", "referenceIds", "prompt", "background"]) assert.equal(serialized.includes(secret), false, secret);
});

test("disabled, missing, or changed memories hide affected scenes and yield null when none remain", async (t) => {
  const f = await fixture(t);
  const safe: StudioScene = { ...f.scene, id: "safe-scene", memoryIds: [], commentary: "The official score is final." };
  f.board.scenes.push(safe);
  await f.saveBoard();
  const changes: Partial<StudioMemory>[] = [{ enabled: false }, { text: "A correction" }, { sourceIds: ["changed-source"] }, { memberIds: ["someone-else"] }, { confidence: "inferred" }];
  for (const change of changes) {
    f.state.memories = [{ ...f.memory, ...change }];
    await f.saveState();
    const result = await savedStudioEpisode(selection);
    assert.deepEqual(result.episode?.scenes.map((scene) => scene.id), ["safe-scene"]);
  }
  f.state.memories = [];
  await f.saveState();
  f.board.scenes = [f.scene];
  await f.saveBoard();
  assert.deepEqual(await savedStudioEpisode(selection), { episode: null, owners: f.owners });
});

test("image URLs require readable generated assets and portraits must match their person", async (t) => {
  const f = await fixture(t);
  const other = await saveStudioAsset(png, { kind: "portrait", memberId: "other", label: "Wrong face" });
  f.state.profiles[0].assets = [{ id: other.id, kind: "portrait" }];
  await f.saveState();
  await fs.unlink(path.join(studioDirectory(), "images", f.portrait.id));
  f.scene.assetId = other.id;
  await f.saveBoard();
  let result = await savedStudioEpisode(selection);
  assert.equal(result.episode?.scenes[0].assetUrl, undefined);
  assert.equal(result.episode?.scenes[0].cast[0].portraitUrl, undefined);
  f.scene.assetId = f.generated.id;
  await f.saveBoard();
  await fs.writeFile(path.join(studioDirectory(), "images", f.generated.id), "<svg>invalid</svg>");
  result = await savedStudioEpisode(selection);
  assert.equal(result.episode?.scenes[0].assetUrl, undefined);
  f.scene.assetId = "../../private";
  await f.saveBoard();
  assert.equal((await savedStudioEpisode(selection)).episode?.scenes[0].assetUrl, undefined);
});

test("unknown cast and unmatched selections never expose a saved scene", async (t) => {
  const f = await fixture(t);
  f.scene.memberIds = ["removed-member"];
  await f.saveBoard();
  assert.deepEqual(await savedStudioEpisode(selection), { episode: null, owners: f.owners });
  f.scene.memberIds = ["alex"];
  f.scene.playerIds = [99999];
  await f.saveBoard();
  assert.deepEqual(await savedStudioEpisode(selection), { episode: null, owners: f.owners });
  assert.deepEqual(await savedStudioEpisode({ ...selection, teamId: 1234 }), { episode: null, owners: {} });
  assert.deepEqual(await savedStudioEpisode({ ...selection, week: 2 }), { episode: null, owners: {} });
});

test("episode GET validates its query and hides storage error details", async (t) => {
  const f = await fixture(t);
  for (const query of ["", "season=2026&week=0&teamId=8", "season=2026&week=1&teamId=-8", "season=2026&week=1&teamId=8.5", "season=2026&week=1&teamId=../../secret"]) {
    assert.equal((await getEpisode(f.request(query))).status, 400);
  }
  await fs.writeFile(path.join(studioDirectory(), "state.json"), "PRIVATE_CORRUPT_STATE");
  const response = await getEpisode(f.request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Saved episodes are temporarily unavailable" });
});

test("session GET always returns only a no-store authorization boolean", async (t) => {
  const f = await fixture(t);
  for (const authorized of [false, true]) {
    const response = await getSession(f.request(undefined, authorized));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { authorized });
  }
  const response = await getSession(new Request("https://fantasy.example/api/studio/session", { headers: { cookie: `${STUDIO_COOKIE}=invalid` } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authorized: false });
});

test("owner portraits are available before an episode and include only the selected matchup's assigned images", async (t) => {
  const f = await fixture(t);
  await fs.unlink(collectionFile("boards", f.board.id));
  const robin = await saveStudioAsset(png, { kind: "portrait", memberId: "robin", label: "Robin" });
  f.state.profiles.push({ ...f.state.profiles[0], id: "robin", displayName: "Robin", teamId: 14, assets: [{ id: robin.id, kind: "portrait" }] },
    { ...f.state.profiles[0], id: "outsider", displayName: "PRIVATE_UNRELATED_OWNER", teamId: 99 });
  // An unassigned matching image in the asset library must not become an owner's chosen portrait.
  f.state.profiles[0].assets = [];
  await f.saveState();
  let response = await getEpisode(f.request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { episode: null, owners: {
    "8": [{ id: "alex", name: "Alex", kind: "member" }],
    "14": [{ id: "robin", name: "Robin", kind: "member", portraitUrl: `/api/studio/assets/${robin.id}` }],
  } });
  f.state.profiles[0].assets = [{ id: robin.id, kind: "portrait" }];
  await f.saveState();
  response = await getEpisode(f.request());
  const body = await response.json() as StudioEpisodeResponse;
  assert.equal(body.owners["8"][0].portraitUrl, undefined);
  assert.deepEqual(Object.keys(body.owners), ["8", "14"]);
  assert.equal(JSON.stringify(body).includes("PRIVATE_"), false);
});

test("verified positive roster players get a fixed ESPN portrait fallback without fetching", async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(studioDirectory(), "images", f.playerPortrait.id));
  const result = await savedStudioEpisode(selection);
  assert.equal(result.episode?.scenes[0].cast.find((member) => member.kind === "player")?.portraitUrl,
    "https://a.espncdn.com/i/headshots/nfl/players/full/123.png");
  for (const id of [0, -1, 456, "https://example.com/evil" as unknown as number]) {
    f.scene.playerIds = [id];
    await f.saveBoard();
    assert.equal((await savedStudioEpisode(selection)).episode, null);
  }
});
