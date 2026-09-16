import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { LeagueStudioPhotos, PhotoLibraryError } from "./league-studio-photos";
import { LeagueStudioStore } from "./league-studio-store";
import { readStudioAsset } from "./league-studio-core";
import { createStudioSession, STUDIO_COOKIE } from "./league-studio-auth";
import { GET, POST } from "../app/api/studio/photos/route";
import { GET as getPhoto, PATCH } from "../app/api/studio/photos/[id]/route";

const profile = { id: "test-owner", teamId: 1, displayName: "Test Owner", aliases: [], background: "", roastNotes: "", avoidTopics: [] };
const metadata = () => ({ id: "img-9018", filename: "IMG_9018.jpg", width: 2, height: 1, scene: "Two people at a wedding.",
  editNotes: "Keep the background.", visibleText: [], labels: [{ memberId: "test-owner", name: "Test Owner", position: "left", basis: "user_supplied" }],
  memes: [{ title: "The vows", triggers: ["weekly-win"], caption: "Till bye week do us part", alternateCaption: "",
    editPlan: "Replace the person at right.", prompt: "Keep the wedding composition.", priority: "high" }] });

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fantasy-photos-test-"));
  const store = new LeagueStudioStore(directory);
  await store.saveProfile(profile);
  const photos = new LeagueStudioPhotos(directory);
  const bytes = await sharp({ create: { width: 2, height: 1, channels: 3, background: "#bbaacc" } }).jpeg().toBuffer();
  const cutout = await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 0, 0]), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  return { directory, photos, store, bytes, cutout, close: () => fs.rm(directory, { recursive: true, force: true }) };
}

test("source import preserves original bytes and repeat imports preserve manual labels", async () => {
  const f = await fixture();
  try {
    const original = await f.photos.importSource(metadata(), f.bytes);
    assert.equal(original.revision, 1);
    assert.equal(original.cutouts.length, 0);
    const asset = await readStudioAsset(original.sourceAssetId, f.directory);
    assert.equal(asset.asset.kind, "source-photo");
    assert.equal(asset.asset.memberId, undefined);
    assert.deepEqual(asset.bytes, f.bytes);
    const edited = await f.photos.update(original.id, { revision: 1, labels: [], scene: "Updated scene" });
    const repeated = await f.photos.importSource(metadata(), f.bytes);
    assert.deepEqual(repeated, edited);
    assert.equal((await f.photos.list()).length, 1);
    for (const relative of [`photos/${original.id}.json`, `assets/${original.sourceAssetId}.json`, `images/${original.sourceAssetId}`]) {
      assert.equal((await fs.stat(path.join(f.directory, relative))).mode & 0o777, 0o600);
    }
  } finally { await f.close(); }
});

test("source IDs reject image collisions and dimensions are verified from image bytes", async () => {
  const f = await fixture();
  try {
    await f.photos.importSource(metadata(), f.bytes);
    const different = await sharp({ create: { width: 2, height: 1, channels: 3, background: "#112233" } }).jpeg().toBuffer();
    await assert.rejects(f.photos.importSource(metadata(), different), (error: unknown) => error instanceof PhotoLibraryError && error.status === 409);
    await assert.rejects(f.photos.importSource({ ...metadata(), width: 900 }, f.bytes), /dimensions/);
    await assert.rejects(f.photos.importSource({ ...metadata(), id: "img-9019" }, Buffer.from("not an image")));
    await assert.rejects(f.photos.importSource(metadata(), Buffer.alloc(10 * 1024 * 1024 + 1)), /10 MB/);
  } finally { await f.close(); }
});

