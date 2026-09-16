"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { PhotoTemplate } from "@/types/studio-photos";

type Profile = { id: string; displayName: string; aliases: string[]; teamId: number };
type Props = { profiles: Profile[]; teams: { id: number; name: string }[]; players: { id: number; name: string }[] };
type PhotoLabel = PhotoTemplate["labels"][number];
type PhotoPanel = "ideas" | "names" | "cutouts";
type UploadResult = { filename: string; photoId?: string; status: "waiting" | "uploading" | "saved" | "error"; message?: string };
const assetUrl = (id: string) => `/api/studio/assets/${encodeURIComponent(id)}`;
const normalized = (text: string) => text.trim().toLocaleLowerCase();
const priority = (photo: PhotoTemplate) => Math.min(4, ...photo.memes.map((meme) => ({ high: 1, medium: 2, low: 3 })[meme.priority] ?? 3));
const imageNumbers = (name: string) => [...new Set([...name.matchAll(/(?:^|[^a-z0-9])IMG[_ -]?(\d{4,})(?=[^0-9]|$)/gi)].map((match) => String(Number(match[1]))))];
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : "The request failed. Please try again.";

async function readResponse(response: Response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : response.status === 401 ? "Your studio session expired. Sign in again to continue." : `The request failed (${response.status}).`);
  return body;
}

async function uploadCutout(photoId: string, file: File, memberIds: string[]) {
  if (!/\.(png|webp)$/i.test(file.name)) throw new Error("Choose a PNG or WebP cutout.");
  const form = new FormData();
  form.set("action", "cutout"); form.set("photoId", photoId); form.set("file", file); form.set("memberIds", JSON.stringify(memberIds));
  const body = await readResponse(await fetch("/api/studio/photos", { method: "POST", body: form }));
  if (!body.photo?.id) throw new Error("The upload response did not include a saved photo. Refresh the photo library before retrying.");
  return body.photo as PhotoTemplate;
}

