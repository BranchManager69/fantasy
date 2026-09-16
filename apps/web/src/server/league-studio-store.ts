import { constants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { getDataRoot } from "@/lib/paths";

export const STUDIO_LIMITS = { importBytes: 5 * 1024 * 1024, profiles: 64, imports: 100,
  messagesPerImport: 20_000, memories: 5_000, memoriesPerBatch: 100, aliases: 30,
  backgroundChars: 8_000, roastNotesChars: 4_000, memoryChars: 3_000,
  chunkChars: 12_000, chunkMessageBytes: 16_000, contextBytes: 20_000 } as const;
export type StudioAsset = { id: string; kind: "portrait" | "reference"; label?: string };
export type StudioProfile = { id: string; teamId: number; displayName: string; aliases: string[];
  background: string; roastNotes: string; avoidTopics: string[]; assets?: StudioAsset[] };
export type StudioImport = { id: string; label: string; kind: "background" | "group_chat"; contentHash: string;
  createdAt: string; bytes: number; messageCount: number; chunkCount: number };
export type StudioMessage = { id: string; importId: string; index: number; author: string | null;
  timestamp: string | null; text: string; memberId: string | null; identity: "mapped" | "unmapped" | "ambiguous" };
export type StudioChunk = { id: string; importId: string; index: number; messageIds: string[]; messages: StudioMessage[]; text: string };
export type StudioMemoryInput = { id?: string; kind: "background" | "running_joke" | "quote" | "rivalry";
  text: string; memberIds: string[]; sourceIds: string[]; confidence: "explicit" | "inferred"; enabled: boolean };
export type StudioMemory = Omit<StudioMemoryInput, "id"> & { id: string; importId: string; createdAt: string; updatedAt: string };
export type StudioState = { schema: 1; updatedAt: string; profiles: StudioProfile[]; imports: StudioImport[]; memories: StudioMemory[] };
export type StudioMemoryFailure = { index: number; id?: string; reason: string };
export type StudioContext = { profiles: StudioProfile[]; memories: StudioMemory[]; sourceIds: string[];
  untrustedSourceData: true; truncated: boolean };
type StoredMessage = Omit<StudioMessage, "memberId" | "identity">;
type SourceDocument = { schema: 1; importId: string; messages: StoredMessage[] };
type WriteOwner = { schema: 1; pid: number; token: string; createdAt: string };
const queues = new Map<string, Promise<unknown>>();
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const now = () => new Date().toISOString();
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function object(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "Expected an object");
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string, max: number, empty = false): string {
  requireValue(typeof value === "string" && value.length <= max && (empty || value.trim().length > 0), `${name} must be ${empty ? "0" : "1"}–${max} characters`);
  requireValue(!value.includes("\0"), `${name} cannot contain a null byte`);
  return value;
}
function slug(value: unknown, name = "ID", max = 80): string {
  const result = string(value, name, max);
  requireValue(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result), `${name} must be a lowercase slug, not a path`);
  return result;
}
function importId(value: unknown): string {
  requireValue(typeof value === "string" && /^src-[a-f0-9]{64}$/.test(value), "Invalid source import ID");
  return value;
}
function strings(value: unknown, name: string, maxCount: number, maxChars: number): string[] {
  requireValue(Array.isArray(value) && value.length <= maxCount, `${name} must contain at most ${maxCount} strings`);
  return [...new Set(value.map((entry) => string(entry, name, maxChars)))];
}
function normalizeProfile(value: unknown): StudioProfile {
  const p = object(value);
  requireValue(Number.isInteger(p.teamId) && Number(p.teamId) > 0 && Number(p.teamId) <= 1_000_000, "teamId must be a positive integer");
  const profile: StudioProfile = { id: slug(p.id, "Profile ID", 64), teamId: Number(p.teamId),
    displayName: string(p.displayName, "Display name", 120).trim(),
    aliases: strings(p.aliases, "Aliases", STUDIO_LIMITS.aliases, 120).map((s) => s.trim()),
    background: string(p.background, "Background", STUDIO_LIMITS.backgroundChars, true),
    roastNotes: string(p.roastNotes, "Roast notes", STUDIO_LIMITS.roastNotesChars, true),
    avoidTopics: strings(p.avoidTopics, "Avoid topics", 30, 200) };
  if (p.assets !== undefined) {
    requireValue(Array.isArray(p.assets) && p.assets.length <= 20, "At most 20 asset references are supported");
    profile.assets = p.assets.map(normalizeAsset);
  }
  return profile;
}
function normalizeAsset(value: unknown): StudioAsset {
  const asset = object(value);
  requireValue(asset.kind === "portrait" || asset.kind === "reference", "Invalid asset kind");
  return { id: slug(asset.id, "Asset ID"), kind: asset.kind,
    ...(asset.label !== undefined ? { label: string(asset.label, "Asset label", 120) } : {}) };
}

