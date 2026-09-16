import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type OpenAI from "openai";
import { buildSceneReferences, prepareSceneReferences, renderStudioScene } from "./league-studio-media";
import { readStudioAsset, saveStudioAsset, type StudioBoard, type StudioScene } from "./league-studio-core";
import type { StudioProfile } from "./league-studio-store";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aioAAAAASUVORK5CYII=", "base64");

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fantasy-studio-media-"));
  const keys = ["DATA_ROOT", "FANTASY_REPO_ROOT", "FANTASY_STUDIO_IMAGE_MODEL", ...Object.keys(process.env).filter((key) => key.startsWith("FANTASY_DATA_ROOT__"))];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.DATA_ROOT = directory;
  process.env.FANTASY_REPO_ROOT = path.resolve(process.cwd(), "../..");
  t.after(async () => {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await fs.rm(directory, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  const profile: StudioProfile = { id: "alex", teamId: 1, displayName: "Alex", aliases: [], background: "An amateur chef", roastNotes: "Bench decisions", avoidTopics: ["family"] };
  const scene: StudioScene = { id: "scene-1", kind: "roast", title: "The bench feast", commentary: "The best meal stayed on the bench.",
    memberIds: ["alex"], playerIds: [], evidenceIds: ["lineup-1"], memoryIds: [], imageBrief: "Alex holds an empty plate beside a bench full of food." };
  const board: StudioBoard = { id: "board-1", title: "Week one", season: 2026, week: 1, teamId: 1, createdAt: "2026-09-16T00:00:00Z", model: "test",
    scenes: [scene], evidence: { "lineup-1": { actual: 92, optimal: 111 }, unrelated: "x".repeat(40_000) }, sourceIds: [] };
  const league = path.join(directory, "out", "league", "2026");
  await fs.mkdir(league, { recursive: true });
  await fs.writeFile(path.join(league, "week_1.json"), JSON.stringify({ season: 2026, week: 1, teams: [{ id: 1, players: [{ id: 123, name: "Verified Player", position: "QB" }] }] }));
  const portrait = async () => {
    const asset = await saveStudioAsset(png, { kind: "portrait", memberId: profile.id, label: "Alex portrait" });
    profile.assets = [{ id: asset.id, kind: "portrait" }];
    return asset;
  };
  return { directory, profile, profiles: [profile], board, scene, portrait };
}

function fakeClient(edit: (...args: any[]) => Promise<unknown>) {
  return { images: { edit } } as unknown as OpenAI;
}

test("a missing GM portrait blocks both player download and the paid image request", async (t) => {
  const f = await fixture(t);
  f.scene.playerIds = [123];
  let calls = 0;
  await assert.rejects(renderStudioScene({ ...f, client: fakeClient(async () => { calls++; }) }), /matching portrait for Alex/);
  assert.equal(calls, 0);
});

test("cast validation rejects unknown members, path identifiers, unverified players, and excess cast", async (t) => {
  const f = await fixture(t);
  await f.portrait();
  f.scene.memberIds = ["other"];
  await assert.rejects(buildSceneReferences(f.board, f.scene, f.profiles), /unknown GM/);
  f.scene.memberIds = ["../alex"];
  await assert.rejects(buildSceneReferences(f.board, f.scene, f.profiles), /Invalid studio identifier/);
  f.scene.memberIds = ["alex"];
  f.scene.playerIds = [456];
  await assert.rejects(buildSceneReferences(f.board, f.scene, f.profiles), /not in the cached/);
  f.scene.playerIds = ["https://example.com/evil" as unknown as number];
  await assert.rejects(buildSceneReferences(f.board, f.scene, f.profiles), /Invalid NFL player identifier/);
  f.scene.playerIds = Array.from({ length: 8 }, (_, i) => i + 1);
  await assert.rejects(buildSceneReferences(f.board, f.scene, f.profiles), /at most eight/);
});

test("asset assignments must match their GM and reusable library portraits need no duplicate upload", async (t) => {
  const f = await fixture(t);
  const own = await f.portrait();
  f.profile.assets = [];
  assert.equal((await prepareSceneReferences(f.board, f.scene, f.profiles))[0].asset.id, own.id);
  const other = await saveStudioAsset(png, { kind: "portrait", memberId: "sam", label: "Sam" });
  f.profile.assets = [{ id: other.id, kind: "portrait" }];
  await assert.rejects(prepareSceneReferences(f.board, f.scene, f.profiles), /does not match that GM/);
  f.profile.assets = [{ id: "../secret", kind: "portrait" }];
  await assert.rejects(prepareSceneReferences(f.board, f.scene, f.profiles), /Invalid studio identifier/);
});

test("verified player headshots use the fixed endpoint, reject redirects, and are cached", async (t) => {
  const f = await fixture(t);
  await f.portrait();
  f.scene.playerIds = [123];
  const fetchMock = t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(url, "https://a.espncdn.com/i/headshots/nfl/players/full/123.png");
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal instanceof AbortSignal);
    return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } });
  });
  const references = await prepareSceneReferences(f.board, f.scene, f.profiles);
  assert.equal(references.length, 2);
  assert.match(references[1].identity, /Verified Player/);
  assert.equal(references[1].asset.playerId, 123);
  assert.equal(references[1].asset.sourceUrl, "https://a.espncdn.com/i/headshots/nfl/players/full/123.png");
  assert.ok(references[1].bytes.equals(png));
  assert.deepEqual((await prepareSceneReferences(f.board, f.scene, f.profiles)).map((ref) => ref.asset.id), references.map((ref) => ref.asset.id));
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("headshots enforce MIME, signature, and download bounds without following alternative URLs", async (t) => {
  const f = await fixture(t);
  f.scene.memberIds = [];
  f.scene.playerIds = [123];
  let response = new Response("<html>not an image</html>", { headers: { "content-type": "text/html" } });
  t.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(prepareSceneReferences(f.board, f.scene, f.profiles), /did not return an image/);
  response = new Response(png, { headers: { "content-type": "image/jpeg" } });
  await assert.rejects(prepareSceneReferences(f.board, f.scene, f.profiles), /does not match its contents/);
  response = new Response(png, { headers: { "content-type": "image/png", "content-length": String(8 * 1024 * 1024 + 1) } });
  await assert.rejects(prepareSceneReferences(f.board, f.scene, f.profiles), /8 MB/);
  response = new Response(Buffer.alloc(8 * 1024 * 1024 + 1), { headers: { "content-type": "image/png" } });
  await assert.rejects(prepareSceneReferences(f.board, f.scene, f.profiles), /8 MB/);
  response = new Response(png, { headers: { "content-type": "image/png" } });
  Object.defineProperty(response, "redirected", { value: true });
  await assert.rejects(prepareSceneReferences(f.board, f.scene, f.profiles), /could not be loaded/);
});

