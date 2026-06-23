# Security Policy

OpenMindSteed is a local-first desktop app that can handle provider API keys, Codex Local credentials indirectly through the user's Codex installation, generated image assets, and Obsidian vault paths. Treat reports involving credentials, local file writes, or auth boundaries as security-sensitive.

## Supported Versions

OpenMindSteed is pre-1.0. Security fixes target the `main` branch until public release branches exist.

## Private Reporting

Use GitHub private vulnerability reporting:

https://github.com/teancumtian/OpenMindSteed/security/advisories/new

Do not open a public issue for:

- API key, access token, or credential exposure.
- Reads from `~/.codex/auth.json` or other Codex credential storage.
- Storage of `CODEX_ACCESS_TOKEN` or pasted Codex tokens.
- Obsidian sync path traversal, arbitrary file writes, or deletion outside the selected vault.
- Generated image asset copying from outside OpenMindSteed-controlled storage.
- Bugs that expose private Obsidian notes, prompts, logs, or local paths.

## What To Include

Include a minimal reproduction, affected platform, OpenMindSteed version or commit, and expected impact. Redact API keys, Codex access tokens, private notes, account IDs, and unrelated local paths.

## Security Boundaries

- BYOK provider secrets belong in the OS keychain in the Tauri desktop app.
- Backup exports and app state must not include provider API keys.
- `pnpm run secrets:check` should pass before opening a PR; it catches common credential files, private key blocks, non-empty Codex token assignments, and common provider-token formats.
- Codex Local must use the local Codex app-server over stdio and must not implement ChatGPT OAuth directly.
- Codex Local must not read, copy, or log Codex credential files.
- Obsidian sync may write only inside the selected vault and may copy generated image assets only from OpenMindSteed-controlled local asset storage.
- The Tauri frontend capability should stay minimal. The default window should not receive shell execution permissions or broad filesystem plugin permissions; local writes and Codex process execution belong in reviewed Rust commands.