test("person labels require user provenance and known member IDs", async () => {
  const f = await fixture();
  try {
    for (const label of [
      { name: "Test", basis: "face_match", memberId: "test-owner" },
      { name: "Test", basis: "user_supplied", memberId: "unknown-person" },
      { name: "", basis: "user_supplied" },
    ]) await assert.rejects(f.photos.importSource({ ...metadata(), labels: [label] }, f.bytes));
    const photo = await f.photos.importSource({ ...metadata(), labels: [{ name: "Tina", position: "right", basis: "user_supplied" }] }, f.bytes);
    assert.equal(photo.labels[0].memberId, undefined);
    assert.equal(photo.labels[0].name, "Tina");
  } finally { await f.close(); }
});

test("path traversal and symlink photo records are rejected", async () => {
  const f = await fixture();
  try {
    for (const id of ["../state", "x/y", "x\\y", "/tmp/out", "A"]) {
      await assert.rejects(f.photos.importSource({ ...metadata(), id }, f.bytes));
      await assert.rejects(f.photos.read(id));
    }
    for (const name of ["../IMG.png", "a/b.png", "a\\b.png"]) await assert.rejects(f.photos.importSource({ ...metadata(), filename: name }, f.bytes));
    await f.photos.list();
    await fs.symlink(path.join(f.directory, "state.json"), path.join(f.directory, "photos", "img-9018.json"));
    await assert.rejects(f.photos.read("img-9018"));
  } finally { await f.close(); }
});

test("optimistic revisions prevent concurrent labels from overwriting each other", async () => {
  const f = await fixture();
  try {
    await f.photos.importSource(metadata(), f.bytes);
    const other = new LeagueStudioPhotos(f.directory);
    const writes = await Promise.allSettled([
      f.photos.update("img-9018", { revision: 1, labels: [], scene: "First edit" }),
      other.update("img-9018", { revision: 1, labels: [], scene: "Second edit" }),
    ]);
    assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
    const failed = writes.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.equal(failed.reason.status, 409);
    const saved = await f.photos.read("img-9018");
    assert.equal(saved.revision, 2);
    assert.equal(saved.scene, "First edit");
    await assert.rejects(f.photos.update("img-9018", { revision: 0, labels: [] }));
  } finally { await f.close(); }
});

test("cutouts need visible transparency, retain their source, and never become owner portraits", async () => {
  const f = await fixture();
  try {
    const source = await f.photos.importSource(metadata(), f.bytes);
    const opaque = await sharp({ create: { width: 2, height: 1, channels: 4, background: "#112233ff" } }).png().toBuffer();
    const empty = await sharp({ create: { width: 2, height: 1, channels: 4, background: "#11223300" } }).png().toBuffer();
    await assert.rejects(f.photos.addCutout(source.id, "opaque.png", [], opaque), /no transparent pixels/);
    await assert.rejects(f.photos.addCutout(source.id, "empty.png", [], empty), /entirely transparent/);
    await assert.rejects(f.photos.addCutout(source.id, "jpeg.jpg", [], f.bytes), /PNG or WebP/);
    await assert.rejects(f.photos.addCutout(source.id, "cutout.png", ["unknown-person"], f.cutout), /saved league members/);
    const photo = await f.photos.addCutout(source.id, "IMG_9018-cutout.png", ["test-owner"], f.cutout);
    assert.equal(photo.cutouts.length, 1);
    assert.equal(photo.revision, 2);
    const cutout = await readStudioAsset(photo.cutouts[0].assetId, f.directory);
    assert.equal(cutout.asset.kind, "cutout");
    assert.equal(cutout.asset.memberId, undefined);
    assert.deepEqual(cutout.asset.referenceIds, [source.sourceAssetId]);
    assert.deepEqual(cutout.bytes, f.cutout);
    assert.deepEqual((await f.store.read()).profiles[0].assets ?? [], []);
    assert.deepEqual(await f.photos.addCutout(source.id, "same.png", ["test-owner"], f.cutout), photo);
    assert.deepEqual((await readStudioAsset(photo.cutouts[0].assetId, f.directory)).asset, cutout.asset);
    await assert.rejects(f.photos.addCutout(source.id, "same.png", [], f.cutout), (error: unknown) => error instanceof PhotoLibraryError && error.status === 409);
    await assert.rejects(f.photos.update(source.id, { revision: 1, labels: [] }), (error: unknown) => error instanceof PhotoLibraryError && error.status === 409);
  } finally { await f.close(); }
});

