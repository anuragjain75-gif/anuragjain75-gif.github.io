# Single-writer contract and recovery procedure

Status: this procedure passed synthetic verification in both preserved 79-check runs. Real-manuscript restoration and lock removal still require the explicit approvals below.

## Operating contract

While the Writing Desk API is operating, only the Writing Desk writes manuscripts. Stop external editors, sync clients and scripts that can write the same files. API save locks coordinate Writing Desk instances; they cannot revoke file descriptors held by arbitrary external programs.

Reading/creating returns a local revision token. A save with a stale token is rejected with 409. A second API writer is rejected while the first holds its lock. An external change during save preparation or displacement is detected where possible. The API retains the displaced original inode so detected changes remain recoverable.

A 409 does not mean disk is unchanged. In late races, the browser draft can already occupy the document path while external bytes are retained in the newest backup. Very late writes through old descriptors cannot be given a universal compare-and-swap guarantee. Existing Hugo symlinks are rejected before delegation; hostile tree changes during Hugo are outside the single-writer contract.

## Browser protection

Warnings persist until an explicit preservation/review acknowledgment or a successful explicit retry of an ordinary failure that occurred before publication. A stale conflict cannot simply be retried. Unknown network outcomes are not treated as unchanged disk. The browser does not automatically reload, overwrite a file, restore a backup, or delete a recovery lock.

Use Download complete draft snapshot or Copy complete draft snapshot. The JSON includes serializable Markdown when available, the live editor document structure, frontmatter, protected text, image path references, connection metadata and the failed attempt. It is a recovery snapshot, not a claim that invalid Markdown was safely serialized. Images already uploaded remain separate local files; image binaries are not embedded. If serialization fails, the structured buffer and original sources are retained instead of pretending the export is normal Markdown. Do not close the page if export fails.

Open the downloaded file or inspect the copied contents before confirming preservation. Editing after export invalidates acknowledgment until the newest buffer is exported again. Explicit acknowledgment only clears the UI warning; it never changes the saved revision, restores files, or reloads the manuscript. Ordinary unsaved work remains protected by navigation confirmation and a beforeunload warning where the browser supports it. Browsers may ignore unload warnings, and a machine crash cannot be prevented by JavaScript; export before closing or restarting.

## Save outcome metadata

- `save.kind=stale-conflict`, `publication=none`: this request did not publish the draft. Disk may contain another writer's changes.
- `save.kind=recovery-conflict`: the path may have changed, or another save/recovery lock exists. `publication=occurred` means this request published its draft; `unknown` must be treated conservatively.
- `save.kind=failure`, `publication=none`: ordinary failure before publication; preserve draft before explicit retry.
- `recovery.backupId` is only a backup filename reference. Absolute host paths and `/proc` paths are not returned.
- `recovery.lockRetained=true` means the manuscript lock needs review. Interrupted processes can leave locks even if no response was delivered.

## Manual recovery — no automatic destructive actions

1. Keep the browser open. Export the complete current snapshot and verify it. Preserve any earlier export too; do not overwrite it.
2. Stop the API and all external writers. A lock may be active, not stale; never remove it just because a save appears slow.
3. Inspect the selected manuscript, its `.<filename>.save-lock/original` if present, and the indicated backup under `backups/editor-autosave/<document directory>/`. This is a description of relative locations for the local operator, not an endpoint to download arbitrary files.
4. Copy every version to a new, uniquely named recovery directory. Record hashes and compare content, Unicode, line endings, frontmatter and shortcodes. Preserve browser JSON alongside the disk versions. Read-only inspection and copying into new filenames do not authorize replacement.
5. Choose the desired version deliberately. Any replacement/rename of a manuscript requires explicit user approval naming the document and chosen version. Preserve the displaced disk version first. Do not assume the newest timestamp means the best manuscript.
6. Restoring a manuscript does not authorize clearing locks. Move retained recovery data to a separately preserved archive only after review and explicit approval. Remove only a verified empty lock directory, with separate explicit approval. Never recursively delete a lock or discard unknown files.
7. Restart the API only after review. Reload/reconcile only through an explicit user action after verifying the exported draft. Confirm a fresh revision token and recheck the chosen content. Do not automatically merge browser JSON into the manuscript.

Failures before displacement normally leave the original intact. Failed rollback when another writer has recreated the target can leave `.save-lock/original`. Process interruption and lock cleanup failure can also leave locks. A late error may occur after publication. Preserve both the document path and recovery contents in all these cases.

## Prepared recovery verification

The new synthetic tests require explicit approval for their test-only restore helper, preserve the pre-restore disk file, selected backup and browser draft, and demonstrate that restoration does not automatically remove locks. They are constrained to `/work` inside Bubblewrap. No recovery helper or restore endpoint is exposed in the application. These tests passed in both preserved 79-check runs; they do not authorize recovery actions on real manuscripts.
