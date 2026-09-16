import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { imageMime, readPrivateJson, readStudioAsset, saveStudioAsset, studioAssetId, studioDirectory, writePrivateJson } from "./league-studio-core";
import { LeagueStudioStore } from "./league-studio-store";
import type { PhotoLabel, PhotoMeme, PhotoPatch, PhotoSourceInput, PhotoTemplate } from "@/types/studio-photos";

const MAX_PHOTOS = 2000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const queues = new Map<string, Promise<unknown>>();

export class PhotoLibraryError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "PhotoLibraryError"; }
}
function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new PhotoLibraryError(message);
}
function object(value: unknown): Record<string, unknown> {
  requireValue(!!value && typeof value === "object" && !Array.isArray(value), "Supply a photo record");
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, maximum: number, empty = false): string {
  requireValue(typeof value === "string" && value.length <= maximum && !value.includes("\0") && (empty || !!value.trim()),
    `${label} must contain ${empty ? "0" : "1"} to ${maximum} characters`);
  return value;
}
function identifier(value: unknown, label = "Photo ID"): string {
  const id = text(value, label, 80);
  requireValue(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id), `${label} must be a lowercase identifier`);
  return id;
}
function filename(value: unknown): string {
  const result = text(value, "Filename", 180);
  requireValue(!/[\\/\x00-\x1f\x7f]/.test(result) && result !== "." && result !== "..", "Use a filename without folders");
  return result;
}
function textList(value: unknown, label: string, count: number, chars: number): string[] {
  requireValue(Array.isArray(value) && value.length <= count, `${label} accepts at most ${count} entries`);
  return [...new Set(value.map((entry) => text(entry, label, chars)))];
}
function labels(value: unknown, profiles: Set<string>): PhotoLabel[] {
  requireValue(Array.isArray(value) && value.length <= 32, "A photo accepts at most 32 person labels");
  return value.map((entry) => {
    const label = object(entry);
    requireValue(label.basis === "user_supplied", "Person labels must come from your supplied names");
    const memberId = label.memberId === undefined ? undefined : identifier(label.memberId, "Member ID");
    requireValue(!memberId || profiles.has(memberId), "Choose a saved league member");
    return { ...(memberId ? { memberId } : {}), name: text(label.name, "Name", 120).trim(),
      ...(label.position !== undefined ? { position: text(label.position, "Position", 300, true) } : {}), basis: "user_supplied" as const };
  });
}
function cutoutAssignments(value: unknown, profiles: Set<string>): NonNullable<PhotoPatch["cutoutAssignments"]> {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= 40, "Supply 1 to 40 cutout assignments");
  const seen = new Set<string>();
  return value.map((entry) => {
    const assignment = object(entry);
    const assetId = identifier(assignment.assetId, "Cutout ID");
    requireValue(!seen.has(assetId), "Choose each cutout only once");
    seen.add(assetId);
    const memberIds = textList(assignment.memberIds, "Cutout members", 16, 80).map((member) => identifier(member, "Member ID"));
    requireValue(memberIds.every((member) => profiles.has(member)), "Choose saved league members for this cutout");
    return { assetId, memberIds };
  });
}
function memes(value: unknown): PhotoMeme[] {
  requireValue(Array.isArray(value) && value.length <= 12, "A photo accepts at most 12 meme ideas");
  return value.map((entry) => {
    const meme = object(entry);
    requireValue(["high", "medium", "low"].includes(String(meme.priority)), "Choose high, medium, or low priority");
    return { title: text(meme.title, "Meme title", 200), triggers: textList(meme.triggers, "Triggers", 12, 120),
      caption: text(meme.caption, "Caption", 1000, true),
      ...(meme.alternateCaption !== undefined ? { alternateCaption: text(meme.alternateCaption, "Alternate caption", 1000, true) } : {}),
      editPlan: text(meme.editPlan, "Editing notes", 4000),
      prompt: text(meme.prompt, "Image direction", 6000),
      priority: meme.priority as PhotoMeme["priority"] };
  });
}
async function inspectImage(bytes: Buffer, cutout = false) {
  requireValue(bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES, "Images must be between 1 byte and 10 MB");
  const mime = imageMime(bytes);
  if (cutout) requireValue(mime === "image/png" || mime === "image/webp", "Upload a transparent PNG or WebP cutout");
  const image = sharp(bytes, { limitInputPixels: 30_000_000, failOn: "warning" });
  const metadata = await image.metadata();
  requireValue((metadata.pages ?? 1) === 1, "Upload a still image");
  requireValue(!!metadata.width && !!metadata.height, "The image dimensions could not be read");
  const statistics = await image.stats();
  if (cutout) {
    requireValue(metadata.hasAlpha && !statistics.isOpaque, "This image has no transparent pixels. Export it with transparency first.");
    requireValue(statistics.channels[statistics.channels.length - 1].max > 0, "This cutout is entirely transparent");
  }
  return { width: metadata.width, height: metadata.height };
}

