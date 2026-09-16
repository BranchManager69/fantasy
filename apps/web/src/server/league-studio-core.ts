import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getDataRoot } from "@/lib/paths";

export function studioDirectory() { return path.join(getDataRoot(), "private", "studio"); }
export function studioId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value)) throw new Error("Invalid studio identifier");
  return value;
}
export async function privateDirectory(directory: string) { await fs.mkdir(directory, { recursive: true, mode: 0o700 }); }
export async function writePrivateJson(filename: string, value: unknown) {
  await privateDirectory(path.dirname(filename));
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filename);
  } finally { await fs.unlink(temporary).catch(() => undefined); }
}
export async function readPrivateJson<T>(filename: string, maxBytes = 8 * 1024 * 1024): Promise<T> {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error("Studio file is unavailable or exceeds its size limit");
  return JSON.parse(await fs.readFile(filename, "utf8")) as T;
}
export async function listPrivateJson<T>(folder: string, limit = 100): Promise<T[]> {
  await privateDirectory(folder);
  const names = (await fs.readdir(folder)).filter((name) => /^[a-zA-Z0-9_-]+\.json$/.test(name));
  if (names.length > 2000) throw new Error("This studio collection needs archiving before adding more items");
  const items = await Promise.all(names.map(async (name) => ({ name, time: (await fs.stat(path.join(folder, name))).mtimeMs })));
  return Promise.all(items.sort((a, b) => b.time - a.time).slice(0, limit).map((item) => readPrivateJson<T>(path.join(folder, item.name))));
}
export type StudioAsset = {
  id: string; label: string; kind: "portrait" | "reference" | "generated" | "source-photo" | "cutout";
  memberId?: string; playerId?: number; mime: string; bytes: number; createdAt: string;
  sourceUrl?: string; referenceIds?: string[]; prompt?: string; model?: string;
};
export type StudioScene = {
  id: string; kind: "replay" | "lineup" | "result" | "roast";
  title: string; commentary: string; evidenceIds: string[]; memoryIds: string[];
  memberIds: string[]; playerIds: number[]; imageBrief: string; assetId?: string;
};
export type StudioBoard = {
  id: string; title: string; season: number; week: number; teamId: number; createdAt: string;
  model: string; scenes: StudioScene[]; evidence: Record<string, unknown>; sourceIds: string[];
  memories?: { id: string; text: string; sourceIds: string[]; memberIds: string[]; confidence: string }[];
  promptVersions?: Record<string, string>; runIds?: string[];
};
export type StudioJob = {
  id: string; kind: "analyze" | "storyboard" | "render"; status: "running" | "completed" | "failed" | "paused" | "interrupted";
  stage: string; progress: { done: number; total: number }; createdAt: string; updatedAt: string;
  owner: string; error?: string; resultId?: string; imageRunId?: string;
};
export function collectionFile(collection: "assets" | "boards" | "jobs" | "analysis", id: string) {
  return path.join(studioDirectory(), collection, `${studioId(id)}.json`);
}
export function imageMime(bytes: Uint8Array): string {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "image/webp";
  throw new Error("Use a PNG, JPEG, or WebP image");
}
export function studioAssetId(bytes: Buffer, fields: Pick<StudioAsset, "kind" | "memberId" | "playerId" | "referenceIds">) {
  return `asset-${createHash("sha256").update(bytes).update(JSON.stringify({ memberId: fields.memberId, playerId: fields.playerId, kind: fields.kind, ...(fields.kind === "cutout" ? { referenceIds: fields.referenceIds } : {}) })).digest("hex").slice(0, 32)}`;
}
export async function saveStudioAsset(bytes: Buffer, fields: Omit<StudioAsset, "id" | "mime" | "bytes" | "createdAt">, directory = studioDirectory()) {
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error("Images must be between 1 byte and 10 MB");
  if (fields.memberId) studioId(fields.memberId);
  if (fields.playerId !== undefined && (!Number.isInteger(fields.playerId) || fields.playerId < 1)) throw new Error("Invalid player identifier");
  const mime = imageMime(bytes);
  const id = studioAssetId(bytes, fields);
  const asset: StudioAsset = { ...fields, label: String(fields.label).slice(0, 200), id, mime, bytes: bytes.length, createdAt: new Date().toISOString() };
  const folder = path.join(directory, "images");
  await privateDirectory(folder);
  await fs.writeFile(path.join(folder, id), bytes, { mode: 0o600 });
  await writePrivateJson(path.join(directory, "assets", `${id}.json`), asset);
  return asset;
}
export async function readStudioAsset(id: string, directory = studioDirectory()) {
  const asset = await readPrivateJson<StudioAsset>(path.join(directory, "assets", `${studioId(id)}.json`));
  if (asset.id !== id) throw new Error("Image identity mismatch");
  const filename = path.join(directory, "images", studioId(id));
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) throw new Error("Image is unavailable");
  const bytes = await fs.readFile(filename);
  if (imageMime(bytes) !== asset.mime) throw new Error("Image format mismatch");
  return { asset, bytes };
}
export async function readRequestJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Supply a request body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error("This upload exceeds the size limit");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Supply a JSON object");
  return result as Record<string, unknown>;
}
