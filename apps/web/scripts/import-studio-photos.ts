import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { LeagueStudioPhotos } from "../src/server/league-studio-photos";
import { studioAssetId } from "../src/server/league-studio-core";
import { LeagueStudioStore } from "../src/server/league-studio-store";
import type { PhotoSourceInput } from "../src/types/studio-photos";

type Source = { file: string; sha256: string; metadata: PhotoSourceInput };
type Cutout = { file: string; sha256: string; photoId: string; memberIds: string[]; duplicateExports?: string[] };
async function main() {
  const args = process.argv.slice(2);
  const value = (name: string) => args[args.indexOf(name) + 1];
  if (!args.includes("--manifest") || !args.includes("--files") ||
    args.includes("--apply") === args.includes("--dry-run")) {
    throw new Error("Use --manifest FILE --files DIRECTORY and either --dry-run or --apply. Set DATA_ROOT to the intended league data directory.");
  }
  if (!process.env.DATA_ROOT) throw new Error("Set DATA_ROOT explicitly before importing private photos.");
  const manifestPath = path.resolve(value("--manifest"));
  const fileRoot = await fs.realpath(value("--files"));
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { schema: number; sources: Source[]; cutouts?: Cutout[] };
  if (manifest.schema !== 1 || !Array.isArray(manifest.sources) || !manifest.sources.length || manifest.sources.length > 2000)
    throw new Error("Unsupported photo manifest.");
  const store = new LeagueStudioStore();
  const library = new LeagueStudioPhotos();
  const profiles = new Set((await store.read()).profiles.map((profile) => profile.id));
  const ids = new Set<string>();
  const checked: { source: Source; bytes: Buffer }[] = [];
  const checkedCutouts: { cutout: Cutout; bytes: Buffer }[] = [];
  for (const source of manifest.sources) {
    if (!source.file || path.basename(source.file) !== source.file || source.file.includes("\\")) throw new Error("Source file must be a basename.");
    const resolved = await fs.realpath(path.join(fileRoot, source.file));
    if (path.dirname(resolved) !== fileRoot) throw new Error("Source file escaped its import directory.");
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error(`Invalid source size: ${source.file}`);
    const bytes = await fs.readFile(resolved);
    if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new Error(`Hash mismatch: ${source.file}`);
    const metadata = await sharp(bytes, { limitInputPixels: 30_000_000 }).metadata();
    if (metadata.width !== source.metadata.width || metadata.height !== source.metadata.height) throw new Error(`Dimension mismatch: ${source.file}`);
    if (ids.has(source.metadata.id)) throw new Error(`Duplicate photo ID: ${source.metadata.id}`);
    ids.add(source.metadata.id);
    if (source.metadata.labels.some((label) => label.memberId && !profiles.has(label.memberId))) throw new Error(`Unknown league member in ${source.file}`);
    checked.push({ source, bytes });
  }
  if (manifest.cutouts !== undefined && (!Array.isArray(manifest.cutouts) || manifest.cutouts.length > 2000)) throw new Error("Invalid cutout list.");
  for (const cutout of manifest.cutouts ?? []) {
    if (!cutout.file || path.basename(cutout.file) !== cutout.file || cutout.file.includes("\\")) throw new Error("Cutout file must be a basename.");
    const resolved = await fs.realpath(path.join(fileRoot, cutout.file));
    if (path.dirname(resolved) !== fileRoot) throw new Error("Cutout file escaped its import directory.");
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error(`Invalid cutout size: ${cutout.file}`);
    const bytes = await fs.readFile(resolved);
    if (createHash("sha256").update(bytes).digest("hex") !== cutout.sha256) throw new Error(`Hash mismatch: ${cutout.file}`);
    const image = sharp(bytes, { limitInputPixels: 30_000_000 });
    const metadata = await image.metadata();
    const statistics = await image.stats();
    if (!["png", "webp"].includes(metadata.format ?? "") || !metadata.hasAlpha || statistics.isOpaque || statistics.channels[statistics.channels.length-1].max === 0)
      throw new Error(`Cutout needs visible pixels and transparency: ${cutout.file}`);
    if (!ids.has(cutout.photoId)) throw new Error(`Cutout source is missing from this manifest: ${cutout.file}`);
    if (!Array.isArray(cutout.memberIds) || cutout.memberIds.some((id) => !profiles.has(id))) throw new Error(`Unknown cutout member: ${cutout.file}`);
    checkedCutouts.push({ cutout, bytes });
  }
  console.log(JSON.stringify({ mode: args.includes("--apply") ? "apply" : "dry-run", dataRoot: process.env.DATA_ROOT,
    files: checked.length, labels: checked.reduce((sum, entry) => sum + entry.source.metadata.labels.length, 0),
    concepts: checked.reduce((sum, entry) => sum + entry.source.metadata.memes.length, 0), cutouts: checkedCutouts.length,
    duplicateExportsSkipped: checkedCutouts.reduce((sum, entry) => sum + (entry.cutout.duplicateExports?.length ?? 0), 0) }));
  if (args.includes("--dry-run")) return;
  for (const { source, bytes } of checked) {
    const photo = await library.importSource(source.metadata, bytes);
    console.log(JSON.stringify({ id: photo.id, revision: photo.revision, sourceAssetId: photo.sourceAssetId }));
  }
  const expectedCutouts: { photoId: string; assetId: string; file: string }[] = [];
  for (const { cutout, bytes } of checkedCutouts) {
    const previous = await library.read(cutout.photoId);
    const assetId = studioAssetId(bytes, { kind: "cutout", referenceIds: [previous.sourceAssetId] });
    const reused = previous.cutouts.some((item) => item.assetId === assetId);
    const photo = reused ? previous : await library.addCutout(cutout.photoId, cutout.file, cutout.memberIds, bytes);
    expectedCutouts.push({ photoId: cutout.photoId, assetId, file: cutout.file });
    console.log(JSON.stringify({ id: photo.id, cutout:cutout.file, assetId, reused, savedVersions:photo.cutouts.length }));
  }
  const photos = await library.list();
  for (const source of manifest.sources) if (!photos.some((photo) => photo.id === source.metadata.id)) throw new Error(`Imported photo missing: ${source.metadata.id}`);
  for (const cutout of expectedCutouts) if (!photos.find((photo) => photo.id === cutout.photoId)?.cutouts.some((item) => item.assetId === cutout.assetId)) throw new Error(`Imported cutout missing: ${cutout.file}`);
  console.log(JSON.stringify({ importedAndVerified: checked.length, cutoutsVerified:checkedCutouts.length, totalLibraryPhotos: photos.length }));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
