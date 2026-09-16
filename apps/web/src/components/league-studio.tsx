"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

type Profile = { id: string; teamId: number; displayName: string; aliases: string[]; background: string; roastNotes: string; avoidTopics: string[]; assets?: { id: string; kind: string; label?: string }[] };
type Import = { id: string; label: string; kind: string; text?: string; createdAt?: string };
type SourceExcerpt = { source: { id: string; label: string }; message: { id: string; author: string | null; timestamp: string | null; text: string } };
type Memory = { id: string; importId?: string; kind: string; text: string; memberIds: string[]; sourceIds: string[]; confidence: "explicit" | "inferred"; enabled: boolean };
type Asset = { id: string; label: string; kind: "portrait" | "reference" | "generated"; memberId?: string; playerId?: number; mime: string };
type Job = { id: string; kind: string; status: string; stage: string; progress: { done: number; total: number }; error?: string; resultId?: string };
type Scene = { id: string; title: string; commentary: string; evidenceIds: string[]; memoryIds?: string[]; memberIds: string[]; playerIds: number[]; imageBrief?: string; assetId?: string };
type Board = { id: string; title: string; season: number; week: number; teamId: number; scenes: Scene[]; evidence?: Record<string, unknown>; memories?: Pick<Memory, "id" | "text" | "sourceIds" | "confidence">[] };
type StudioData = { state: { profiles: Profile[]; imports: Import[]; memories: Memory[] }; teams: { id: number; name: string }[]; players: { id: number; name: string }[]; assets: Asset[]; jobs: Job[]; boards: Board[] };
type Act = (action: string, payload: Record<string, unknown>, notice?: string) => Promise<boolean>;
type Shared = { data: StudioData; act: Act; busy: string; aiBusy: boolean };
const assetUrl = (id: string) => `/api/studio/assets/${encodeURIComponent(id)}`;
const list = (value: string) => value.split(/[,\n]/).map((part) => part.trim()).filter(Boolean);
const freshProfile = (teamId = 0): Profile => ({ id: "", teamId, displayName: "", aliases: [], background: "", roastNotes: "", avoidTopics: [] });
const slug = (name: string) => name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
function sourceLabel(id: string, sources: Import[]) {
  const message = /^msg-([a-f0-9]{64})-(\d+)$/.exec(id);
  const source = sources.find((entry) => entry.id === (message ? `src-${message[1]}` : id));
  if (message) return `${source?.label ?? "Saved source"}, message ${Number(message[2]) + 1}`;
  return source?.label ?? id;
}
function evidenceLabel(id: string) {
  if (id.startsWith("matchup-")) return "Matchup result";
  if (id.startsWith("lineup-")) return "Best eligible lineup (hindsight)";
  if (id.startsWith("play-")) return "Scoring play";
  if (id === "verified-feature-play") return "Featured play";
  if (id === "league-results") return "League results";
  return id;
}
function EvidenceValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span>Unavailable</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (typeof value !== "object") return <span>{String(value)}</span>;
  if (Array.isArray(value)) return value.length ? <ul className="studio-fact-list">{value.map((item, index) => <li key={index}><EvidenceValue value={item} /></li>)}</ul> : <span>None</span>;
  return <dl className="studio-facts">{Object.entries(value).map(([key, item]) => <div key={key}><dt>{key.replace(/_/g, " ")}</dt><dd><EvidenceValue value={item} /></dd></div>)}</dl>;
}

async function responseBody(response: Response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `The request failed (${response.status}). Please try again.`);
  return body;
}

