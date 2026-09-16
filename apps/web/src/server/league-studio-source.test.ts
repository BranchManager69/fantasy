import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GET } from "../app/api/studio/sources/[id]/route";
import { LeagueStudioStore } from "./league-studio-store";
import { createStudioSession, STUDIO_COOKIE } from "./league-studio-auth";

test("source excerpts require authentication and return only the exact selected message", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fantasy-studio-source-"));
  const previousRoot = process.env.DATA_ROOT;
  const previousToken = process.env.FANTASY_STUDIO_TOKEN;
  process.env.DATA_ROOT = directory;
  process.env.FANTASY_STUDIO_TOKEN = "synthetic-source-test-token-not-a-provider-key";
  try {
    const store = new LeagueStudioStore();
    const { source } = await store.importSource({ label: "Synthetic source", kind: "group_chat", text: JSON.stringify([
      { author: "Fixture A", timestamp: "2026-09-01T12:00:00Z", text: '<script>untrusted source text</script>' },
      { author: "Fixture B", text: "Another private message that was not selected." },
    ]) });
    const ids = (await store.listChunks(source.id)).flatMap((chunk) => chunk.messageIds);
    const session = await createStudioSession(process.env.FANTASY_STUDIO_TOKEN);
    const request = (id: string, signed = true) => GET(new Request("https://fantasy.example/api/studio/sources/selected", {
      headers: signed ? { cookie: `${STUDIO_COOKIE}=${session}` } : {},
    }), { params: Promise.resolve({ id }) });

    await t.test("unauthenticated requests reveal no source or message", async () => {
      const response = await request(ids[0], false);
      assert.equal(response.status, 401);
      assert.match(response.headers.get("cache-control") ?? "", /private.*no-store/);
      const body = await response.json();
      assert.equal(Object.hasOwn(body, "source"), false);
      assert.equal(Object.hasOwn(body, "message"), false);
    });
    await t.test("the selected excerpt retains plain source text and metadata", async () => {
      const response = await request(ids[0]);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      const body = await response.json();
      assert.deepEqual(body, { source: { id: source.id, label: source.label }, message: {
        id: ids[0], author: "Fixture A", timestamp: "2026-09-01T12:00:00Z", text: '<script>untrusted source text</script>',
      } });
      assert.equal(JSON.stringify(body).includes("Another private message"), false);
      const second = await (await request(ids[1])).json();
      assert.equal(second.message.author, "Fixture B");
      assert.equal(second.message.timestamp, null);
    });
    await t.test("whole imports, malformed indexes, traversal and unknown messages are rejected", async () => {
      const prefix = ids[0].slice(0, -5);
      for (const id of [source.id, "../../state.json", `${prefix}0`, `${prefix}-0001`, `${prefix}20000`, `${prefix}999999999`, `${prefix}00002`, `msg-${"a".repeat(64)}-00000`]) {
        const response = await request(id);
        assert.equal(response.status, 404, id);
        assert.deepEqual(await response.json(), { error: "This saved message is unavailable" });
      }
    });
  } finally {
    if (previousRoot === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = previousRoot;
    if (previousToken === undefined) delete process.env.FANTASY_STUDIO_TOKEN; else process.env.FANTASY_STUDIO_TOKEN = previousToken;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