export function LeaguePhotoLibrary({ profiles, teams, players }: Props) {
  const [photos, setPhotos] = useState<PhotoTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState("");
  const [event, setEvent] = useState("");
  const [sort, setSort] = useState("picks");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panel, setPanel] = useState<PhotoPanel>("ideas");
  const [batchBusy, setBatchBusy] = useState(false);
  const [uploads, setUploads] = useState<UploadResult[]>([]);
  const batchInput = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    setError("");
    try {
      const body = await readResponse(await fetch("/api/studio/photos", { cache: "no-store" }));
      if (!Array.isArray(body.photos)) throw new Error("The photo library response was incomplete.");
      setPhotos(body.photos);
      return body.photos as PhotoTemplate[];
    } catch (reason) { setError(errorText(reason)); throw reason; }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload().catch(() => undefined); }, [reload]);
  const updatePhoto = useCallback((photo: PhotoTemplate) => setPhotos((current) => current.map((item) => item.id === photo.id ? photo : item)), []);
  const events = useMemo(() => [...new Set(photos.flatMap((photo) => photo.memes.flatMap((meme) => meme.triggers)))].sort(), [photos]);
  const filtered = useMemo(() => photos.filter((photo) => {
    if (owner === "needs-names" && photo.labels.length) return false;
    if (owner && owner !== "needs-names" && !photo.labels.some((label) => label.memberId === owner || normalized(label.name) === normalized(profiles.find((profile) => profile.id === owner)?.displayName ?? ""))) return false;
    if (event && !photo.memes.some((meme) => meme.triggers.includes(event))) return false;
    const words = normalized(query).split(/\s+/).filter(Boolean);
    const text = normalized([photo.filename, photo.scene, photo.editNotes, ...photo.labels.map((label) => `${label.name} ${label.position ?? ""}`), ...photo.memes.flatMap((meme) => [meme.title, meme.caption, ...meme.triggers]), ...photo.labels.flatMap((label) => profiles.find((profile) => profile.id === label.memberId)?.aliases ?? [])].join(" "));
    return words.every((word) => text.includes(word));
  }).sort((a, b) => (sort === "picks" ? priority(a) - priority(b) : 0) || a.filename.localeCompare(b.filename, undefined, { numeric: true })), [photos, owner, event, query, sort, profiles]);
  const selected = photos.find((photo) => photo.id === selectedId);
  const selectedIndex = filtered.findIndex((photo) => photo.id === selectedId);

  async function addBatch(files: File[]) {
    if (!files.length || batchBusy) return;
    setBatchBusy(true);
    const planned: UploadResult[] = files.map((file) => {
      const numbers = imageNumbers(file.name);
      if (numbers.length !== 1) return { filename: file.name, status: "error", message: numbers.length ? "More than one IMG number. Open the source photo to attach this file." : "No IMG number found. Open the source photo to attach this file." };
      const matches = photos.filter((photo) => imageNumbers(photo.filename).includes(numbers[0]));
      if (matches.length !== 1) return { filename: file.name, status: "error", message: matches.length ? "Several source photos match. Open the source photo to attach this file." : "No source photo matches this IMG number." };
      if (!/\.(png|webp)$/i.test(file.name)) return { filename: file.name, status: "error", message: "Choose a PNG or WebP cutout." };
      return { filename: file.name, photoId: matches[0].id, status: "waiting" };
    });
    setUploads(planned);
    const change = (index: number, value: Partial<UploadResult>) => setUploads((current) => current.map((item, position) => position === index ? { ...item, ...value } : item));
    for (let index = 0; index < planned.length; index += 1) {
      const item = planned[index];
      if (!item.photoId || item.status === "error") continue;
      change(index, { status: "uploading" });
      try { updatePhoto(await uploadCutout(item.photoId, files[index], [])); change(index, { status: "saved", message: "Attached to source photo" }); }
      catch (reason) { change(index, { status: "error", message: errorText(reason) }); }
    }
    setBatchBusy(false);
    if (batchInput.current) batchInput.current.value = "";
  }

  return <section className="photo-library" aria-label="Photo library">
    <div className="photo-library-heading"><div><h2>Photos</h2><p className="studio-hint">Find a shot, choose the joke, and save the names you know.</p></div><span>{photos.length} photos · {photos.reduce((total, photo) => total + photo.cutouts.length, 0)} cutouts</span></div>
    <div className="photo-library-tools">
      <label className="photo-search">Search photos<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, IMG number, or scene" /></label>
      <label>Person<select value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">Everyone</option><option value="needs-names">Needs names</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}</select></label>
      <label>Occasion<select value={event} onChange={(e) => setEvent(e.target.value)}><option value="">Any occasion</option>{events.map((name) => <option key={name}>{name}</option>)}</select></label>
      <label>Order<select value={sort} onChange={(e) => setSort(e.target.value)}><option value="picks">Top picks first</option><option value="filename">Photo number</option></select></label>
    </div>
    <details className="photo-batch"><summary>Add cutouts in bulk</summary><div><p className="studio-hint">Files such as IMG_9018-removebg-preview.png attach to the matching source photo. Different files stay as separate variants; identical uploads reuse the saved version. Assign people at any time from the photo&apos;s Cutouts panel.</p><label>PNG or WebP files<input ref={batchInput} type="file" accept="image/png,image/webp" multiple disabled={batchBusy || loading} onChange={(e) => void addBatch(Array.from(e.target.files ?? []))} /></label>
      {uploads.length > 0 && <><p role="status" className="photo-upload-summary">{uploads.filter((item) => item.status === "saved").length} saved · {uploads.filter((item) => item.status === "error").length} failed{batchBusy ? " · Uploading…" : ""}</p><ul className="photo-upload-results">{uploads.map((item, index) => <li key={`${item.filename}-${index}`}><strong>{item.filename}</strong><span className={item.status === "error" ? "studio-error" : ""}>{item.status === "saved" ? "Saved" : item.status === "error" ? "Failed" : item.status === "uploading" ? "Uploading…" : "Waiting"}{item.message ? `: ${item.message}` : ""}</span></li>)}</ul></>}
    </div></details>
    {error && <div role="alert" className="studio-error"><p>{error}</p><button type="button" onClick={() => void reload().catch(() => undefined)}>Try again</button></div>}
    {loading ? <p role="status" className="studio-loading">Loading photos…</p> : !filtered.length ? <div className="photo-empty"><p>{photos.length ? "No photos match these filters." : "Your source photos will appear here after import."}</p>{photos.length > 0 && <button type="button" onClick={() => { setQuery(""); setOwner(""); setEvent(""); }}>Clear filters</button>}</div> : <>
      <p className="photo-count" aria-live="polite">{filtered.length === photos.length ? `${photos.length} photos` : `${filtered.length} of ${photos.length} photos`}</p>
      <div className="photo-library-grid">{filtered.map((photo) => <button className="photo-card" type="button" key={photo.id} onClick={() => setSelectedId(photo.id)} aria-label={`Open ${photo.filename}${photo.labels.length ? `, ${photo.labels.map((label) => label.name).join(", ")}` : ""}`}>
        <div className="photo-card-image"><Image src={assetUrl(photo.sourceAssetId)} alt={photo.scene || photo.filename} width={photo.width} height={photo.height} unoptimized />{priority(photo) === 1 && <span className="photo-pick">Top pick</span>}{photo.cutouts.length > 0 && <span className="photo-cutout-count">{photo.cutouts.length} {photo.cutouts.length === 1 ? "cutout" : "cutouts"}</span>}</div>
        <div className="photo-card-copy"><strong>{photo.memes[0]?.title || photo.filename.replace(/\.[^.]+$/, "")}</strong><span className="photo-card-names">{photo.labels.length ? photo.labels.map((label) => label.name).join(", ") : "Names to add"}</span><small>{photo.filename.replace(/\.[^.]+$/, "")}</small></div>
      </button>)}</div>
    </>}
    {selected && <PhotoDialog key={selected.id} panel={panel} onPanelChange={setPanel} photo={selected} profiles={profiles} teams={teams} players={players} onClose={() => setSelectedId(null)} onUpdate={updatePhoto} onReload={reload} onPrevious={selectedIndex > 0 ? () => setSelectedId(filtered[selectedIndex - 1].id) : undefined} onNext={selectedIndex >= 0 && selectedIndex < filtered.length - 1 ? () => setSelectedId(filtered[selectedIndex + 1].id) : undefined} />}
  </section>;
}