function SourceCitation({ id, sources }: { id: string; sources: Import[] }) {
  const [open, setOpen] = useState(false);
  const [excerpt, setExcerpt] = useState<SourceExcerpt | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    setLoading(true); setError("");
    try {
      const body = await responseBody(await fetch(`/api/studio/sources/${encodeURIComponent(id)}`, { cache: "no-store" }));
      if (body.message?.id !== id || typeof body.message.text !== "string") throw new Error("This saved message is unavailable.");
      setExcerpt(body as SourceExcerpt);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not read this saved message."); }
    finally { setLoading(false); }
  }
  return <details className="studio-source-citation" onToggle={(event) => {
    const expanded = event.currentTarget.open;
    setOpen(expanded);
    if (expanded && !excerpt && !loading && !error) void load();
  }}><summary>{sourceLabel(id, sources)}</summary>{open && <div className="studio-source-excerpt">
    {loading && <p role="status">Reading saved message…</p>}
    {error && <div role="alert"><p className="studio-error">{error}</p><button type="button" disabled={loading} onClick={() => void load()}>Try again</button></div>}
    {excerpt && <>{(excerpt.message.author || excerpt.message.timestamp) && <p className="studio-source-byline">{[excerpt.message.author, excerpt.message.timestamp].filter(Boolean).join(" · ")}</p>}<p>{excerpt.message.text}</p></>}
  </div>}</details>;
}

function SourceCitations({ ids, sources }: { ids: string[]; sources: Import[] }) {
  return <div className="studio-source-list">{ids.length ? [...new Set(ids)].map((id) => <SourceCitation key={id} id={id} sources={sources} />) : <span>Source unavailable</span>}</div>;
}