test("bulk cutouts can be assigned and cleared without changing source labels or image bytes", async () => {
  const f = await fixture();
  try {
    const source = await f.photos.importSource(metadata(), f.bytes);
    const bulk = await f.photos.addCutout(source.id, "bulk.png", [], f.cutout);
    const firstAssetId = bulk.cutouts[0].assetId;
    const webp = await sharp(f.cutout).webp({ lossless: true }).toBuffer();
    const before = await f.photos.addCutout(source.id, "other.webp", ["test-owner"], webp);
    const firstAsset = await readStudioAsset(firstAssetId, f.directory);
    const assigned = await f.photos.update(source.id, {
      revision: before.revision,
      cutoutAssignments: [{ assetId: firstAssetId, memberIds: ["test-owner"] }],
    });
    assert.equal(assigned.revision, before.revision + 1);
    assert.deepEqual(assigned.labels, source.labels);
    assert.equal(assigned.scene, source.scene);
    assert.equal(assigned.editNotes, source.editNotes);
    assert.deepEqual(assigned.cutouts[0], { ...before.cutouts[0], memberIds: ["test-owner"] });
    assert.deepEqual(assigned.cutouts[1], before.cutouts[1]);
    assert.equal("cutoutAssignments" in assigned, false);
    assert.deepEqual(await new LeagueStudioPhotos(f.directory).read(source.id), assigned);

    const cleared = await f.photos.update(source.id, {
      revision: assigned.revision,
      editNotes: "Names cleared from the first cutout only.",
      cutoutAssignments: [{ assetId: firstAssetId, memberIds: [] }],
    });
    assert.equal(cleared.revision, assigned.revision + 1);
    assert.deepEqual(cleared.cutouts, before.cutouts);
    assert.deepEqual(cleared.labels, source.labels);
    assert.equal(cleared.editNotes, "Names cleared from the first cutout only.");
    assert.deepEqual((await readStudioAsset(source.sourceAssetId, f.directory)).bytes, f.bytes);
    assert.deepEqual(await readStudioAsset(firstAssetId, f.directory), firstAsset);
    assert.deepEqual((await readStudioAsset(cleared.cutouts[1].assetId, f.directory)).bytes, webp);
    assert.equal("cutoutAssignments" in await f.photos.read(source.id), false);

    await assert.rejects(f.photos.update(source.id, {
      revision: assigned.revision, labels: [],
      cutoutAssignments: [{ assetId: firstAssetId, memberIds: ["test-owner"] }],
    }), (error: unknown) => error instanceof PhotoLibraryError && error.status === 409);
    assert.deepEqual(await f.photos.read(source.id), cleared);
  } finally { await f.close(); }
});

test("cutout assignment patches reject empty, duplicate, unknown, and incomplete assignments atomically", async () => {
  const f = await fixture();
  try {
    const source = await f.photos.importSource(metadata(), f.bytes);
    const photo = await f.photos.addCutout(source.id, "bulk.png", [], f.cutout);
    const assetId = photo.cutouts[0].assetId;
    for (const patch of [
      {},
      { unrelated: true },
      { cutoutAssignments: [] },
      { cutoutAssignments: [{ assetId, memberIds: [] }, { assetId, memberIds: ["test-owner"] }] },
      { cutoutAssignments: Array.from({ length: 41 }, () => ({ assetId, memberIds: [] })) },
      { cutoutAssignments: [{ assetId: "asset-missing", memberIds: [] }] },
      { cutoutAssignments: [{ assetId, memberIds: ["unknown-owner"] }] },
      { cutoutAssignments: [{ assetId }] },
    ]) {
      await assert.rejects(f.photos.update(source.id, { revision: photo.revision, ...patch }),
        (error: unknown) => error instanceof PhotoLibraryError && error.status === 400);
      assert.deepEqual(await f.photos.read(source.id), photo);
    }
    const notesOnly = await f.photos.update(source.id, { revision: photo.revision, scene: "Only the scene changes." });
    assert.equal(notesOnly.scene, "Only the scene changes.");
    assert.deepEqual(notesOnly.labels, photo.labels);
    assert.deepEqual(notesOnly.cutouts, photo.cutouts);
  } finally { await f.close(); }
});

