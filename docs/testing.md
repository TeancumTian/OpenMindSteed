# Testing

OpenMindSteed uses Vitest for unit tests, Playwright for browser-level workspace checks, and Rust tests for the Tauri backend.

## Unit Tests

```bash
pnpm run secrets:check
pnpm run test
```

Covered areas include secret-scan guardrails, state normalization, backup import/export, AI prompt packing and extraction parsing, provider presets and BYOK configuration validation, graph search/scope helpers, and Obsidian Markdown package generation.

## E2E Smoke Test

Install the Chromium browser once:

```bash
pnpm exec playwright install chromium
```

Run the browser test:

```bash
pnpm run test:e2e
```

The Playwright config starts the Vite dev server automatically. The smoke test checks the three-pane workspace, command palette navigation, graph scope controls, Settings, and backup panel. It also attaches a full-page `workspace-smoke.png` screenshot to the test report.

## Tauri Backend Tests

```bash
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Covered backend areas include SQLite schema migration tracking, state persistence, Codex Local app-server event handling, Codex cancellation, generated image asset safety, Obsidian sync asset copying, managed manifest pruning, and structured metadata extraction.

## GitHub CI

The CI workflow runs web verification on Ubuntu and Tauri backend verification on macOS:

- `web`: secret scan, formatting, lint, typecheck, Vitest, production build, and Playwright smoke test.
- `tauri-backend`: Rust format check, backend tests, and `cargo check`.
