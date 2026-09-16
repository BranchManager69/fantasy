# Private league studio

The studio at `/studio` holds GM profiles, photos and league history, then uses those sources with verified weekly results to draft illustrated episodes. Profiles, imports and scene edits work without an AI key. History analysis, episode drafting and image rendering call OpenAI when requested.

## Server setup and access

Follow the repository [setup instructions](../README.md#setup), refresh the weekly league data, and supply `OPENAI_API_KEY` to the web process for AI work. The studio uses the same `DATA_ROOT` and `FANTASY_REPO_ROOT` as the website. Keep one web process for this studio instance.

Set the reverse proxy's request-body limit to at least 32 MiB. For Nginx, add `client_max_body_size 32m;` to the applicable server or location block, validate with `nginx -t`, then reload Nginx. This allows a 5 MiB text import inside an escaped JSON request and a 10 MiB photo inside multipart form data; the application still enforces its own smaller content limits.

The private store requires Linux and `/usr/bin/flock`, supplied by `util-linux`. Check it with `/usr/bin/flock --version`. Store writes use an operating-system lock plus a PID and random ownership token. A crashed writer's lock is reclaimed only after its process is confirmed dead; a lock's age alone never permits takeover. Do not delete `.write-guard` or remove a lock while its owner is alive.

Set the optional variables in [`.env.example`](../.env.example) in the web process environment, then restart that process after changes:

| Variable | Default | Use |
| --- | --- | --- |
| `FANTASY_STUDIO_TOKEN` | Generated private token | Shared studio access code; an override must have at least 32 characters. |
| `FANTASY_STUDIO_DAILY_LIMIT` | `20` | Text attempts per UTC day, shared by extraction, producer and editor. |
| `FANTASY_STUDIO_IMAGE_DAILY_LIMIT` | `4` | Separate image attempts per UTC day. |
| `FANTASY_STUDIO_MODEL` | `gpt-6-astra` | History extraction and producer model. |
| `FANTASY_STUDIO_WRITER_MODEL` | `gpt-6-astra` | Editor model; defaults independently of the producer override. |
| `FANTASY_STUDIO_IMAGE_MODEL` | `gpt-image-2.5-sunburst` | Image edit model; must support the configured reference-image request. |

Both daily limits accept nonnegative integers and are capped at 20; 0 disables that class of requests. They count attempts, including failures, and reset at midnight UTC. An episode normally consumes two text attempts; each history chunk consumes one. Image rendering consumes a separate attempt for each scene. Request counts cannot guarantee a dollar ceiling. Configure provider spending controls separately if required.

When no token override is set, the first authentication attempt creates `DATA_ROOT/private/studio/access-token` with owner-only permissions. Deliver the shared code privately, either for entry on the access form or in a link with this shape:

```text
https://<league-host>/studio#access=<private-token>
```

The browser removes the fragment and exchanges the code for a seven-day HttpOnly session cookie. A fragment stays out of the initial HTTP request URL; the code is then sent to the session endpoint in a POST body. Use HTTPS, keep the link out of public pages and logs, and send it only to people who should be able to edit the studio. Access is shared; there are no separate GM roles. Rotating the configured token, or replacing the generated token file when no override is set, invalidates existing sessions.

## Seed people and attach photos

From the repository root, use the cached league snapshot containing ESPN members and team owners:

```bash
./apps/web/node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json \
  scripts/studio-seed-owners.ts \
  --source data/raw/espn/2026/view-mMatchupScore-week-1.json \
  --same-person "Dillon Dalton"
```

Dillon Dalton is one confirmed person with two ESPN accounts on the same team. The command creates one profile and retains both account IDs in private `owner-accounts.json`. Other repeated names require their own confirmed `--same-person` argument; different-team mappings stop for review. Existing profiles retain their manual edits, and a changed team mapping stops the import.

The command also writes private `owner-roster.csv` with `photo_folder`, `owner_name`, `team_id`, `team_name` and `espn_account_count`. Use `photo_folder` as the stable label when collecting each person's photos. The seed command creates profiles and the roster; upload photos in the studio's People tab and assign them to the correct person. It does not import image folders.

Edit each person's background, nicknames, ribbing that lands and off-limit topics in People. Background is limited to 8,000 characters, ribbing notes to 4,000, and nickname/off-limit lists to 30 entries each. An author's display name or explicit nickname maps case-insensitively to a profile. A name matching multiple people remains unmapped until the aliases are corrected. ESPN account IDs and chat nicknames have separate mappings.

Uploads accept PNG, JPEG and WebP files up to 10 MiB. Every GM included in a rendered scene needs an assigned portrait or reference photo. Missing GM photos stop the render before an image attempt is reserved. NFL player references can use assigned uploads or a roster-verified ESPN headshot. The image request asks the model to preserve those identities and label the result as a fictional league scene; inspect the result before using it.

## Import history and inspect its sources

In League history, add a background or group-chat source, then start analysis when ready. Imports accept up to 5 MiB of UTF-8 text. Supported formats include WhatsApp-style exports, `[date] Name: text`, `Name: text`, and JSON arrays or an object containing `messages` with `author`, `timestamp` and `text` fields. Timestamps retain their source text. Unrecognized prose remains unattributed; the parser does not invent authors.

Content hashes make repeat imports idempotent. Messages receive stable IDs and are grouped into complete-message chunks capped at 12,000 text characters and 16,000 serialized UTF-8 bytes. A single attributed message that cannot fit is rejected with a size error. Unattributed text may be split into blocks. Raw and parsed sources remain available privately.

Analysis extracts background, running jokes, quotes and rivalries. Every accepted memory must reference known people and exact message IDs from that import. Quotes must be literal substrings of cited messages. The stored confidence distinguishes explicit from inferred material; source validation checks references and quotes, not the truth of every inference. Inspect the source excerpts and disable or edit memories that should not guide future scenes. Imported text is treated as untrusted source material.

Each completed chunk is checkpointed. If a job fails or reaches its text allowance, start analysis on that import again to resume the remaining chunks. Correct aliases before starting analysis; extraction uses the profiles available when the job begins. Retrieval supplies relevant enabled memories and bounded profile excerpts rather than the entire chat archive.

## Draft, edit and render episodes

Choose the week and team in Scenes and add an optional direction. The producer receives verified matchup results, the exact best eligible lineup using final points, sourced game moments and relevant league memories. The lineup comparison is retrospective. Evidence coverage and scoring caveats stay with the facts.

The producer chooses a scene plan, which is saved before the editor starts. The editor receives the selected evidence and checks the draft. A completed episode contains one to four scenes with evidence IDs, memory IDs and identified cast members. Model output is checked against those allowed references. Saved episodes retain their evidence packet, memory citations, model, prompt hashes and run IDs for inspection.

Activity shows persisted job stages. Closing the browser leaves the server job running. A server restart marks abandoned jobs as interrupted after confirming their owner process has died. Use Resume scene draft when a saved producer plan is available; this reruns the editor, not the producer. If the producer never saved a plan, start a new draft. Pending hosted-session cleanup can delay the next text stage until the earlier session is reconciled.

Review scene commentary and the image brief before rendering. Editing either detaches the scene's current image; the old asset remains in private storage. If a cited memory has changed or been disabled since drafting, create a new episode before rendering that scene. This avoids reusing outdated personal context.

Rendering makes one image-edit request using the cast's reference photos: a 1536 by 1024 WebP at medium quality, with a 180-second request deadline and no automatic retry. A timeout may leave the provider outcome unknown and still counts as an attempt. Check Activity and the private receipt before requesting another render.

## Private storage and checks

All studio state lives under `DATA_ROOT/private/studio/`. The repository ignores `data/private/`; keep a custom `DATA_ROOT` outside public static directories and apply equivalent Git exclusions if it is inside another checkout. Directories are created with mode `0700` and files with mode `0600`. Preserve those permissions in backups. Raw chat, profiles and generated assets are served through authenticated studio routes, separately from the public weekly feed.

| Location within the studio directory | Contents |
| --- | --- |
| `state.json`, `src-<hash>.txt`, `src-<hash>.json` | Profiles, memories, raw imports and parsed messages. |
| `owner-accounts.json`, `owner-roster.csv` | Private account mapping and photo collection roster. |
| `analysis/`, `drafts/`, `jobs/` | Extraction checkpoints, producer plans and job progress. |
| `boards/`, `assets/`, `images/` | Saved episodes, image metadata and image bytes. |
| `agent-runs/`, `image-runs/` | Separate attempt ledgers and receipts. |

AI requests send selected source material and reference images to OpenAI. Manual saves and raw imports do not run inference. Disabling a memory changes future use; it does not erase its source, saved drafts or earlier images. No public publishing action is part of this studio workflow.

Run the offline studio tests from the repository root:

```bash
npm run test:studio --prefix apps/web
```

The tests use synthetic inputs and mocked providers. They cover identity ambiguity, chunk limits, source and quote validation, crash recovery, concurrent profile/photo updates, scene references and media provenance. They do not establish successful paid inference or deployment. Editorial instructions live in [`prompts/studio/`](../prompts/studio/); model overrides can change the final writer without replacing the evidence pipeline.