test("prepared import reuses renamed cutouts and preserves later manual source and cutout names", async () => {
  const f = await fixture();
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fantasy-photo-import-"));
  try {
    const directory = path.join(dataRoot, "private", "studio");
    await new LeagueStudioStore(directory).saveProfile(profile);
    const photos = new LeagueStudioPhotos(directory);
    const source = await photos.importSource(metadata(), f.bytes);
    const bulk = await photos.addCutout(source.id, "original-export.png", [], f.cutout);
    const edited = await photos.update(source.id, {
      revision: bulk.revision,
      labels: [{ name: "Test Owner", memberId: "test-owner", position: "Manually corrected position", basis: "user_supplied" }],
      cutoutAssignments: [{ assetId: bulk.cutouts[0].assetId, memberIds: ["test-owner"] }],
    });
    const files = path.join(dataRoot, "import-files");
    await fs.mkdir(files);
    await fs.writeFile(path.join(files, "IMG_9018.jpg"), f.bytes);
    await fs.writeFile(path.join(files, "renamed-export.png"), f.cutout);
    const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const manifest = path.join(dataRoot, "manifest.json");
    await fs.writeFile(manifest, JSON.stringify({ schema: 1,
      sources: [{ file: "IMG_9018.jpg", sha256: sha256(f.bytes), metadata: metadata() }],
      cutouts: [{ file: "renamed-export.png", sha256: sha256(f.cutout), photoId: source.id, memberIds: [] }],
    }));
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "scripts/import-studio-photos.ts", "--manifest", manifest, "--files", files, "--apply"], {
        cwd: process.cwd(), env: { ...process.env, DATA_ROOT: dataRoot },
        stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
      });
      let log = "";
      child.stdout.on("data", (chunk) => { log += String(chunk); });
      child.stderr.on("data", (chunk) => { log += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve(log) : reject(new Error(log || "Photo import failed")));
    });
    const records = output.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.find((record) => record.cutout === "renamed-export.png")?.reused, true);
    assert.equal(records.at(-1).cutoutsVerified, 1);
    assert.deepEqual(await photos.read(source.id), edited);
    assert.equal((await photos.read(source.id)).cutouts[0].filename, "original-export.png");
    assert.deepEqual((await readStudioAsset(source.sourceAssetId, directory)).bytes, f.bytes);
    assert.deepEqual((await readStudioAsset(bulk.cutouts[0].assetId, directory)).bytes, f.cutout);
  } finally { await f.close(); await fs.rm(dataRoot, { recursive: true, force: true }); }
});

test("WebP transparency is decoded and cutout versions preserve earlier images", async () => {
  const f = await fixture();
  try {
    await f.photos.importSource(metadata(), f.bytes);
    const first = await f.photos.addCutout("img-9018", "first.png", [], f.cutout);
    const webp = await sharp(f.cutout).webp({ lossless: true }).toBuffer();
    const second = await f.photos.addCutout("img-9018", "second.webp", [], webp);
    assert.equal(second.cutouts.length, 2);
    assert.equal(second.cutouts[0].assetId, first.cutouts[0].assetId);
    const opaque = await sharp({ create: { width: 2, height: 1, channels: 3, background: "#112233" } }).webp().toBuffer();
    await assert.rejects(f.photos.addCutout("img-9018", "opaque.webp", [], opaque), /no transparent pixels/);
  } finally { await f.close(); }
});

