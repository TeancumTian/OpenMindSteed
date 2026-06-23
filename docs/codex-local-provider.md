# Codex Local Provider

Codex Local is an advanced provider for users who already have Codex installed and signed in with ChatGPT.

It is intentionally not a GPT OAuth implementation inside OpenMindSteed. OpenMindSteed must not read Codex credential files or ask users to paste Codex tokens. The desktop backend should start or connect to local Codex app-server and let Codex own authentication.

## Intended Flow

1. Detect the Codex binary.
2. Show version and setup status in Settings.
3. Spawn `codex app-server --listen stdio://`.
4. Send `initialize` and `initialized`.
5. Start or resume one Codex thread per OpenMindSteed node.
6. Start a turn using the node learning prompt.
7. Stream Codex agent message deltas into the normal AI provider contract.
8. Extract title, summary, and suggestions.

## Security Rules

- Do not read `~/.codex/auth.json`.
- Do not store `CODEX_ACCESS_TOKEN`.
- Do not expose WebSocket listeners outside loopback.
- Prefer stdio transport.
- Treat this as a local trusted-user integration only.

## Current Status

The React provider contract and Tauri backend stdio JSON-RPC adapter are implemented. The desktop path now:

- starts `codex app-server --listen stdio://`
- sends `initialize` and `initialized`
- checks the Codex binary, version, and `codex login status` from Settings
- warns when the detected Codex CLI is outside the tested `>=0.142.0 <0.143.0` range
- starts a new thread or resumes the Codex thread mapped to the selected OpenMindSteed node
- shows setup actions when the Codex binary is missing or when Codex is installed but not signed in
- emits the active Codex thread id back to React for persistence
- reports whether the Codex thread was started, resumed, or recreated after `thread/resume` failed
- sends one learning turn
- streams `item/agentMessage/delta` into the React provider contract through Tauri events
- reads completed agent-message payloads as a compatibility fallback when deltas are absent or incomplete
- asks Codex to append an `<openmindsteed_metadata>` JSON block, strips that block from the final visible answer, and uses it for title, summary, and suggested branches when valid
- reports and stops the learning turn with warning metadata if Codex attempts command, tool, file, patch, diff, or shell work
- supports frontend cancellation through a Tauri `codex_local_cancel` command keyed by request id
- collects deltas until `turn/completed`
- returns the final answer with structured or fallback title, summary, and suggestions

## Protocol Types

Codex app-server can generate TypeScript protocol bindings for the exact installed Codex CLI version. OpenMindSteed keeps this generation reproducible but does not commit the generated directory because the output is version-specific and currently large.

Generate local protocol bindings with:

```bash
pnpm run codex:protocol
```

The script:

- checks `codex --version`
- warns if the detected version is outside `>=0.142.0 <0.143.0`
- runs `codex app-server generate-ts --experimental`
- writes output to ignored directory `src-tauri/protocol/codex-generated/`

Use the generated files when updating app-server event handling, comparing protocol changes across Codex CLI versions, or revising the tested compatibility range.

The remaining work is richer failure-specific recovery messages and continued tuning of the metadata contract.
