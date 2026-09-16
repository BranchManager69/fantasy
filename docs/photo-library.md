# Photo templates

The private studio's Photos tab holds source photographs, supplied person labels, meme directions, and transparent cutouts. Open `/studio?tab=photos` using a studio session. Photo records and image bytes require studio authentication and use private, no-store responses.

Each photo has a stable ID such as `img-9018`, its original filename, dimensions, and an immutable source asset. A source label can name a league member or a guest and include a position such as "back row, second from left". Names come from the user's annotations. Labels remain nonexhaustive until the user has named everyone they want included.

Meme concepts contain a caption, an alternate caption, an editing plan, event triggers, and an image-edit prompt. A prompt can refer to `[PLAYER]`, `[POINTS]`, `[TEAM]`, or `[OPPONENT]`. Fill those values for the matchup and supply the chosen player's reference when editing. Preserve the source camera, body pose, hand contact, and occlusion while applying the visual joke. Keep caption typography as a separate layer.

## Name photos and cutouts

Use a photo's Names panel to save the people pictured in the source. Save & next retains the Names panel while moving through the filtered photo list. Saving uses the current record revision to protect changes made in another window. Save source-name changes before uploading a cutout or editing its people.

Bulk cutout uploads start unassigned. After import, open the source photo's Cutouts panel, expand Edit people on the relevant version, select the league members retained in that cutout, and choose Save people. Clear the selection and save to remove its assignments. These names describe that version only; source-photo names and assignments on other cutouts stay intact. Guests can have free-text source labels; cutout assignments use saved league member IDs.

## Transparent versions

Keep the original IMG number in exported filenames. For example, `IMG_9018.png` and `IMG_9018-removebg-preview.png` attach to `img-9018` through the batch uploader. Files with ambiguous or unmatched numbers require an explicit source-photo selection. Filenames establish the requested source association; each cutout's retained people are named separately by the user.

A cutout must be a still PNG or WebP containing visible pixels and transparency, within 10 MB and 30 million pixels. The upload retains the source image and earlier versions. Cutout assets include the source asset ID in their identity and provenance, so the same bytes attached to different source images remain separate.

An exact repeated upload to the same source reuses its saved variant when the supplied member assignments match. Different assignments on an upload return a conflict; use Edit people to change an existing variant. Online upload deduplication compares encoded file bytes. Different encodings remain separate variants unless preparation has already grouped them by decoded pixels.

Source scenes and cutouts have their own asset kinds. The existing image generator selects portrait/reference assets for its cast. Saving templates, names, or cutouts is separate from running an image-generation job.

## Prepared batch: September 16, 2026

The prepared manifest contains 37 source photos and 36 transparent cutouts across 36 sources. Preparation grouped 8 duplicate exports with their retained versions, reducing 44 exports to 36 cutouts. All 36 cutouts begin with empty member assignments. Name the retained people manually after import through each version's Edit people control.

The manifest records the skipped filenames in `duplicateExports`. Its summary counts describe this prepared batch; the deployed library count should be verified after applying it.

## Import a prepared batch

Run from `apps/web` with Node 22 and an explicit data directory:

```sh
DATA_ROOT=/absolute/league/data node_modules/.bin/tsx scripts/import-studio-photos.ts \
  --manifest /private/import/manifest.json --files /private/import/files --dry-run

DATA_ROOT=/absolute/league/data node_modules/.bin/tsx scripts/import-studio-photos.ts \
  --manifest /private/import/manifest.json --files /private/import/files --apply
```

The preflight checks file paths, SHA-256 hashes, dimensions, saved member IDs, and cutout transparency. The library applies its record validation while importing. Keep photos and manifests in the ignored `data/private/` tree.

The JSON manifest has `schema: 1` and a nonempty `sources` array. Each source contains `file`, `sha256`, and `metadata` matching `PhotoSourceInput`. The optional `cutouts` array contains `file`, `sha256`, `photoId`, and `memberIds`. Each cutout's source must also appear in the manifest. `duplicateExports` can list filenames already omitted during preparation.

Repeat source imports preserve later manual source labels and cutouts. A different image using an existing photo ID fails. Repeated cutouts are matched by their bytes and source asset ID, preserving their saved filename and later manual member assignments even if the incoming filename or old manifest assignments differ. Import verification uses asset identity. Newly encountered cutouts receive the manifest's explicit member assignments.

## API updates

The authenticated API provides `GET /api/studio/photos`, multipart source/cutout uploads at `POST /api/studio/photos`, and revision-checked updates at `PATCH /api/studio/photos/:id`. Images use the existing private asset endpoint. Writes require the studio session and accepted request origin.

A patch supplies `revision` plus at least one of `labels`, `scene`, `editNotes`, or `cutoutAssignments`. Omitted fields remain unchanged. Source labels require `basis: "user_supplied"`; an empty `labels` array clears them.

To name a saved cutout while preserving source labels:

```json
{
  "revision": 7,
  "cutoutAssignments": [
    {
      "assetId": "asset-0123456789abcdef0123456789abcdef",
      "memberIds": ["john-real"]
    }
  ]
}
```

Use the actual saved asset and league member IDs. `cutoutAssignments` accepts 1 to 40 unique IDs belonging to this photo. Each assignment supplies up to 16 member IDs; an empty `memberIds` array clears that cutout's people. The update changes only the listed cutouts and leaves image bytes untouched. The request's `cutoutAssignments` field is applied to the stored cutout records rather than retained as a separate record field.

A successful update returns `{ "photo": ... }` with an incremented revision. A stale revision returns HTTP 409 and an error message. Reload the current photo, review its saved names, and submit the intended changes against the new revision.