test("identical cutout bytes attached to different source images retain separate provenance", async () => {
  const f = await fixture();
  try {
    const first = await f.photos.importSource(metadata(), f.bytes);
    const bytes = await sharp({ create: { width: 2, height: 1, channels: 3, background: "#112233" } }).jpeg().toBuffer();
    const second = await f.photos.importSource({ ...metadata(), id: "img-9019", filename: "IMG_9019.jpg" }, bytes);
    const one = await f.photos.addCutout(first.id, "cutout.png", [], f.cutout);
    const two = await f.photos.addCutout(second.id, "cutout.png", [], f.cutout);
    assert.notEqual(one.cutouts[0].assetId, two.cutouts[0].assetId);
    assert.deepEqual((await readStudioAsset(one.cutouts[0].assetId, f.directory)).asset.referenceIds, [first.sourceAssetId]);
    assert.deepEqual((await readStudioAsset(two.cutouts[0].assetId, f.directory)).asset.referenceIds, [second.sourceAssetId]);
  } finally { await f.close(); }
});

test("filesystem lock excludes a separate writer and releases with its descriptor", async () => {
  const f = await fixture();
  let guard: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    await f.photos.importSource(metadata(), f.bytes);
    guard = await fs.open(path.join(f.directory, ".photo-write-guard"), "r+");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", guard!.fd] });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Test lock failed")));
    });
    await assert.rejects(f.photos.update("img-9018", { revision: 1, labels: [] }), (error: unknown) => error instanceof PhotoLibraryError && error.status === 409);
    await guard.close(); guard = undefined;
    assert.equal((await f.photos.update("img-9018", { revision: 1, labels: [] })).revision, 2);
  } finally { await guard?.close(); await f.close(); }
});

test("photo routes require authorization and refuse cross-origin writes before reading uploads", async () => {
  const old = process.env.FANTASY_STUDIO_TOKEN;
  process.env.FANTASY_STUDIO_TOKEN = "synthetic-photo-tests-private-token-123456789012345";
  try {
    const base = "https://fantasy.example/api/studio/photos";
    assert.equal((await GET(new Request(base))).status, 401);
    assert.equal((await POST(new Request(base, { method: "POST" }))).status, 401);
    assert.equal((await getPhoto(new Request(base + "/img-9018"), { params: Promise.resolve({ id: "img-9018" }) })).status, 401);
    assert.equal((await PATCH(new Request(base + "/img-9018", { method: "PATCH" }), { params: Promise.resolve({ id: "img-9018" }) })).status, 401);
    const session = await createStudioSession(process.env.FANTASY_STUDIO_TOKEN);
    const headers = { cookie: `${STUDIO_COOKIE}=${session}`, origin: "https://attacker.example" };
    assert.equal((await POST(new Request(base, { method: "POST", headers }))).status, 401);
    const response = await PATCH(new Request(base + "/img-9018", { method: "PATCH", headers }), { params: Promise.resolve({ id: "img-9018" }) });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  } finally { if (old === undefined) delete process.env.FANTASY_STUDIO_TOKEN; else process.env.FANTASY_STUDIO_TOKEN = old; }
});

