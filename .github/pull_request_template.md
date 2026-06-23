## Summary

-

## Verification

- [ ] `pnpm run format:check`
- [ ] `pnpm run lint`
- [ ] `pnpm run typecheck`
- [ ] `pnpm run test`
- [ ] `pnpm run build`
- [ ] `pnpm run test:e2e` when UI behavior changes
- [ ] `cargo test` in `src-tauri` when Tauri/Rust behavior changes
- [ ] `cargo check` in `src-tauri` when Tauri/Rust behavior changes

## Screenshots or Recordings

Add before/after screenshots for visible UI changes.

## Risk Checklist

- [ ] I did not add code that reads `~/.codex/auth.json`.
- [ ] I did not store `CODEX_ACCESS_TOKEN` or provider API keys in app state, logs, tests, or docs.
- [ ] I preserved Obsidian user notes outside managed blocks when sync output changes.
- [ ] I updated tests or docs for provider, sync, backup, release, or UI behavior changes.
