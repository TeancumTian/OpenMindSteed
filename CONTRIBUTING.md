# Contributing

OpenMindSteed is early-stage. Keep changes small, testable, and aligned with the implementation plan in `docs/OPENMINDSTEED_PLAN.md`.

## Issues

Use the GitHub issue forms for bugs, feature requests, and provider adapter requests. Do not include API keys, Codex access tokens, `~/.codex/auth.json`, private Obsidian notes, or account-specific secrets in public issues.

Security-sensitive reports should use GitHub private vulnerability reporting. See `SECURITY.md`.

## Local Setup

```bash
corepack enable
pnpm install
pnpm run dev
```

Before opening a pull request:

```bash
pnpm run secrets:check
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
```

Tauri verification additionally requires Rust:

```bash
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Use `pnpm run tauri:dev` for manual desktop runtime testing.

Pull requests should use the repository PR template and include screenshots or recordings for visible UI changes.

## Engineering Rules

- Keep BYOK Direct as the default stable provider.
- Treat Codex Local as experimental and local-only.
- Never read `~/.codex/auth.json`.
- Never store `CODEX_ACCESS_TOKEN`.
- Preserve Obsidian user notes outside the managed block.
- Add tests for sync, parsing, deletion, and provider behavior when changing those areas.

## UI Direction

The app should remain a desktop knowledge workspace, not a landing page or generic chat UI. Keep the three-pane layout, graph-first memory, and calm dense interaction model unless a change explicitly improves that workflow.