test("render sends every reference as an image file and saves its complete input manifest", async (t) => {
  const f = await fixture(t);
  await f.portrait();
  f.scene.playerIds = [123];
  await saveStudioAsset(png, { kind: "reference", playerId: 123, label: "Verified Player" });
  const references = await prepareSceneReferences(f.board, f.scene, f.profiles);
  let calls = 0;
  let capturedPrompt = "";
  const client = fakeClient(async (input, options) => {
    calls++;
    assert.equal(input.model, "gpt-image-2.5-sunburst");
    assert.equal(input.n, 1);
    assert.equal(input.size, "1536x1024");
    assert.equal(input.quality, "medium");
    assert.equal(input.output_format, "webp");
    assert.equal("input_fidelity" in input, false);
    assert.equal(options.maxRetries, 0);
    assert.equal(options.timeout, 180_000);
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(Array.isArray(input.image));
    assert.equal(input.image.length, 2);
    for (const image of input.image) {
      assert.ok(image instanceof File);
      assert.equal(image.type, "image/png");
      assert.ok(Buffer.from(await image.arrayBuffer()).equals(png));
    }
    capturedPrompt = input.prompt;
    assert.match(input.prompt, /Fictional league scene/);
    assert.match(input.prompt, /"image":1,"identity":"GM: Alex/);
    assert.match(input.prompt, /"image":2,"identity":"NFL player: Verified Player/);
    assert.match(input.prompt, /"avoidTopics":\["family"\]/);
    assert.match(input.prompt, /"optimal":111/);
    assert.equal(input.prompt.includes('"unrelated":'), false);
    return { data: [{ b64_json: png.toString("base64") }] };
  });
  const result = await renderStudioScene({ ...f, client, preparedReferences: references, onProgress: () => { throw new Error("Client disconnected"); } });
  assert.equal(calls, 1);
  assert.equal(result.kind, "generated");
  assert.deepEqual(result.referenceIds, references.map((reference) => reference.asset.id));
  assert.equal(result.prompt, capturedPrompt);
  assert.equal(result.model, "gpt-image-2.5-sunburst");
  assert.ok((await readStudioAsset(result.id)).bytes.equals(png));
});

test("prepared references cannot omit cast members or substitute other image bytes", async (t) => {
  const f = await fixture(t);
  await f.portrait();
  const references = await prepareSceneReferences(f.board, f.scene, f.profiles);
  let calls = 0;
  const client = fakeClient(async () => { calls++; });
  await assert.rejects(renderStudioScene({ ...f, client, preparedReferences: [] }), /Every cast member/);
  await assert.rejects(renderStudioScene({ ...f, client, preparedReferences: [{ ...references[0], bytes: Buffer.from("replacement") }] }), /does not match/);
  assert.equal(calls, 0);
});

test("render validates response bytes and never follows an output URL", async (t) => {
  const f = await fixture(t);
  await f.portrait();
  for (const data of [
    [{ url: "https://example.com/image.png" }],
    [{ b64_json: "invalid=" }],
    [{ b64_json: Buffer.from("<html>not an image</html>").toString("base64") }],
    [{ b64_json: png.toString("base64") }, { b64_json: png.toString("base64") }],
  ]) await assert.rejects(renderStudioScene({ ...f, client: fakeClient(async () => ({ data })) }), /image|PNG/);
});

test("a provider error surfaces from one attempt and configurable models retain image editing", async (t) => {
  const f = await fixture(t);
  await f.portrait();
  process.env.FANTASY_STUDIO_IMAGE_MODEL = "configured-image-model";
  let calls = 0;
  const client = fakeClient(async (input) => { calls++; assert.equal(input.model, "configured-image-model"); throw new Error("Provider rejected this request"); });
  await assert.rejects(renderStudioScene({ ...f, client }), /Provider rejected/);
  assert.equal(calls, 1);
});

test("render includes only selected memories with source IDs, named members, and unchanged confidence", async (t) => {
  const f = await fixture(t);
  await f.portrait();
  f.scene.memoryIds = ["mem-chef", "mem-bench"];
  f.board.sourceIds = ["source-message-1", "source-message-2", "source-message-3"];
  f.board.memories = [
    { id: "mem-chef", text: "Alex described making a feast for draft night.", memberIds: ["alex"], sourceIds: ["source-message-1"], confidence: "explicit" },
    { id: "mem-bench", text: "The group may associate Alex with saving the best meal for later.", memberIds: ["alex"], sourceIds: ["source-message-2"], confidence: "inferred" },
    { id: "mem-unselected", text: "UNSELECTED PRIVATE DETAIL", memberIds: ["alex"], sourceIds: ["source-message-3"], confidence: "explicit" },
  ];
  let calls = 0;
  const client = fakeClient(async (input) => {
    calls++;
    const data = JSON.parse(input.prompt.split("\nSCENE_DATA_JSON\n")[1].split("\nEND_SCENE_DATA_JSON")[0]);
    assert.deepEqual(data.suppliedMemories, f.board.memories!.slice(0, 2));
    assert.equal(input.prompt.includes("UNSELECTED PRIVATE DETAIL"), false);
    assert.equal(input.prompt.includes("source-message-3"), false);
    assert.match(input.prompt, /inferred memory.*cannot establish a person's biography/);
    assert.match(input.prompt, /do not reconstruct it from its ID or commentary/);
    assert.equal(input.prompt.includes(f.profile.background), false);
    return { data: [{ b64_json: png.toString("base64") }] };
  });
  const image = await renderStudioScene({ ...f, client });
  assert.equal(calls, 1);
  assert.match(image.prompt!, /source-message-1/);
});

test("missing or unverified scene memories block preparation and paid rendering", async (t) => {
  const f = await fixture(t);
  await f.portrait();
  f.scene.memoryIds = ["mem-chef"];
  f.board.sourceIds = ["source-message-1"];
  await assert.rejects(buildSceneReferences(f.board, f.scene, f.profiles), /memory cited.*unavailable/);
  const memory = { id: "mem-chef", text: "Alex cooks.", memberIds: ["alex"], sourceIds: ["uncited-message"], confidence: "explicit" };
  f.board.memories = [memory];
  let calls = 0;
  const client = fakeClient(async () => { calls++; });
  await assert.rejects(renderStudioScene({ ...f, client }), /valid source references or confidence/);
  memory.sourceIds = [];
  await assert.rejects(buildSceneReferences(f.board, f.scene, f.profiles), /valid source references or confidence/);
  memory.sourceIds = ["source-message-1"];
  memory.confidence = "certain";
  await assert.rejects(buildSceneReferences(f.board, f.scene, f.profiles), /valid source references or confidence/);
  memory.confidence = "explicit";
  f.board.memories.push({ ...memory });
  await assert.rejects(buildSceneReferences(f.board, f.scene, f.profiles), /memory cited.*unavailable/);
  assert.equal(calls, 0);
});

test("scene memory bounds reject excessive context without silently truncating the source meaning", async (t) => {
  const f = await fixture(t);
  await f.portrait();
  f.board.sourceIds = ["source-message-1"];
  f.board.memories = Array.from({ length: 5 }, (_, index) => ({ id: `mem-${index}`, text: "x".repeat(2900),
    memberIds: ["alex"], sourceIds: ["source-message-1"], confidence: "explicit" }));
  f.scene.memoryIds = f.board.memories.map((memory) => memory.id);
  await assert.rejects(prepareSceneReferences(f.board, f.scene, f.profiles), /too much league history/);
  assert.equal(f.board.memories[0].text.length, 2900);
  f.scene.memoryIds = ["mem-0", "mem-0"];
  await assert.rejects(prepareSceneReferences(f.board, f.scene, f.profiles), /invalid list of league memories/);
});