test("authenticated photo routes import, label, version cutouts, and protect source bytes", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fantasy-photo-http-"));
  const f = await fixture();
  const script = `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const { LeagueStudioStore } = require("./src/server/league-studio-store.ts");
    const { createStudioSession, STUDIO_COOKIE } = require("./src/server/league-studio-auth.ts");
    const { GET, POST } = require("./src/app/api/studio/photos/route.ts");
    const { PATCH } = require("./src/app/api/studio/photos/[id]/route.ts");
    const { GET: imageGET } = require("./src/app/api/studio/assets/[id]/route.ts");
    const input = JSON.parse(process.env.FANTASY_PHOTO_TEST_INPUT);
    await new LeagueStudioStore().saveProfile(input.profile);
    const token = await createStudioSession(process.env.FANTASY_STUDIO_TOKEN);
    const headers = { cookie: STUDIO_COOKIE + "=" + token, origin: "https://fantasy.example" };
    const base = "https://fantasy.example/api/studio/photos";
    const sourceForm = () => {
      const form = new FormData();
      form.set("action", "source"); form.set("metadata", JSON.stringify(input.metadata));
      form.set("file", new File([Buffer.from(input.bytes, "base64")], input.metadata.filename, { type: "image/jpeg" }));
      return form;
    };
    const sourceResponse = await POST(new Request(base, { method: "POST", headers, body: sourceForm() }));
    assert.equal(sourceResponse.status, 200, await sourceResponse.clone().text());
    const { photo } = await sourceResponse.json();
    assert.equal(photo.id, "img-9018");
    const patch = (revision) => PATCH(new Request(base + "/" + photo.id, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ revision, labels: [], scene: "Saved through HTTP" }) }), { params: Promise.resolve({ id: photo.id }) });
    assert.equal((await patch(1)).status, 200);
    const stale = await patch(1);
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /another window/);
    const repeated = await POST(new Request(base, { method: "POST", headers, body: sourceForm() }));
    assert.equal((await repeated.json()).photo.scene, "Saved through HTTP");
    const form = new FormData();
    form.set("action", "cutout"); form.set("photoId", photo.id); form.set("memberIds", JSON.stringify(["test-owner"]));
    form.set("file", new File([Buffer.from(input.cutout, "base64")], "IMG_9018-cutout.png", { type: "image/png" }));
    const cutoutResponse = await POST(new Request(base, { method: "POST", headers, body: form }));
    assert.equal(cutoutResponse.status, 200, await cutoutResponse.clone().text());
    const result = (await cutoutResponse.json()).photo;
    assert.equal(result.revision, 3); assert.equal(result.cutouts.length, 1);
    const assignmentResponse = await PATCH(new Request(base + "/" + photo.id, {
      method: "PATCH", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ revision: result.revision, cutoutAssignments: [{ assetId: result.cutouts[0].assetId, memberIds: [] }] }),
    }), { params: Promise.resolve({ id: photo.id }) });
    assert.equal(assignmentResponse.status, 200, await assignmentResponse.clone().text());
    const reassigned = (await assignmentResponse.json()).photo;
    assert.equal(reassigned.revision, 4);
    assert.deepEqual(reassigned.labels, result.labels);
    assert.deepEqual(reassigned.cutouts[0].memberIds, []);
    assert.equal("cutoutAssignments" in reassigned, false);
    const listing = await GET(new Request(base, { headers }));
    assert.equal((await listing.json()).photos.length, 1);
    const context = { params: Promise.resolve({ id: photo.sourceAssetId }) };
    assert.equal((await imageGET(new Request("https://fantasy.example/api/studio/assets/" + photo.sourceAssetId), context)).status, 401);
    const image = await imageGET(new Request("https://fantasy.example/api/studio/assets/" + photo.sourceAssetId, { headers }), context);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(input.bytes, "base64"));
  `;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: process.cwd(), env: { ...process.env, DATA_ROOT: dataRoot, FANTASY_STUDIO_TOKEN: "synthetic-photo-http-test-token-123456789012345",
          FANTASY_PHOTO_TEST_INPUT: JSON.stringify({ profile, metadata: metadata(), bytes: f.bytes.toString("base64"), cutout: f.cutout.toString("base64") }) },
        stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += String(chunk); });
      child.stderr.on("data", (chunk) => { output += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(output || "Photo route test failed")));
    });
  } finally { await f.close(); await fs.rm(dataRoot, { recursive: true, force: true }); }
});
