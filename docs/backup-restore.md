# Backup and Restore

OpenMindSteed supports local JSON backup export/import from Settings.

## What It Includes

- Knowledge nodes
- Node conversations
- Generated image message metadata and local asset paths
- Suggested branches
- Provider settings without API keys
- Obsidian settings
- Codex Local node-to-thread mappings

## What It Excludes

- BYOK API keys
- Codex credential files or access tokens
- Obsidian Markdown files already written to a vault
- Generated image binary files under the local app data directory

Backups use a versioned envelope:

```json
{
  "app": "OpenMindSteed",
  "version": 1,
  "exportedAt": "2026-06-23T18:20:00.000Z",
  "state": {}
}
```

Import accepts either this envelope or a raw persisted state object. Imported data is normalized before it replaces the current app state, so older backups can gain new fields such as `codexThreads` and `providerPreset`.

## Relationship to Obsidian Sync

Backup JSON is for restoring OpenMindSteed app state. Obsidian sync is for publishing readable Markdown notes into a vault. They are separate exports and should not be treated as interchangeable formats.
