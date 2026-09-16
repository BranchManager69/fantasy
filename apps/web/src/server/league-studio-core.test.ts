import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRequestJson, studioId, imageMime, writePrivateJson, readPrivateJson } from "./league-studio-core";
import { createStudioSession, studioAuthorized, sameOrigin, STUDIO_COOKIE } from "./league-studio-auth";
import { validateStudioBoard, assertSceneMemoriesCurrent } from "./league-studio-service";

test("studio access requires a signed, unexpired session and matching origin", async () => {
  const previous = process.env.FANTASY_STUDIO_TOKEN;
  process.env.FANTASY_STUDIO_TOKEN = "synthetic-studio-test-token-not-a-provider-key-123456789";
  try {
    const now = Date.now();
    const cookie = await createStudioSession(process.env.FANTASY_STUDIO_TOKEN, now);
    const request = (value: string) => new Request("https://fantasy.example/api/studio", { headers: { cookie: `${STUDIO_COOKIE}=${value}` } });
    assert.equal(await studioAuthorized(request(cookie), now), true);
    assert.equal(await studioAuthorized(request(cookie), now + 8 * 86400_000), false);
    assert.equal(await studioAuthorized(request(`${cookie}x`), now), false);
    assert.equal(await studioAuthorized(new Request("https://fantasy.example/api/studio"), now), false);
    await assert.rejects(createStudioSession("wrong-token", now));
    assert.equal(sameOrigin(new Request("https://fantasy.example/api/studio", { headers: { origin: "https://attacker.example" } })), false);
    assert.equal(sameOrigin(new Request("https://fantasy.example/api/studio", { headers: { origin: "https://fantasy.example" } })), true);
  } finally { if (previous === undefined) delete process.env.FANTASY_STUDIO_TOKEN; else process.env.FANTASY_STUDIO_TOKEN = previous; }
});
test("private file writes preserve restricted permissions and reject symlinks", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "fantasy-studio-core-"));
  try {
    const file = path.join(folder, "nested", "source.json");
    await writePrivateJson(file, { synthetic: true });
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readPrivateJson(file), { synthetic: true });
    await fs.symlink(file, path.join(folder, "link.json"));
    await assert.rejects(readPrivateJson(path.join(folder, "link.json")));
    await assert.rejects(readPrivateJson(file, 1));
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});
test("studio requests and asset identifiers cannot escape their limits", async () => {
  assert.throws(() => studioId("../../private-file"));
  assert.throws(() => studioId("a/b"));
  assert.equal(studioId("asset-123"), "asset-123");
  assert.throws(() => imageMime(Buffer.from("<svg onload=alert(1)>")));
  assert.throws(() => imageMime(Buffer.from("<script>alert(1)</script>")));
  await assert.rejects(readRequestJson(new Request("https://example.test", { method: "POST", body: JSON.stringify({ text: "x".repeat(100) }) }), 20));
  assert.deepEqual(await readRequestJson(new Request("https://example.test", { method: "POST", body: '{"action":"profile"}' }), 100), { action: "profile" });
});
test("scene validation rejects invented facts, people, memory and player IDs", () => {
  const allowed = { evidenceIds: new Set(["matchup-8"]), memoryIds: new Set(["mem-1"]), memberIds: new Set(["test-gm"]), playerIds: new Set([4567048]) };
  const scene = { id: "finish", kind: "result", title: "The result", commentary: "The recorded result.", evidenceIds: ["matchup-8"], memoryIds: [], memberIds: ["test-gm"], playerIds: [4567048], imageBrief: "Fictional illustration using the supplied reference people." };
  assert.equal(validateStudioBoard({ title: "Test", scenes: [scene] }, allowed).scenes.length, 1);
  for (const change of [{ evidenceIds: [] }, { evidenceIds: ["made-up"] }, { memberIds: ["unknown-owner"] }, { memoryIds: ["invented-joke"] }, { playerIds: [123] }, { memberIds: [], playerIds: [] }]) {
    assert.throws(() => validateStudioBoard({ title: "Test", scenes: [{ ...scene, ...change }] }, allowed));
  }
  assert.throws(() => validateStudioBoard({ title: "Test", scenes: [scene, scene] }, allowed));
});
test("rendering refuses memories edited or disabled after an episode was written", () => {
  const memory = { id: "mem-1", kind: "running_joke" as const, text: "The spreadsheet", sourceIds: ["message-1"], memberIds: ["test-gm"], confidence: "explicit" as const, enabled: true, importId: "src-1", createdAt: "2026-09-16", updatedAt: "2026-09-16" };
  const scene = { memoryIds: [memory.id] };
  const board = { memories: [memory] };
  assert.doesNotThrow(() => assertSceneMemoriesCurrent(board, scene, [memory]));
  for (const change of [{ enabled: false }, { text: "Revised context" }, { sourceIds: ["message-2"] }, { memberIds: ["other-gm"] }, { confidence: "inferred" as const }]) {
    assert.throws(() => assertSceneMemoriesCurrent(board, scene, [{ ...memory, ...change }]), /changed or been turned off/);
  }
  assert.throws(() => assertSceneMemoriesCurrent(board, scene, []));
});
