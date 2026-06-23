# Obsidian Sync

OpenMindSteed v1 uses one-way managed sync from the app into an Obsidian vault.

The current implementation can generate a Markdown package in the frontend, export it as JSON for inspection, and call a Tauri backend command to write the files directly into a vault path. In the desktop app, Settings includes a folder picker for selecting the Obsidian vault path. Users can choose all trees or the current root tree from the sync strip. The Rust backend is compile-checked through `cargo check`, and the debug Tauri app can be bundled locally.

## Example Vault

Open `docs/example-vault/` as an Obsidian vault to inspect the expected export shape. It includes:

- `Index.md` for the vault-level index.
- `Trees/<tree>/Index.md` for the tree overview and Mermaid graph.
- `Trees/<tree>/Nodes/*.md` for node notes.
- `.mindsteed-sync.json` with active manifest entries.
- `## My Notes` sections outside managed blocks to show where users can safely write personal notes.

## Managed Block Contract

Generated content is wrapped in:

```md
<!-- mindsteed:managed:start -->

...

<!-- mindsteed:managed:end -->
```

Everything outside that block is user-owned content and must be preserved on repeated syncs.

## Planned Vault Structure

```text
Index.md
.mindsteed-sync.json
Trees/
  <tree-title>-<root-short-id>/
    Index.md
    Nodes/
      01-<node-title>-<short-id>.md
    Assets/
_Deleted/
```

When syncing only the current tree, OpenMindSteed writes that tree folder and node notes without rewriting the vault-level `Index.md`.

## Manifest Pruning

The backend reads the existing `.mindsteed-sync.json` before writing a new package. Any previously active file that is no longer in the new active scope is moved to:

```text
_Deleted/<sync-batch>/<original-relative-path>
```

The manifest keeps the old entry with `status: "deleted"`, `deletedAt`, and `deletedPath`.

Pruning respects sync scope:

- All-tree sync can prune any missing active entry.
- Current-tree sync only prunes entries whose `rootId` matches the selected root, leaving other trees untouched.

## Backend Command

The desktop sync path calls:

```ts
sync_obsidian_vault({
  payload: {
    vaultPath,
    packagePayload,
  },
});
```

The backend validates relative paths, creates parent directories, replaces only managed blocks, appends `## My Notes` for new files, copies generated image assets into tree-level `Assets/` folders, moves removed managed files/assets into `_Deleted`, and writes `.mindsteed-sync.json` with tree/node counts and a sync timestamp.

Generated image messages are rendered as Markdown image embeds. When a generated image has a local app-data file, the package includes a generated-image asset entry and node notes reference it with a vault-relative path such as `../Assets/<image>.png`. Browser preview or unsaved image URLs still fall back to the provider URL.
