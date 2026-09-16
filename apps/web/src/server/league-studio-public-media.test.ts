import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { GET as getEpisode } from "../app/api/league/episode/route";
import { GET as getImage } from "../app/api/league/images/[id]/route";
import { GET as getPrivateImage } from "../app/api/studio/assets/[id]/route";
import { buildPublicLeagueMedia } from "./league-public-media";
import { collectionFile, saveStudioAsset, studioDirectory, writePrivateJson, type StudioBoard } from "./league-studio-core";
import type { LeagueWeek } from "@/lib/league-week";
import type { PhotoTemplate } from "@/types/studio-photos";
import type { StudioState } from "./league-studio-store";
import type { PublicLeagueEpisodeResponse } from "@/lib/league-media";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aioAAAAASUVORK5CYII=", "base64");
async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fantasy-public-media-"));
  const keys = ["DATA_ROOT", ...Object.keys(process.env).filter((key) => key.startsWith("FANTASY_DATA_ROOT__"))];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.DATA_ROOT = directory;
  t.after(async () => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } await fs.rm(directory, { recursive: true, force: true }); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Public media must not fetch or generate images"); });
  const profile = (id: string, teamId: number) => ({ id, teamId, displayName: id.toUpperCase(), aliases: ["SECRET_ALIAS"], background: "SECRET_BACKGROUND", roastNotes: "SECRET_ROAST", avoidTopics: ["SECRET_BOUNDARY"], assets: [] });
  const state: StudioState = { schema: 1, updatedAt: "2026-09-16", imports: [], memories: [], profiles: [profile("alpha", 8), profile("beta", 3), profile("gamma", 4), profile("delta", 9)] };
  await writePrivateJson(path.join(studioDirectory(), "state.json"), state);
  const source = await saveStudioAsset(png, { kind: "source-photo", label: "group.jpg" });
  const unknownSource = await saveStudioAsset(Buffer.concat([png, Buffer.from("2")]), { kind: "source-photo", label: "unlabeled.jpg" });
  const cutout = await saveStudioAsset(png, { kind: "cutout", label: "unassigned.png", referenceIds: [source.id] });
  const unrelated = await saveStudioAsset(png, { kind: "reference", playerId: 999, label: "unselected" });
  const generated = await saveStudioAsset(png, { kind: "generated", label: "Result", prompt: "SECRET_PROMPT", model: "SECRET_MODEL" });
  const photo: PhotoTemplate = { id: "group", filename: "group.jpg", sourceAssetId: source.id, width: 1000, height: 800,
    scene: "SECRET_PHOTO_SCENE", editNotes: "SECRET_EDIT_NOTES", visibleText: [], labels: [
      { memberId: "alpha", name: "ALPHA", position: "left", basis: "user_supplied" }, { memberId: "beta", name: "BETA", position: "right", basis: "user_supplied" },
    ], memes: [], cutouts: [{ assetId: cutout.id, filename: "unassigned.png", memberIds: [], createdAt: "2026-09-16" }], revision: 1, createdAt: "2026-09-16", updatedAt: "2026-09-16" };
  await writePrivateJson(path.join(studioDirectory(), "photos", "group.json"), photo);
  await writePrivateJson(path.join(studioDirectory(), "photos", "unknown.json"), { ...photo, id: "unknown", sourceAssetId: unknownSource.id, labels: [] });
  const cropFile = path.join(studioDirectory(), "display-crops.json");
  await writePrivateJson(cropFile, { version: 1, crops: [
    { memberId: "alpha", photoId: "group", crop: { x: 0, y: 0.1, width: 0.4, height: 0.5 } },
    { memberId: "beta", photoId: "group", crop: { x: 0.5, y: 0.1, width: 0.4, height: 0.5 } },
  ] });
  const report = { season: 2026, week: 1, teams: [{ id: 8, opponentId: 3, players: [{ id: 123, name: "Verified Player", position: "RB" }] },
    { id: 3, opponentId: 8, players: [] }, { id: 4, opponentId: 9, players: [] }, { id: 9, opponentId: 4, players: [] }] } as unknown as LeagueWeek;
  await writePrivateJson(path.join(directory, "out", "league", "2026", "week_1.json"), report);
  await fs.mkdir(path.join(directory, "out", "espn", "2026"), { recursive: true });
  await fs.writeFile(path.join(directory, "out", "espn", "2026", "teams.csv"), 'season,team_id,logo\n2026,8,https://a.espncdn.com/custom-alpha.png\n2026,4,https://a.espncdn.com/custom-gamma.png\n2026,9,javascript:alert(1)\n');
  const board: StudioBoard = { id: "public-board", title: "A saved episode", season: 2026, week: 1, teamId: 8, createdAt: "2026-09-16T00:00:00Z", model: "SECRET_MODEL",
    evidence: { secret: "SECRET_SOURCE_EVIDENCE" }, sourceIds: ["SECRET_SOURCE_ID"], scenes: [{ id: "result", kind: "result", title: "The score", commentary: "A finished fictional scene.",
      memberIds: ["alpha"], playerIds: [123], evidenceIds: ["SECRET_EVIDENCE_ID"], memoryIds: [], imageBrief: "SECRET_IMAGE_BRIEF", assetId: generated.id }] };
  await writePrivateJson(collectionFile("boards", board.id), board);
  const request = (teamId = 8) => new Request(`https://fantasy.example/api/league/episode?season=2026&week=1&teamId=${teamId}`);
  const image = (id: string, query = "season=2026&week=1", headers?: HeadersInit) => getImage(new Request(`https://fantasy.example/api/league/images/${id}?${query}`, { headers }), { params: Promise.resolve({ id }) });
  return { directory, state, source, unknownSource, cutout, unrelated, generated, photo, cropFile, report, board, request, image };
}