export class LeagueStudioPhotos {
  readonly directory: string;
  constructor(directory = studioDirectory()) { this.directory = path.resolve(directory); }
  private file(id: string) { return path.join(this.directory, "photos", `${identifier(id)}.json`); }
  private async prepare() {
    for (const directory of [this.directory, ...["photos", "images", "assets"].map((part) => path.join(this.directory, part))]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(directory);
      requireValue(stat.isDirectory() && !stat.isSymbolicLink(), "Photo storage must use private directories");
      await fs.chmod(directory, 0o700);
    }
  }
  private async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const prior = queues.get(this.directory) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(async () => {
      await this.prepare();
      const guard = await fs.open(path.join(this.directory, ".photo-write-guard"),
        constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        requireValue((await guard.stat()).isFile(), "Photo write guard is unavailable");
        await guard.chmod(0o600);
        await new Promise<void>((resolve, reject) => {
          const child = spawn("/usr/bin/flock", ["--exclusive", "--nonblock", "3"],
            { stdio: ["ignore", "ignore", "ignore", guard.fd], timeout: 2000 });
          child.once("error", () => reject(new PhotoLibraryError("Photo storage is unavailable", 503)));
          child.once("exit", (code) => code === 0 ? resolve() : reject(new PhotoLibraryError("Another photo save is in progress. Try again.", 409)));
        });
        return await operation();
      } finally { await guard.close(); }
    });
    queues.set(this.directory, next);
    try { return await next; }
    finally { if (queues.get(this.directory) === next) queues.delete(this.directory); }
  }
  private async profileIds() {
    return new Set((await new LeagueStudioStore(this.directory).read()).profiles.map((profile) => profile.id));
  }
  private async save(photo: PhotoTemplate) {
    requireValue(Buffer.byteLength(JSON.stringify(photo), "utf8") <= 256 * 1024, "Photo details must fit within 256 KB");
    await writePrivateJson(this.file(photo.id), photo);
  }
  async read(id: string): Promise<PhotoTemplate> {
    const record = await readPrivateJson<PhotoTemplate>(this.file(id), 256 * 1024);
    requireValue(record.id === id, "Photo identity mismatch");
    return record;
  }
  async list(): Promise<PhotoTemplate[]> {
    await this.prepare();
    const names = (await fs.readdir(path.join(this.directory, "photos"))).filter((name) => /^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(name));
    requireValue(names.length <= MAX_PHOTOS, "The photo library has reached its limit");
    const result = await Promise.all(names.map((name) => this.read(name.slice(0, -5))));
    return result.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
  }
  async importSource(input: unknown, bytes: Buffer): Promise<PhotoTemplate> {
    const value = object(input);
    const id = identifier(value.id);
    const image = await inspectImage(bytes);
    requireValue(value.width === image.width && value.height === image.height, "The supplied dimensions do not match the photo");
    const metadata: PhotoSourceInput = { id, filename: filename(value.filename), ...image,
      scene: text(value.scene, "Scene", 4000, true), editNotes: text(value.editNotes, "Editing notes", 4000, true),
      visibleText: textList(value.visibleText, "Visible text", 40, 500),
      labels: labels(value.labels, await this.profileIds()), memes: memes(value.memes) };
    return this.transaction(async () => {
      let previous: PhotoTemplate | undefined;
      try { previous = await this.read(id); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (previous) {
        const original = await readStudioAsset(previous.sourceAssetId, this.directory);
        if (!original.bytes.equals(bytes)) throw new PhotoLibraryError("This photo ID already belongs to another image", 409);
        return previous;
      }
      const entries = await fs.readdir(path.join(this.directory, "photos"));
      requireValue(entries.filter((name) => name.endsWith(".json")).length < MAX_PHOTOS, "The photo library has reached its limit");
      const asset = await saveStudioAsset(bytes, { kind: "source-photo", label: metadata.filename }, this.directory);
      const now = new Date().toISOString();
      const photo: PhotoTemplate = { ...metadata, sourceAssetId: asset.id, cutouts: [], revision: 1, createdAt: now, updatedAt: now };
      await this.save(photo);
      return photo;
    });
  }
  async update(id: string, input: unknown): Promise<PhotoTemplate> {
    identifier(id);
    const value = object(input);
    requireValue(Number.isSafeInteger(value.revision) && Number(value.revision) > 0, "Supply the current photo revision");
    requireValue(["labels", "scene", "editNotes", "cutoutAssignments"].some((field) => value[field] !== undefined), "Supply names, photo notes, or cutout assignments to update");
    const profiles = await this.profileIds();
    const patch: PhotoPatch = { revision: Number(value.revision),
      ...(value.labels !== undefined ? { labels: labels(value.labels, profiles) } : {}),
      ...(value.scene !== undefined ? { scene: text(value.scene, "Scene", 4000, true) } : {}),
      ...(value.editNotes !== undefined ? { editNotes: text(value.editNotes, "Editing notes", 4000, true) } : {}),
      ...(value.cutoutAssignments !== undefined ? { cutoutAssignments: cutoutAssignments(value.cutoutAssignments, profiles) } : {}) };
    return this.transaction(async () => {
      const previous = await this.read(id);
      if (previous.revision !== patch.revision) throw new PhotoLibraryError("This photo changed in another window. Reload it before saving.", 409);
      const { cutoutAssignments: assignments, ...fields } = patch;
      const membersByAsset = new Map(assignments?.map((assignment) => [assignment.assetId, assignment.memberIds]));
      const existingCutouts = new Set(previous.cutouts.map((cutout) => cutout.assetId));
      requireValue([...membersByAsset.keys()].every((assetId) => existingCutouts.has(assetId)), "Choose cutouts attached to this source photo");
      const photo: PhotoTemplate = { ...previous, ...fields,
        ...(assignments ? { cutouts: previous.cutouts.map((cutout) => {
          const memberIds = membersByAsset.get(cutout.assetId);
          return memberIds === undefined ? cutout : { ...cutout, memberIds };
        }) } : {}),
        revision: previous.revision + 1, updatedAt: new Date().toISOString() };
      await this.save(photo);
      return photo;
    });
  }
  async addCutout(id: string, name: string, members: unknown, bytes: Buffer): Promise<PhotoTemplate> {
    identifier(id);
    const cutoutFilename = filename(name);
    const memberIds = textList(members, "Cutout members", 16, 80).map((member) => identifier(member, "Member ID"));
    const profiles = await this.profileIds();
    requireValue(memberIds.every((member) => profiles.has(member)), "Choose saved league members for this cutout");
    await inspectImage(bytes, true);
    return this.transaction(async () => {
      const previous = await this.read(id);
      const fields = { kind: "cutout" as const, label: cutoutFilename, referenceIds: [previous.sourceAssetId] };
      const assetId = studioAssetId(bytes, fields);
      const existing = previous.cutouts.find((entry) => entry.assetId === assetId);
      if (existing) {
        if ([...existing.memberIds].sort().join("\n") !== [...memberIds].sort().join("\n"))
          throw new PhotoLibraryError("This cutout is already saved with different person labels", 409);
        return previous;
      }
      requireValue(previous.cutouts.length < 40, "A photo accepts at most 40 cutout versions");
      const asset = await saveStudioAsset(bytes, fields, this.directory);
      const now = new Date().toISOString();
      const photo: PhotoTemplate = { ...previous, cutouts: [...previous.cutouts, { assetId: asset.id, filename: cutoutFilename, memberIds, createdAt: now }],
        revision: previous.revision + 1, updatedAt: now };
      await this.save(photo);
      return photo;
    });
  }
}

export const studioPhotos = new LeagueStudioPhotos();