function PhotoDialog({ photo, profiles, teams, players, panel, onPanelChange, onClose, onUpdate, onReload, onPrevious, onNext }: Props & { panel: PhotoPanel; onPanelChange: (panel: PhotoPanel) => void; photo: PhotoTemplate; onClose: () => void; onUpdate: (photo: PhotoTemplate) => void; onReload: () => Promise<PhotoTemplate[]>; onPrevious?: () => void; onNext?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [labels, setLabels] = useState<PhotoLabel[]>(() => photo.labels.map((label) => ({ ...label })));
  const [savedLabels, setSavedLabels] = useState(() => JSON.stringify(photo.labels));
  const [revision, setRevision] = useState(photo.revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [memeIndex, setMemeIndex] = useState(0);
  const [player, setPlayer] = useState("");
  const [points, setPoints] = useState("");
  const [team, setTeam] = useState("");
  const [opponent, setOpponent] = useState("");
  const [cutoutFile, setCutoutFile] = useState<File | null>(null);
  const [cutoutMembers, setCutoutMembers] = useState<string[]>([]);
  const [cutoutPreview, setCutoutPreview] = useState("");
  const [savingCutoutId, setSavingCutoutId] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const lastNameInput = useRef<HTMLInputElement>(null);
  const [focusNewName, setFocusNewName] = useState(false);
  const dirty = JSON.stringify(labels) !== savedLabels;
  const meme = photo.memes[memeIndex];
  const fill = (text: string) => text.replace(/\[(PLAYER|POINTS|TEAM|OPPONENT)\]/g, (match, key: string) => ({ PLAYER: player, POINTS: points, TEAM: team, OPPONENT: opponent })[key as "PLAYER" | "POINTS" | "TEAM" | "OPPONENT"]?.trim() || match);

  useEffect(() => {
    const node = dialog.current;
    const previousFocus = document.activeElement;
    const before = document.body.style.overflow;
    node?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      node?.close();
      document.body.style.overflow = before;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  useEffect(() => { if (!cutoutFile) { setCutoutPreview(""); return; } const url = URL.createObjectURL(cutoutFile); setCutoutPreview(url); return () => URL.revokeObjectURL(url); }, [cutoutFile]);
  useEffect(() => { if (focusNewName) { lastNameInput.current?.focus(); setFocusNewName(false); } }, [labels.length, focusNewName]);
  const close = () => { if (dirty) setDiscard(true); else onClose(); };
  function resetNames(source: PhotoTemplate) { setLabels(source.labels.map((label) => ({ ...label }))); setSavedLabels(JSON.stringify(source.labels)); setRevision(source.revision); setConflict(false); setError(""); }
  function updateName(index: number, name: string) {
    const matches = profiles.filter((profile) => [profile.displayName, ...profile.aliases].some((alias) => normalized(alias) === normalized(name)));
    setLabels((current) => current.map((label, i) => i === index ? { ...label, name, memberId: matches.length === 1 ? matches[0].id : undefined } : label));
  }
  async function saveNames(next: boolean) {
    if (busy) return;
    if (labels.some((label) => !label.name.trim())) { setError("Add a name or remove the empty row."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/studio/photos/${encodeURIComponent(photo.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision, labels: labels.map((label) => ({ ...label, name: label.name.trim(), position: label.position?.trim() || undefined, basis: "user_supplied" })) }) });
      if (response.status === 409) { await onReload(); setConflict(true); throw new Error("This photo changed while you were editing. Your edits are still here. Load the saved names before making your changes again."); }
      const body = await readResponse(response);
      if (!body.photo?.id) throw new Error("The save response was incomplete. Refresh the photo library before retrying.");
      const updated = body.photo as PhotoTemplate;
      onUpdate(updated); resetNames(updated); setNotice("Names saved.");
      if (next && onNext) onNext();
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }
  async function copy(text: string, description: string) {
    try { await navigator.clipboard.writeText(fill(text)); setNotice(`${description} copied.`); setError(""); }
    catch { setError("Copy was unavailable. Select the text below and copy it."); }
  }
  async function addCutout(event: FormEvent) {
    event.preventDefault(); if (!cutoutFile || busy || dirty) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const updated = await uploadCutout(photo.id, cutoutFile, cutoutMembers);
      onUpdate(updated); if (!dirty) setRevision(updated.revision);
      setCutoutFile(null); setCutoutMembers([]); if (fileInput.current) fileInput.current.value = "";
      setNotice("Cutout saved.");
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  async function saveCutoutPeople(assetId: string, memberIds: string[]) {
    if (busy || dirty) return;
    setBusy(true); setSavingCutoutId(assetId); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/studio/photos/${encodeURIComponent(photo.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision, cutoutAssignments: [{ assetId, memberIds }] }) });
      if (response.status === 409) {
        const latest = (await onReload()).find((item) => item.id === photo.id);
        if (latest) resetNames(latest);
        throw new Error("This photo changed while you were editing. Review the saved cutout names, then save again.");
      }
      const body = await readResponse(response);
      if (!body.photo?.id) throw new Error("The save response was incomplete. Refresh the photo library before retrying.");
      const updated = body.photo as PhotoTemplate;
      onUpdate(updated); resetNames(updated); setNotice("People saved for this cutout.");
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); setSavingCutoutId(""); }
  }

  return <dialog ref={dialog} className="photo-dialog" aria-labelledby="photo-dialog-title" onCancel={(e) => { e.preventDefault(); if (!busy) close(); }}>
    <div className="photo-dialog-header"><div><h2 id="photo-dialog-title">{photo.filename.replace(/\.[^.]+$/, "")}</h2><p>{photo.labels.length ? photo.labels.map((label) => label.name).join(", ") : "Names to add"}</p></div><div className="photo-dialog-navigation"><button type="button" onClick={onPrevious} disabled={!onPrevious || dirty || busy} aria-label="Previous photo">Prev</button><button type="button" onClick={onNext} disabled={!onNext || dirty || busy} aria-label="Next photo">Next</button><button type="button" disabled={busy} onClick={close}>Close</button></div></div>
    {discard && <div className="photo-discard" role="alert"><p>You have unsaved name changes.</p><button type="button" onClick={() => setDiscard(false)}>Keep editing</button><button type="button" onClick={onClose}>Discard &amp; close</button></div>}
    <div className="photo-dialog-body"><div className="photo-main"><div className="photo-main-image"><Image src={assetUrl(photo.sourceAssetId)} alt={photo.scene || photo.filename} width={photo.width} height={photo.height} unoptimized priority /></div><div className="photo-source-info"><p>{photo.scene}</p><a href={assetUrl(photo.sourceAssetId)} download={photo.filename}>Download source</a></div></div>
      <div className="photo-detail"><nav className="photo-detail-tabs" aria-label="Photo details">{([['ideas', 'Ideas'], ['names', 'Names'], ['cutouts', `Cutouts${photo.cutouts.length ? ` (${photo.cutouts.length})` : ""}`]] as const).map(([value, title]) => <button type="button" key={value} aria-current={panel === value ? "page" : undefined} onClick={() => { onPanelChange(value); setNotice(""); }}>{title}</button>)}</nav>
        {error && <div className="studio-error" role="alert"><p>{error}</p>{conflict && <button type="button" onClick={() => resetNames(photo)}>Load saved names</button>}</div>}
        {notice && <p className="photo-local-notice" role="status">{notice}</p>}
        {panel === "ideas" && <div className="photo-ideas">{meme ? <>
          {photo.memes.length > 1 && <label>Idea<select value={memeIndex} onChange={(e) => setMemeIndex(Number(e.target.value))}>{photo.memes.map((item, index) => <option value={index} key={index}>{item.title}</option>)}</select></label>}
          <h3>{meme.title}</h3><p className="studio-hint">{meme.triggers.join(" · ")}</p><p className="photo-caption">{fill(meme.caption)}</p><button type="button" onClick={() => void copy(meme.caption, "Caption")}>Copy caption</button>
          {meme.alternateCaption && <div className="photo-alternate"><p>{fill(meme.alternateCaption)}</p><button type="button" onClick={() => void copy(meme.alternateCaption!, "Alternate caption")}>Copy alternate</button></div>}
          <p className="photo-edit-plan">{fill(meme.editPlan)}</p>
          <details className="photo-fill"><summary>Fill in player and matchup</summary><div><label>Player<input list={`photo-players-${photo.id}`} value={player} onChange={(e) => setPlayer(e.target.value)} placeholder="[PLAYER]" /></label><datalist id={`photo-players-${photo.id}`}>{players.map((item) => <option key={item.id} value={item.name} />)}</datalist><label>Points<input value={points} onChange={(e) => setPoints(e.target.value)} inputMode="decimal" placeholder="[POINTS]" /></label><label>Team<input list={`photo-teams-${photo.id}`} value={team} onChange={(e) => setTeam(e.target.value)} placeholder="[TEAM]" /></label><label>Opponent<input list={`photo-teams-${photo.id}`} value={opponent} onChange={(e) => setOpponent(e.target.value)} placeholder="[OPPONENT]" /></label><datalist id={`photo-teams-${photo.id}`}>{teams.map((item) => <option key={item.id} value={item.name} />)}</datalist></div></details>
          <button className="studio-primary" type="button" onClick={() => void copy(meme.prompt, "Editing prompt")}>Copy editing prompt</button><details className="photo-prompt"><summary>Read editing prompt</summary><p>{fill(meme.prompt)}</p></details>
        </> : <p className="studio-hint">An editing idea can be added to this photo later.</p>}<details className="photo-observations"><summary>Photo notes</summary><p>{photo.editNotes || "No editing notes yet."}</p>{photo.visibleText.length > 0 && <p className="studio-hint">Visible text: {photo.visibleText.join(" · ")}</p>}</details></div>}
        {panel === "names" && <form className="photo-names" onSubmit={(e) => { e.preventDefault(); void saveNames(false); }}><p className="studio-hint">Add the people you know are in this photo. Position notes stay with each name.</p><datalist id={`photo-names-${photo.id}`}>{profiles.flatMap((profile) => [<option key={profile.id} value={profile.displayName} />, ...profile.aliases.filter((alias) => alias !== profile.displayName).map((alias, index) => <option key={`${profile.id}-${index}`} value={alias}>{profile.displayName}</option>)])}</datalist>
          {labels.map((label, index) => <div className="photo-name-row" key={index}><label>Name<input ref={index === labels.length - 1 ? lastNameInput : undefined} required disabled={busy} value={label.name} list={`photo-names-${photo.id}`} autoComplete="off" maxLength={120} onChange={(e) => updateName(index, e.target.value)} /></label><label>Position or clothing<input disabled={busy} value={label.position ?? ""} placeholder="Front row, left" maxLength={240} onChange={(e) => setLabels((current) => current.map((entry, i) => i === index ? { ...entry, position: e.target.value } : entry))} /></label><button type="button" aria-label={`Remove ${label.name || `name ${index + 1}`}`} disabled={busy} onClick={() => setLabels((current) => current.filter((_, i) => i !== index))}>Remove</button></div>)}
          <button type="button" disabled={busy} onClick={() => { setLabels((current) => [...current, { name: "", basis: "user_supplied" }]); setFocusNewName(true); }}>Add a name</button><div className="photo-name-actions"><button className="studio-primary" disabled={busy || conflict}>{busy ? "Saving…" : "Save names"}</button><button type="button" disabled={busy || !onNext || conflict} onClick={() => void saveNames(true)}>Save &amp; next</button></div>
        </form>}
        {panel === "cutouts" && <div className="photo-cutouts">{dirty && <div className="photo-cutout-blocked"><p className="studio-hint">Save your name changes before adding a cutout or editing its people.</p><button type="button" disabled={busy} onClick={() => onPanelChange("names")}>Return to Names</button></div>}<form onSubmit={(e) => void addCutout(e)}><p className="studio-hint">Attach a transparent cutout to this source photo. Different files stay as separate variants; identical uploads reuse the saved version.</p><label>PNG or WebP cutout<input ref={fileInput} type="file" accept="image/png,image/webp" required disabled={busy || dirty} onChange={(e) => { setCutoutFile(e.target.files?.[0] ?? null); setNotice(""); }} /></label>{cutoutPreview && <div className="photo-checker photo-cutout-preview"><Image src={cutoutPreview} alt="Selected cutout preview" width={320} height={280} unoptimized /></div>}
          <details className="photo-cutout-people"><summary>{cutoutMembers.length ? `${cutoutMembers.length} people selected` : "Assign people (optional)"}</summary><p className="studio-hint">Choose the people pictured in this cutout, or leave it unassigned.</p>{profiles.map((profile) => <label className="studio-check" key={profile.id}><input type="checkbox" disabled={busy || dirty} checked={cutoutMembers.includes(profile.id)} onChange={(e) => setCutoutMembers((current) => e.target.checked ? [...current, profile.id] : current.filter((id) => id !== profile.id))} />{profile.displayName}</label>)}</details><button className="studio-primary" disabled={busy || dirty || !cutoutFile}>{busy ? "Uploading…" : "Save cutout"}</button></form>
          {!!photo.cutouts.length && <div className="photo-cutout-grid">{photo.cutouts.map((cutout) => <CutoutVariant key={cutout.assetId} cutout={cutout} profiles={profiles} disabled={busy || dirty} saving={savingCutoutId === cutout.assetId} onSave={saveCutoutPeople} />)}</div>}
        </div>}
      </div>
    </div>
  </dialog>;
}


function CutoutVariant({ cutout, profiles, disabled, saving, onSave }: { cutout: PhotoTemplate["cutouts"][number]; profiles: Profile[]; disabled: boolean; saving: boolean; onSave: (assetId: string, memberIds: string[]) => Promise<void> }) {
  const [members, setMembers] = useState(() => [...cutout.memberIds]);
  const savedMembers = JSON.stringify(cutout.memberIds);
  useEffect(() => { setMembers(JSON.parse(savedMembers) as string[]); }, [savedMembers]);
  const changed = JSON.stringify([...members].sort()) !== JSON.stringify([...cutout.memberIds].sort());
  return <figure><a className="photo-checker" href={assetUrl(cutout.assetId)} download={cutout.filename}><Image src={assetUrl(cutout.assetId)} alt={cutout.filename} width={300} height={240} unoptimized /></a><figcaption>{cutout.filename}<small>{cutout.memberIds.length ? cutout.memberIds.map((id) => profiles.find((profile) => profile.id === id)?.displayName ?? id).join(", ") : "Unassigned"}</small></figcaption>
    <details className="photo-variant-people"><summary>Edit people</summary><p className="studio-hint">Choose everyone pictured in this cutout.</p>{profiles.map((profile) => <label className="studio-check" key={profile.id}><input type="checkbox" disabled={disabled} checked={members.includes(profile.id)} onChange={(e) => setMembers((current) => e.target.checked ? [...current, profile.id] : current.filter((id) => id !== profile.id))} />{profile.displayName}</label>)}<button type="button" disabled={disabled || !changed} onClick={() => void onSave(cutout.assetId, members)}>{saving ? "Saving…" : "Save people"}</button></details>
  </figure>;
}