test("public episode exposes finished scenes and confirmed imagery without a session or source fields", async (t) => {
  const f = await fixture(t);
  const response = await getEpisode(f.request());
  assert.equal(response.status, 200);
  const body = await response.json() as PublicLeagueEpisodeResponse;
  assert.equal(body.episode?.id, f.board.id);
  assert.deepEqual(Object.keys(body.owners), ["3", "8"]);
  assert.deepEqual(body.teamImages[8][0].crop, { x: 0, y: 0.1, width: 0.4, height: 0.5 });
  assert.equal(body.teamImages[8][0].kind, "portrait");
  assert.deepEqual(body.teamImages[8][0].peopleNames, ["ALPHA"]);
  assert.equal(body.teamImages[8][0].imageWidth, 1000);
  assert.equal(body.teamImages[8][0].imageHeight, 800);
  assert.equal(body.teamImages[8][0].imageUrl, body.teamImages[3][0].imageUrl);
  assert.equal(body.teamImages[8][0].imageUrl.includes("teamId"), false);
  const serialized = JSON.stringify(body);
  for (const denied of ["SECRET_", "/api/studio/", "sourceAssetId", "photoId", "memberIds", "background", "editNotes", "referenceIds", "memoryIds", "evidenceIds", "prompt", "sourceIds"]) assert.equal(serialized.includes(denied), false, denied);
  assert.equal((await (await getEpisode(f.request(3))).json()).episode.id, body.episode?.id);
});

test("SSR media appends real custom team logos after owner imagery and uses logos alone when no confirmed photo exists", async (t) => {
  const f = await fixture(t);
  const media = await buildPublicLeagueMedia(f.report);
  assert.deepEqual(media.teamImages[4], [{ teamId: 4, imageUrl: "https://a.espncdn.com/custom-gamma.png", kind: "team-logo", peopleNames: [] }]);
  assert.deepEqual(media.teamImages[9], []);
  assert.deepEqual(media.owners[4], [{ id: "gamma", name: "GAMMA", kind: "member" }]);
  assert.deepEqual(media.teamImages[8].map((image) => image.kind), ["portrait", "team-logo"]);
  assert.equal(media.teamImages[8][1].imageUrl, "https://a.espncdn.com/custom-alpha.png");
});

test("public image bytes require selection by the current league view; private and unassigned assets stay unavailable", async (t) => {
  const f = await fixture(t);
  for (const id of [f.source.id, f.generated.id]) {
    const response = await f.image(id);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(png));
    const cached = await f.image(id, "season=2026&week=1", { "if-none-match": `"${id}"` });
    assert.equal(cached.status, 304);
  }
  for (const id of [f.unknownSource.id, f.cutout.id, f.unrelated.id, "../state"]) assert.equal((await f.image(id)).status, 404);
  assert.equal((await f.image(f.source.id, "season=2026&week=2")).status, 404);
  assert.equal((await f.image(f.source.id, "season=../../private&week=1")).status, 404);
  assert.equal((await getPrivateImage(new Request("https://fantasy.example/api/studio/assets/test"), { params: Promise.resolve({ id: f.source.id }) })).status, 401);
});

test("crop framing requires explicit matching labels and valid bounds; a two-person photo retains both names", async (t) => {
  const f = await fixture(t);
  await writePrivateJson(f.cropFile, { version: 1, crops: [
    { memberId: "gamma", photoId: "group", crop: { x: 0, y: 0, width: 0.4, height: 0.5 } },
    { memberId: "beta", photoId: "group", crop: { x: 0.9, y: 0, width: 0.4, height: 0.5 } },
    { memberId: "alpha", photoId: "group", kind: "photo", peopleNames: ["ALPHA", "BETA"], crop: { x: 0, y: 0, width: 1, height: 1 } },
  ] });
  const media = await buildPublicLeagueMedia(f.report);
  assert.equal(media.teamImages[4][0].kind, "team-logo");
  assert.equal(media.teamImages[3][0].crop, undefined);
  assert.equal(media.teamImages[8][0].kind, "photo");
  assert.deepEqual(media.teamImages[8][0].peopleNames, ["ALPHA", "BETA"]);
});

test("disabled memories remove the public episode and revoke its generated asset", async (t) => {
  const f = await fixture(t);
  f.board.memories = [{ id: "mem-one", text: "Saved context", sourceIds: ["source-one"], memberIds: ["alpha"], confidence: "explicit" }];
  f.board.scenes[0].memoryIds = ["mem-one"];
  await writePrivateJson(collectionFile("boards", f.board.id), f.board);
  assert.equal((await (await getEpisode(f.request())).json()).episode, null);
  assert.equal((await f.image(f.generated.id)).status, 404);
  assert.equal((await f.image(f.source.id)).status, 200);
});