async function lockDescriptor(fd: number): Promise<void> {
  // Linux flock belongs to the inherited open-file description. The parent FD
  // retains the lock after this fixed, non-shell helper exits; a crash releases it.
  // Never unlink the guard inode: every writer must lock the same object.
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/flock", ["--exclusive", "--nonblock", "3"],
      { stdio: ["ignore", "ignore", "ignore", fd], timeout: 2000 });
    child.once("error", () => reject(new Error("Studio could not acquire its filesystem guard")));
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Studio is busy in another process; retry after its write completes")));
  });
}
function identity(author: string | null, profiles: StudioProfile[]): Pick<StudioMessage, "memberId" | "identity"> {
  if (!author) return { memberId: null, identity: "unmapped" };
  const name = author.trim().toLocaleLowerCase("en-US");
  const matches = profiles.filter((p) => [p.displayName, ...p.aliases].some((a) => a.trim().toLocaleLowerCase("en-US") === name));
  return matches.length === 1 ? { memberId: matches[0].id, identity: "mapped" }
    : { memberId: null, identity: matches.length ? "ambiguous" : "unmapped" };
}
function parseMessages(text: string, id: string): StoredMessage[] {
  const parsed: { author: string | null; timestamp: string | null; text: string }[] = [];
  const trimmed = text.trim();
  let json: unknown;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try { json = JSON.parse(trimmed); } catch { /* A timestamped text export is not necessarily JSON. */ }
  }
  const jsonMessages = Array.isArray(json) && json.every((m) => m && typeof m === "object" && typeof m.text === "string")
    ? json : json && typeof json === "object" && !Array.isArray(json) ? (json as { messages?: unknown }).messages : undefined;
  if (Array.isArray(jsonMessages)) {
    requireValue(jsonMessages.length <= STUDIO_LIMITS.messagesPerImport, "Too many source messages");
    for (const item of jsonMessages) {
      const m = object(item);
      parsed.push({ author: m.author === undefined || m.author === null || m.author === "" ? null : string(m.author, "Message author", 120),
        timestamp: m.timestamp === undefined || m.timestamp === null || m.timestamp === "" ? null : string(m.timestamp, "Message timestamp", 100),
        text: string(m.text, "Message text", STUDIO_LIMITS.chunkChars) });
    }
  } else if (json !== undefined) {
    parsed.push({ author: null, timestamp: null, text });
  } else {
    let current: { author: string | null; timestamp: string | null; text: string } | undefined;
    const flush = () => {
      if (current?.text.trim()) {
        requireValue(parsed.length < STUDIO_LIMITS.messagesPerImport, "Too many source messages");
        parsed.push(current);
      }
      current = undefined;
    };
    for (const originalLine of text.split(/\r?\n/)) {
      const line = originalLine.replace(/^[\uFEFF\u200e\u200f]+/, "");
      const bracket = line.match(/^\[([^\]\r\n]{1,100})\]\s+([^:\r\n]{1,120}):\s?(.*)$/);
      const whatsapp = line.match(/^(\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4},?\s+[^\r\n]{1,35}?)\s+-\s+([^:\r\n]{1,120}):\s?(.*)$/);
      const named = line.match(/^([^:\r\n]{1,120}):[ \t]+(.*)$/);
      const match = bracket ?? whatsapp;
      if (match || named) {
        flush();
        current = { timestamp: match ? match[1] : null, author: (match ? match[2] : named![1]).trim(), text: match ? match[3] : named![2] };
      } else if (!line.trim() && current?.author) {
        current.text += "\n";
      } else if (!line.trim() || /^\[\d|^\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4}[, ]/.test(line)) {
        flush();
        if (originalLine.trim()) current = { author: null, timestamp: null, text: originalLine };
      } else if (current) current.text += `\n${originalLine}`;
      else current = { author: null, timestamp: null, text: originalLine };
    }
    flush();
  }
  const bounded: typeof parsed = [];
  for (const message of parsed) {
    if (message.author !== null || message.timestamp !== null) bounded.push(message);
    else {
      // Unstructured prose has no real message boundaries. Preserve exact substrings
      // in bounded unattributed blocks, including multi-byte Unicode content.
      let rest = message.text;
      while (rest) {
        let end = Math.min(rest.length, 7_500);
        while (Buffer.byteLength(rest.slice(0, end), "utf8") > 12_000) end = Math.floor(end * 0.9);
        if (end < rest.length && /[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
        bounded.push({ author: null, timestamp: null, text: rest.slice(0, end) }); rest = rest.slice(end);
      }
    }
  }
  requireValue(bounded.length > 0 && bounded.length <= STUDIO_LIMITS.messagesPerImport, "Source must contain 1–20000 messages or unattributed blocks");
  return bounded.map((m, index) => ({ ...m, id: `msg-${id.slice(4)}-${String(index).padStart(5, "0")}`, importId: id, index }));
}
function makeChunks(messages: StudioMessage[], id: string): StudioChunk[] {
  const result: StudioChunk[] = [];
  const render = (items: StudioMessage[]) => items.map((m) => `[${m.id}]${m.timestamp ? ` [${m.timestamp}]` : ""} ${m.author ?? "Unattributed"}: ${m.text}`).join("\n\n");
  const fits = (items: StudioMessage[]) => render(items).length <= STUDIO_LIMITS.chunkChars
    && Buffer.byteLength(JSON.stringify({ messageIds: items.map((m) => m.id),
      // Reserve the longest identity representation so later alias edits cannot
      // change chunk boundaries or make an imported message exceed its budget.
      messages: items.map((m) => ({ ...m, memberId: "x".repeat(64), identity: "ambiguous" })) }), "utf8") <= STUDIO_LIMITS.chunkMessageBytes;
  let group: StudioMessage[] = [];
  const flush = () => {
    if (!group.length) return;
    const index = result.length;
    result.push({ id: `chunk-${id.slice(4)}-${String(index).padStart(5, "0")}`, importId: id, index,
      messageIds: group.map((m) => m.id), messages: group, text: render(group) }); group = [];
  };
  for (const message of messages) {
    requireValue(fits([message]), `Source message ${message.index + 1} is too long to fit intact in a 12000-character / 16000-byte chunk`);
    if (!fits([...group, message])) flush();
    group.push(message);
  }
  flush(); return result;
}

/** Private source material is data. This store never executes, fetches, or follows it. */
export class LeagueStudioStore {
  readonly directory: string;
  constructor(directory = path.join(getDataRoot(), "private", "studio")) { this.directory = path.resolve(directory); }
  private filename(name: string) { return path.join(this.directory, name); }
  private async prepare() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    requireValue(stat.isDirectory() && !stat.isSymbolicLink(), "Studio directory must be a real private directory");
    await fs.chmod(this.directory, 0o700);
  }
  private async readText(name: string, limit: number): Promise<string> {
    const handle = await fs.open(this.filename(name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      requireValue(stat.isFile() && stat.size <= limit, "Studio file exceeds its size limit");
      const data = Buffer.alloc(stat.size + 1); let offset = 0;
      while (offset < data.length) { const r = await handle.read(data, offset, data.length - offset, offset); if (!r.bytesRead) break; offset += r.bytesRead; }
      requireValue(offset <= stat.size, "Studio file changed while reading");
      return data.subarray(0, offset).toString("utf8");
    } finally { await handle.close(); }
  }
  private async atomic(name: string, text: string) {
    const temp = this.filename(`.${name}.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temp, "wx", 0o600);
      try { await handle.chmod(0o600); await handle.writeFile(text, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, this.filename(name));
      const directory = await fs.open(this.directory, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
    finally { await fs.unlink(temp).catch((e) => { if (e.code !== "ENOENT") throw e; }); }
  }
  private async writeOwner(): Promise<WriteOwner | null> {
    let text;
    try { text = await this.readText(".write-lock", 1024); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    let owner: WriteOwner;
    try { owner = JSON.parse(text); }
    catch { throw new Error("Studio write lock has no verifiable owner; refusing to reclaim it"); }
    requireValue(owner?.schema === 1 && Number.isInteger(owner.pid) && owner.pid > 0 && owner.pid <= 2_147_483_647
      && typeof owner.token === "string" && /^[a-f0-9-]{36}$/.test(owner.token),
    "Studio write lock has no verifiable owner; refusing to reclaim it");
    return owner;
  }
  private async acquireWriteOwner(): Promise<WriteOwner> {
    const previous = await this.writeOwner();
    if (previous) {
      let dead = false;
      try { process.kill(previous.pid, 0); }
      catch (e) { dead = (e as NodeJS.ErrnoException).code === "ESRCH"; }
      requireValue(dead, "Studio write owner is alive or cannot be verified dead; retry after its write completes");
      // The OS guard serializes this read/reclaim/publish sequence across processes.
      // Check ownership too; never use a timestamp to decide that a writer died.
      const confirmed = await this.writeOwner();
      requireValue(confirmed?.pid === previous.pid && confirmed.token === previous.token, "Studio write ownership changed during reclaim");
      await fs.unlink(this.filename(".write-lock"));
    }
    const owner: WriteOwner = { schema: 1, pid: process.pid, token: randomUUID(), createdAt: now() };
    // Atomic publication prevents an empty ownerless lock if this process crashes.
    await this.atomic(".write-lock", JSON.stringify(owner));
    return owner;
  }
  private async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.directory) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await this.prepare();
      const guard = await fs.open(this.filename(".write-guard"), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        requireValue((await guard.stat()).isFile(), "Studio filesystem guard must be a regular file");
        await guard.chmod(0o600);
        await lockDescriptor(guard.fd);
        const owner = await this.acquireWriteOwner();
        try { return await operation(); }
        finally {
          const current = await this.writeOwner();
          requireValue(current?.pid === owner.pid && current.token === owner.token, "Studio write ownership changed before release");
          await fs.unlink(this.filename(".write-lock"));
        }
      } finally { await guard.close(); }
    });
    queues.set(this.directory, next);
    try { return await next; } finally { if (queues.get(this.directory) === next) queues.delete(this.directory); }
  }
  async read(): Promise<StudioState> {
    try {
      const state = JSON.parse(await this.readText("state.json", 24 * 1024 * 1024));
      requireValue(state.schema === 1 && Array.isArray(state.profiles) && state.profiles.length <= STUDIO_LIMITS.profiles
        && Array.isArray(state.imports) && state.imports.length <= STUDIO_LIMITS.imports
        && Array.isArray(state.memories) && state.memories.length <= STUDIO_LIMITS.memories, "Unsupported or malformed studio state");
      return state as StudioState;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { schema: 1, updatedAt: now(), profiles: [], imports: [], memories: [] }; throw e; }
  }
  private async persist(state: StudioState) { state.updatedAt = now(); await this.atomic("state.json", JSON.stringify(state) + "\n"); }
  async saveProfile(profile: unknown): Promise<StudioProfile> {
    const normalized = normalizeProfile(profile);
    return this.transaction(async () => {
      const state = await this.read(), index = state.profiles.findIndex((p) => p.id === normalized.id);
      requireValue(index >= 0 || state.profiles.length < STUDIO_LIMITS.profiles, "Profile limit reached");
      if (index < 0) state.profiles.push(normalized); else state.profiles[index] = normalized;
      await this.persist(state); return normalized;
    });
  }
  async appendProfileAsset(profileId: string, asset: StudioAsset): Promise<StudioProfile> {
    slug(profileId, "Profile ID", 64);
    const normalized = normalizeAsset(asset);
    return this.transaction(async () => {
      const state = await this.read(), profile = state.profiles.find((p) => p.id === profileId);
      requireValue(profile, "Unknown profile");
      const assets = profile.assets ?? [];
      const existing = assets.find((a) => a.id === normalized.id);
      if (existing) {
        requireValue(existing.kind === normalized.kind, "Asset ID already refers to a different asset kind");
        return profile;
      }
      requireValue(assets.length < 20, "At most 20 asset references are supported");
      profile.assets = [...assets, normalized];
      await this.persist(state);
      return profile;
    });
  }
  async importSource(input: { label: string; text: string; kind: "background" | "group_chat" }): Promise<{ source: StudioImport; created: boolean }> {
    const label = string(input.label, "Source label", 160).trim();
    requireValue(input.kind === "background" || input.kind === "group_chat", "Invalid source kind");
    const text = string(input.text, "Source text", STUDIO_LIMITS.importBytes);
    const bytes = Buffer.byteLength(text, "utf8");
    requireValue(bytes <= STUDIO_LIMITS.importBytes, "Source exceeds the 5 MB UTF-8 limit");
    const contentHash = hash(text), id = `src-${contentHash}`;
    return this.transaction(async () => {
      const state = await this.read(), existing = state.imports.find((s) => s.id === id);
      if (existing) return { source: existing, created: false };
      requireValue(state.imports.length < STUDIO_LIMITS.imports, "Source import limit reached");
      const messages = parseMessages(text, id);
      const chunks = makeChunks(messages.map((m) => ({ ...m, ...identity(m.author, state.profiles) })), id);
      const source: StudioImport = { id, label, kind: input.kind, contentHash, bytes, createdAt: now(), messageCount: messages.length, chunkCount: chunks.length };
      await this.atomic(`${id}.txt`, text);
      await this.atomic(`${id}.json`, JSON.stringify({ schema: 1, importId: id, messages } satisfies SourceDocument));
      state.imports.push(source); await this.persist(state); return { source, created: true };
    });
  }
  private async sourceDocument(id: string, state: StudioState): Promise<SourceDocument> {
    importId(id); requireValue(state.imports.some((s) => s.id === id), "Unknown source import");
    const source = JSON.parse(await this.readText(`${id}.json`, 16 * 1024 * 1024)) as SourceDocument;
    requireValue(source.schema === 1 && source.importId === id && Array.isArray(source.messages)
      && source.messages.length <= STUDIO_LIMITS.messagesPerImport, "Malformed private source document");
    return source;
  }
  async listChunks(id: string): Promise<StudioChunk[]> {
    importId(id); const state = await this.read(), source = await this.sourceDocument(id, state);
    return makeChunks(source.messages.map((m) => ({ ...m, ...identity(m.author, state.profiles) })), id);
  }
  async readSource(id: string): Promise<{ source: StudioImport; text: string }> {
    importId(id); const state = await this.read(), source = state.imports.find((s) => s.id === id);
    requireValue(source, "Unknown source import"); return { source, text: await this.readText(`${id}.txt`, STUDIO_LIMITS.importBytes) };
  }
  private validateMemory(value: unknown, id: string, state: StudioState, source: SourceDocument): StudioMemoryInput & { id: string } {
    const m = object(value);
    requireValue(typeof m.kind === "string" && ["background", "running_joke", "quote", "rivalry"].includes(m.kind), "Invalid memory kind");
    const text = string(m.text, "Memory text", STUDIO_LIMITS.memoryChars);
    const memberIds = strings(m.memberIds, "Member IDs", 16, 64).sort();
    const sourceIds = strings(m.sourceIds, "Source IDs", 20, 100).sort();
    requireValue(sourceIds.length > 0, "A memory needs at least one exact source message ID");
    requireValue(memberIds.every((member) => state.profiles.some((p) => p.id === member)), "Memory names an unknown member ID");
    const messages = new Map(source.messages.map((message) => [message.id, message]));
    requireValue(sourceIds.every((sourceId) => messages.has(sourceId)), "Memory cites a source ID outside this import");
    requireValue(m.confidence === "explicit" || m.confidence === "inferred", "Invalid memory confidence");
    requireValue(typeof m.enabled === "boolean", "Memory enabled must be boolean");
    if (m.kind === "quote") requireValue(sourceIds.some((sourceId) => messages.get(sourceId)!.text.includes(text)), "Quote is not an exact substring of a cited source message");
    const fields = { kind: m.kind as StudioMemoryInput["kind"], text, memberIds, sourceIds,
      confidence: m.confidence as StudioMemoryInput["confidence"], enabled: m.enabled };
    return { ...fields, id: m.id === undefined ? `mem-${hash(JSON.stringify({ importId: id, ...fields, enabled: undefined }))}` : slug(m.id, "Memory ID") };
  }
  async addMemories(id: string, memories: unknown[]): Promise<{ accepted: StudioMemory[]; failures: StudioMemoryFailure[] }> {
    importId(id); requireValue(Array.isArray(memories) && memories.length <= STUDIO_LIMITS.memoriesPerBatch, "At most 100 memories can be added per batch");
    return this.transaction(async () => {
      const state = await this.read(), source = await this.sourceDocument(id, state);
      const accepted: StudioMemory[] = [], failures: StudioMemoryFailure[] = [];
      for (let index = 0; index < memories.length; index++) {
        try {
          const memory = this.validateMemory(memories[index], id, state, source);
          const existing = state.memories.find((m) => m.id === memory.id);
          if (existing) {
            requireValue(existing.importId === id && existing.kind === memory.kind && existing.text === memory.text
              && JSON.stringify(existing.memberIds) === JSON.stringify(memory.memberIds)
              && JSON.stringify(existing.sourceIds) === JSON.stringify(memory.sourceIds), "Memory ID already belongs to different evidence");
            accepted.push(existing); continue;
          }
          requireValue(state.memories.length < STUDIO_LIMITS.memories, "Memory limit reached");
          const saved = { ...memory, importId: id, createdAt: now(), updatedAt: now() };
          state.memories.push(saved); accepted.push(saved);
        } catch (e) {
          failures.push({ index, reason: e instanceof Error ? e.message : "Invalid memory" });
        }
      }
      if (accepted.length) await this.persist(state);
      return { accepted, failures };
    });
  }
  async updateMemory(id: string, patch: { enabled: boolean; text?: string }): Promise<StudioMemory> {
    slug(id, "Memory ID"); requireValue(typeof patch.enabled === "boolean", "Memory enabled must be boolean");
    return this.transaction(async () => {
      const state = await this.read(), index = state.memories.findIndex((m) => m.id === id);
      requireValue(index >= 0, "Unknown memory");
      const memory = state.memories[index], source = await this.sourceDocument(memory.importId, state);
      const updated = this.validateMemory({ ...memory, enabled: patch.enabled, ...(patch.text !== undefined ? { text: patch.text } : {}) }, memory.importId, state, source);
      state.memories[index] = { ...memory, ...updated, updatedAt: now() }; await this.persist(state); return state.memories[index];
    });
  }
  async getContext(memberIds?: string[], query?: string, limit = 20): Promise<StudioContext> {
    requireValue(Number.isInteger(limit) && limit >= 0 && limit <= 50, "Context limit must be an integer from 0 to 50");
    if (memberIds !== undefined) strings(memberIds, "Member IDs", 64, 64).forEach((id) => slug(id, "Member ID", 64));
    if (query !== undefined) string(query, "Query", 300, true);
    const state = await this.read(), selected = memberIds === undefined ? null : new Set(memberIds);
    if (selected) requireValue([...selected].every((id) => state.profiles.some((p) => p.id === id)), "Context names an unknown member ID");
    const words = [...new Set((query ?? "").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
    const score = (memory: StudioMemory) => words.reduce((n, word) => n + Number(memory.text.toLocaleLowerCase("en-US").includes(word)), 0);
    const memories = state.memories.filter((m) => m.enabled && (!selected || m.memberIds.some((id) => selected.has(id))) && (!words.length || score(m) > 0))
      .sort((a, b) => score(b) - score(a) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, limit);
    const profiles = state.profiles.filter((p) => !selected || selected.has(p.id)).map((p) => ({ ...p,
      background: p.background.slice(0, 1600), roastNotes: p.roastNotes.slice(0, 1000) }));
    const result: StudioContext = { profiles, memories, sourceIds: [], untrustedSourceData: true,
      truncated: profiles.some((p) => state.profiles.find((full) => full.id === p.id)!.background.length > 1600
        || state.profiles.find((full) => full.id === p.id)!.roastNotes.length > 1000) };
    const updateSources = () => { result.sourceIds = [...new Set(result.memories.flatMap((m) => m.sourceIds))]; };
    updateSources();
    while (Buffer.byteLength(JSON.stringify(result), "utf8") > STUDIO_LIMITS.contextBytes) {
      result.truncated = true;
      if (result.memories.length) result.memories.pop(); else if (result.profiles.length) result.profiles.pop(); else break;
      updateSources();
    }
    return result;
  }
}