export function LeagueStudio() {
  const [data, setData] = useState<StudioData | null>(null);
  const [auth, setAuth] = useState<"checking" | "locked" | "ready">("checking");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [tab, setTab] = useState<"people" | "history" | "scenes">("people");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const initialized = useRef(false);
  const refreshing = useRef(false);

  const reload = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const response = await fetch("/api/studio", { cache: "no-store" });
      if (response.status === 401) { setAuth("locked"); setData(null); return; }
      const body = await responseBody(response);
      setData(body as StudioData); setAuth("ready");
    } finally { refreshing.current = false; }
  }, []);

  const login = useCallback(async (access: string) => {
    setBusy("login"); setError("");
    try {
      await responseBody(await fetch("/api/studio/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: access }) }));
      setToken(""); await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not open the studio."); setAuth("locked"); }
    finally { setBusy(""); }
  }, [reload]);

  useEffect(() => {
    const acceptAccessLink = () => {
      const access = new URLSearchParams(window.location.hash.slice(1)).get("access");
      if (!access) return false;
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      void login(access);
      return true;
    };
    window.addEventListener("hashchange", acceptAccessLink);
    if (!initialized.current) {
      initialized.current = true;
      if (!acceptAccessLink()) void reload().catch((reason) => { setError(reason instanceof Error ? reason.message : "Could not load the studio."); setAuth("locked"); });
    }
    return () => window.removeEventListener("hashchange", acceptAccessLink);
  }, [login, reload]);

  const aiBusy = data?.jobs.some((job) => job.status === "running") ?? false;
  useEffect(() => {
    if (!aiBusy || auth !== "ready") return;
    const timer = window.setInterval(() => { void reload().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not refresh activity.")); }, 3000);
    return () => window.clearInterval(timer);
  }, [aiBusy, auth, reload]);

  const act: Act = async (action, payload, message = "Saved.") => {
    setBusy(action); setError(""); setNotice("");
    try {
      const response = await fetch("/api/studio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
      if (response.status === 401) { setAuth("locked"); setData(null); throw new Error("Your session expired. Enter your access code to continue."); }
      const body = await responseBody(response);
      if (body.job) setData((current) => current ? { ...current, jobs: [body.job, ...current.jobs.filter((job) => job.id !== body.job.id)] } : current);
      setNotice(message); await reload(); return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save. Please try again."); return false; }
    finally { setBusy(""); }
  };

  async function upload(form: FormData) {
    setBusy("upload"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/studio/assets", { method: "POST", body: form });
      if (response.status === 401) { setAuth("locked"); setData(null); throw new Error("Your session expired. Enter your access code to continue."); }
      await responseBody(response);
      setNotice("Photo added."); await reload(); return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not upload the photo."); return false; }
    finally { setBusy(""); }
  }

  async function logout() {
    setBusy("logout"); setError("");
    try { await responseBody(await fetch("/api/studio/session", { method: "DELETE" })); setData(null); setNotice(""); setAuth("locked"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not sign out. Please try again."); }
    finally { setBusy(""); }
  }

  return <main className="studio-page"><div className="studio-wrap">
    <header className="studio-header"><div><Link href="/" className="studio-brand">Mod League</Link><h1>League studio</h1></div><nav aria-label="Studio navigation"><Link href="/">View the week</Link>{auth === "ready" && <button type="button" disabled={!!busy} onClick={() => void logout()}>Sign out</button>}</nav></header>
    {error && <div className="studio-error studio-page-error" role="alert"><p>{error}</p>{auth === "ready" && <button type="button" onClick={() => { setError(""); void reload().catch((reason) => setError(String(reason))); }}>Refresh studio</button>}</div>}
    {auth === "checking" ? <p className="studio-loading" role="status">Opening your studio…</p> : auth === "locked" ? <section className="studio-access">
      <h2>Open the private studio</h2><p>Add the people, stories and photos behind your league.</p>
      <form onSubmit={(event) => { event.preventDefault(); void login(token); }} aria-busy={busy === "login"}>
        <label>Access code<input type={showToken ? "text" : "password"} autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} required /></label>
        <label className="studio-check"><input type="checkbox" checked={showToken} onChange={(event) => setShowToken(event.target.checked)} />Show code</label>
        <button className="studio-primary" disabled={!!busy || !token.trim()}>{busy === "login" ? "Opening…" : "Open studio"}</button>
      </form>
    </section> : data && <>
      <nav className="studio-tabs" aria-label="Studio sections">{([['people', 'People'], ['history', 'League history'], ['scenes', 'Scenes']] as const).map(([value, label]) => <button key={value} type="button" aria-current={tab === value ? "page" : undefined} onClick={() => setTab(value)}>{label}</button>)}</nav>
      {notice && <p className="studio-notice" role="status">{notice}</p>}
      <div hidden={tab !== "people"}><People data={data} act={act} busy={busy} aiBusy={aiBusy} upload={upload} /></div>
      <div hidden={tab !== "history"}><History data={data} act={act} busy={busy} aiBusy={aiBusy} /></div>
      <div hidden={tab !== "scenes"}><Scenes data={data} act={act} busy={busy} aiBusy={aiBusy} /></div>
      {!!data.jobs.length && <section className="studio-activity" aria-labelledby="studio-activity-title"><h2 id="studio-activity-title">Activity</h2><ul>{data.jobs.slice(0, 8).map((job) => <li key={job.id}>
        <div className="studio-activity-heading"><strong>{({ analyze: "History analysis", storyboard: "Scene draft", render: "Image render" } as Record<string, string>)[job.kind] ?? job.kind}</strong><span>{job.status}</span></div>
        <p>{job.stage}</p>{job.status === "running" && job.progress?.total > 0 && <div className="studio-progress"><progress value={job.progress.done} max={job.progress.total} aria-label={job.stage} /><span>{job.progress.done}/{job.progress.total}</span></div>}
        {job.error && <p className="studio-error">{job.error}</p>}
        {job.kind === "storyboard" && job.resultId && ["failed", "paused", "interrupted"].includes(job.status) && <button type="button" disabled={!!busy || aiBusy} onClick={() => void act("resume", { jobId: job.resultId }, "Scene drafting resumed. Follow its progress in Activity.")}>{busy === "resume" ? "Resuming…" : "Resume scene draft"}</button>}
      </li>)}</ul></section>}
    </>}
  </div></main>;
}

function People({ data, act, busy, upload }: Shared & { upload: (form: FormData) => Promise<boolean> }) {
  const [draft, setDraft] = useState<Profile>(() => freshProfile(data.teams[0]?.id));
  const [aliases, setAliases] = useState("");
  const [avoid, setAvoid] = useState("");
  const [target, setTarget] = useState("member");
  const [memberId, setMemberId] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [photoLabel, setPhotoLabel] = useState("");
  const [photoKind, setPhotoKind] = useState("portrait");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [localError, setLocalError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!file) { setPreview(""); return; } const url = URL.createObjectURL(file); setPreview(url); return () => URL.revokeObjectURL(url); }, [file]);
  function edit(profile: Profile) { setDraft({ ...profile }); setAliases(profile.aliases.join(", ")); setAvoid(profile.avoidTopics.join(", ")); setMemberId(profile.id); setLocalError(""); }
  async function save(event: FormEvent) {
    event.preventDefault(); setLocalError("");
    const id = draft.id || slug(draft.displayName);
    if (!id) { setLocalError("Add a name with letters or numbers."); return; }
    if (!draft.id && data.state.profiles.some((profile) => profile.id === id)) { setLocalError("That name is already saved. Choose the existing person to edit their profile."); return; }
    const profile = { ...draft, id, aliases: list(aliases), avoidTopics: list(avoid), assets: data.state.profiles.find((saved) => saved.id === id)?.assets ?? draft.assets };
    if (await act("profile", { profile }, `${profile.displayName} saved.`)) { setDraft(profile); setMemberId(id); }
  }
  async function savePhoto(event: FormEvent) {
    event.preventDefault(); if (!file) return;
    const form = new FormData(); form.set("file", file); form.set("label", photoLabel.trim() || file.name); form.set("kind", photoKind);
    if (target === "member") form.set("memberId", memberId); else form.set("playerId", playerId);
    if (await upload(form)) { setFile(null); setPhotoLabel(""); if (fileInput.current) fileInput.current.value = ""; }
  }
  return <div className="studio-people"><aside className="studio-member-list"><div className="studio-section-heading"><h2>People</h2><button type="button" onClick={() => edit(freshProfile(data.teams[0]?.id))}>Add person</button></div>
    {!data.state.profiles.length && <p className="studio-hint">Start with someone in the league.</p>}
    {data.state.profiles.map((profile) => { const photo = data.assets.find((asset) => asset.memberId === profile.id && asset.kind === "portrait"); return <button className="studio-member" type="button" key={profile.id} aria-pressed={draft.id === profile.id} onClick={() => edit(profile)}>{photo && <Image src={assetUrl(photo.id)} alt="" width={48} height={48} unoptimized />}<span>{profile.displayName}<small>{data.teams.find((team) => team.id === profile.teamId)?.name}</small></span></button>; })}
  </aside><div className="studio-editor">
    <form onSubmit={save} aria-busy={busy === "profile"}><h2>{draft.id ? draft.displayName : "Add a league member"}</h2><div className="studio-two-fields">
      <label>Name (required)<input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} required autoComplete="off" maxLength={120} /></label>
      <label>Team<select value={draft.teamId} onChange={(event) => setDraft({ ...draft, teamId: Number(event.target.value) })}>{data.teams.map((team) => <option value={team.id} key={team.id}>{team.name}</option>)}</select></label>
    </div><label>Nicknames<input value={aliases} onChange={(event) => setAliases(event.target.value)} autoComplete="off" placeholder="Separate names with commas" /></label>
      <label>Background<textarea rows={4} value={draft.background} onChange={(event) => setDraft({ ...draft, background: event.target.value })} placeholder="How you know them, league history, the stories everyone remembers." /></label>
      <label>Ribbing that lands<textarea rows={3} value={draft.roastNotes} onChange={(event) => setDraft({ ...draft, roastNotes: event.target.value })} placeholder="Their annual draft strategy, favorite excuses, long-running rivalries." /></label>
      <label>Off limits (optional)<input value={avoid} onChange={(event) => setAvoid(event.target.value)} autoComplete="off" placeholder="Separate topics with commas" /></label>
      {localError && <p className="studio-error" role="alert">{localError}</p>}<button className="studio-primary" disabled={!!busy}>{busy === "profile" ? "Saving…" : "Save person"}</button>
    </form>
    <section className="studio-photos"><h2>Reference photos</h2><p className="studio-hint">Assign each photo to the person it shows.</p>
      <form onSubmit={savePhoto} aria-busy={busy === "upload"}>
        <div className="studio-two-fields"><label>For<select value={target} onChange={(event) => setTarget(event.target.value)}><option value="member">League member</option><option value="player">NFL player</option></select></label>
          {target === "member" ? <label>Person<select required value={memberId} onChange={(event) => setMemberId(event.target.value)}><option value="">Choose a person</option>{data.state.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}</select></label> : <label>Player<select required value={playerId} onChange={(event) => setPlayerId(event.target.value)}><option value="">Choose a player</option>{(data.players ?? []).map((player) => <option value={player.id} key={player.id}>{player.name}</option>)}</select></label>}
        </div><div className="studio-two-fields"><label>Photo type<select value={photoKind} onChange={(event) => setPhotoKind(event.target.value)}><option value="portrait">Portrait</option><option value="reference">Reference photo</option></select></label><label>Label (optional)<input value={photoLabel} onChange={(event) => setPhotoLabel(event.target.value)} autoComplete="off" maxLength={160} /></label></div>
        <label>Photo<input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" required onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
        {preview && <Image className="studio-upload-preview" src={preview} alt="Selected photo preview" width={240} height={180} unoptimized />}
        <button className="studio-primary" disabled={!!busy || !file || (target === "member" ? !memberId : !playerId)}>{busy === "upload" ? "Uploading…" : "Add photo"}</button>
      </form>
      <div className="studio-photo-grid">{data.assets.filter((asset) => asset.kind !== "generated").map((asset) => { const person = asset.memberId ? data.state.profiles.find((profile) => profile.id === asset.memberId)?.displayName : data.players?.find((player) => player.id === asset.playerId)?.name; return <figure key={asset.id}><Image src={assetUrl(asset.id)} alt={asset.label} width={160} height={128} unoptimized /><figcaption>{asset.label}{person && person !== asset.label && <small>{person}</small>}</figcaption></figure>; })}</div>
    </section>
  </div></div>;
}

function History({ data, act, busy, aiBusy }: Shared) {
  const [label, setLabel] = useState(""); const [kind, setKind] = useState("background"); const [text, setText] = useState(""); const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  async function readFile(file?: File) {
    if (!file) return; setError("");
    if (!/\.(txt|json)$/i.test(file.name) || file.size > 5 * 1024 * 1024) { setError("Choose a .txt or .json file up to 5 MB."); return; }
    try { setText(await file.text()); if (!label) setLabel(file.name.replace(/\.[^.]+$/, "")); } catch { setError("Could not read that file. You can paste the text instead."); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setError("");
    if (new Blob([text]).size > 5 * 1024 * 1024) { setError("Keep each import under 5 MB. Split a longer history into separate imports."); return; }
    if (await act("import", { label, kind, text }, "History saved. Choose Analyze when you want to extract memories.")) { setText(""); setLabel(""); if (input.current) input.current.value = ""; }
  }
  return <div className="studio-history"><section><h2>Add league history</h2><form onSubmit={save} aria-busy={busy === "import"}>
    <div className="studio-two-fields"><label>Label (required)<input value={label} onChange={(event) => setLabel(event.target.value)} required autoComplete="off" maxLength={160} placeholder="College stories" /></label><label>Source<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="background">Background notes</option><option value="group_chat">Group chat</option></select></label></div>
    <label>Paste text<textarea rows={8} value={text} onChange={(event) => setText(event.target.value)} required /></label><label>Or choose a .txt or .json file<input ref={input} type="file" accept=".txt,.json,text/plain,application/json" onChange={(event) => void readFile(event.target.files?.[0])} /></label><p className="studio-hint">Up to 5 MB per import.</p>
    {error && <p className="studio-error" role="alert">{error}</p>}<button className="studio-primary" disabled={!!busy || !text.trim()}>{busy === "import" ? "Saving…" : "Save history"}</button>
  </form></section><section className="studio-imports"><h2>Saved sources</h2>{!data.state.imports.length && <p className="studio-hint">Your background notes and chats will appear here.</p>}<ul>{data.state.imports.map((source) => <li key={source.id}><div><strong>{source.label}</strong><small>{source.kind === "group_chat" ? "Group chat" : "Background notes"}</small></div><button type="button" disabled={!!busy || aiBusy} onClick={() => void act("analyze", { importId: source.id }, "Analysis started. Follow its progress in Activity.")}>Analyze with AI</button></li>)}</ul></section>
    <section className="studio-memories"><h2>League memories</h2><p className="studio-hint">Review extracted memories and choose which ones can appear in scenes.</p>{!data.state.memories.length && <p>Analyze a saved source to find stories, quotes and rivalries.</p>}{data.state.memories.map((memory) => <MemoryEditor key={memory.id} memory={memory} sources={data.state.imports} act={act} busy={busy} />)}</section>
  </div>;
}

function MemoryEditor({ memory, sources, act, busy }: { memory: Memory; sources: Import[]; act: Act; busy: string }) {
  const [editing, setEditing] = useState(false); const [text, setText] = useState(memory.text);
  return <article className="studio-memory"><div className="studio-memory-meta"><span>{memory.kind.replace(/_/g, " ")} · {memory.confidence === "explicit" ? "Explicit in source" : "Inferred"}</span><label className="studio-check"><input type="checkbox" checked={memory.enabled} disabled={!!busy} onChange={(event) => void act("memory", { id: memory.id, enabled: event.target.checked }, "Memory updated.")} />Use in scenes</label></div>
    {editing ? <form onSubmit={async (event) => { event.preventDefault(); if (await act("memory", { id: memory.id, enabled: memory.enabled, text }, "Memory saved.")) setEditing(false); }}><label>Memory<textarea rows={3} value={text} onChange={(event) => setText(event.target.value)} required /></label><div className="studio-actions"><button className="studio-primary" disabled={!!busy}>Save memory</button><button type="button" onClick={() => setEditing(false)}>Cancel</button></div></form> : <p>{memory.text}</p>}
    <div className="studio-memory-source"><SourceCitations ids={memory.sourceIds ?? []} sources={sources} />{!editing && <button type="button" onClick={() => { setText(memory.text); setEditing(true); }}>Edit</button>}</div>
  </article>;
}

function Scenes({ data, act, busy, aiBusy }: Shared) {
  const [teamId, setTeamId] = useState(data.teams[0]?.id ?? 0); const [season, setSeason] = useState("2026"); const [week, setWeek] = useState("1"); const [direction, setDirection] = useState(""); const [boardId, setBoardId] = useState("");
  const board = data.boards.find((entry) => entry.id === boardId) ?? data.boards[0];
  async function draft(event: FormEvent) { event.preventDefault(); await act("storyboard", { season: Number(season), week: Number(week), teamId, direction }, "Scene drafting started. Follow its progress in Activity."); }
  return <div className="studio-scenes"><section className="studio-board-form"><h2>Make this week a story</h2><form onSubmit={draft} aria-busy={busy === "storyboard"}>
    <label>Team<select value={teamId} onChange={(event) => setTeamId(Number(event.target.value))}>{data.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label><div className="studio-two-fields"><label>Season<input type="text" inputMode="numeric" pattern="20[0-9]{2}" value={season} onChange={(event) => setSeason(event.target.value)} required autoComplete="off" /></label><label>Week<input type="text" inputMode="numeric" pattern="([1-9]|1[0-8])" value={week} onChange={(event) => setWeek(event.target.value)} required autoComplete="off" /></label></div>
    <label>Direction<textarea rows={4} maxLength={2000} value={direction} onChange={(event) => setDirection(event.target.value)} placeholder="The friend who demanded a full investigation into a 0.2-point loss." /></label><button className="studio-primary" disabled={!!busy || aiBusy}>{busy === "storyboard" ? "Starting…" : "Draft scenes with AI"}</button>
  </form></section><section className="studio-boards"><div className="studio-section-heading"><h2>Scene drafts</h2>{data.boards.length > 1 && <label><span className="studio-sr-only">Choose a draft</span><select value={board?.id ?? ""} onChange={(event) => setBoardId(event.target.value)}>{data.boards.map((entry) => <option value={entry.id} key={entry.id}>{entry.title}</option>)}</select></label>}</div>
    {!board ? <p className="studio-hint">Draft a story, review its scenes, then render the images you want.</p> : <><h3>{board.title}</h3><p className="studio-hint">Week {board.week}, {board.season} · {data.teams.find((team) => team.id === board.teamId)?.name}</p>{board.scenes.map((scene, index) => <SceneEditor key={`${board.id}-${scene.id}`} scene={scene} index={index} board={board} data={data} act={act} busy={busy} aiBusy={aiBusy} />)}</>}
  </section></div>;
}

function SceneEditor({ scene, index, board, data, act, busy, aiBusy }: Shared & { scene: Scene; index: number; board: Board }) {
  const boardId = board.id;
  const [commentary, setCommentary] = useState(scene.commentary); const [brief, setBrief] = useState(scene.imageBrief ?? ""); const [editing, setEditing] = useState(false);
  const members = (scene.memberIds ?? []).map((id) => data.state.profiles.find((profile) => profile.id === id));
  const missing = (scene.memberIds ?? []).filter((id) => !data.assets.some((asset) => asset.memberId === id && asset.kind !== "generated") && !data.state.profiles.find((profile) => profile.id === id)?.assets?.length);
  const cast = [...members.map((profile, i) => profile?.displayName ?? scene.memberIds[i]), ...(scene.playerIds ?? []).map((id) => data.players?.find((player) => player.id === id)?.name ?? `Player ${id}`)];
  return <article className="studio-scene"><h4><span>{index + 1}.</span> {scene.title}</h4>{scene.assetId && <Image className="studio-scene-image" src={assetUrl(scene.assetId)} alt={scene.title} width={960} height={640} unoptimized />}
    <p className="studio-commentary">{scene.commentary}</p>{!!cast.length && <p className="studio-hint">Featuring {cast.join(", ")}</p>}
    <details className="studio-evidence"><summary>Evidence and image brief</summary><p>{scene.imageBrief || "No image brief yet."}</p>
      {(scene.evidenceIds ?? []).map((id) => <details className="studio-evidence-source" key={id}><summary>{evidenceLabel(id)}</summary><EvidenceValue value={board.evidence?.[id]} /></details>)}
      {(scene.memoryIds ?? []).map((id) => { const memory = board.memories?.find((entry) => entry.id === id) ?? data.state.memories.find((entry) => entry.id === id); return <div className="studio-scene-memory" key={id}><p>{memory?.text ?? "This league memory is unavailable."}</p>{memory && <><small>{memory.confidence === "explicit" ? "Explicit in source" : "Inferred"}</small><SourceCitations ids={memory.sourceIds} sources={data.state.imports} /></>}</div>; })}
    </details>
    {editing && <form onSubmit={async (event) => { event.preventDefault(); if (await act("scene", { boardId, sceneId: scene.id, commentary, imageBrief: brief }, "Scene saved.")) setEditing(false); }}><label>Commentary<textarea rows={3} value={commentary} onChange={(event) => setCommentary(event.target.value)} /></label><label>Image brief<textarea rows={4} value={brief} onChange={(event) => setBrief(event.target.value)} /></label><div className="studio-actions"><button className="studio-primary" disabled={!!busy}>Save scene</button><button type="button" onClick={() => setEditing(false)}>Cancel</button></div></form>}
    {!!missing.length && <p className="studio-hint">Add reference photos for {missing.map((id) => data.state.profiles.find((profile) => profile.id === id)?.displayName ?? id).join(", ")} in People.</p>}
    <div className="studio-actions"><button type="button" className="studio-primary" disabled={!!busy || aiBusy || !!missing.length || editing} onClick={() => void act("render", { boardId, sceneId: scene.id }, "Image rendering started. Follow its progress in Activity.")}>{scene.assetId ? "Render another image" : "Render image"}</button>{!editing && <button type="button" onClick={() => { setCommentary(scene.commentary); setBrief(scene.imageBrief ?? ""); setEditing(true); }}>Edit scene</button>}</div>
  </article>;
}
