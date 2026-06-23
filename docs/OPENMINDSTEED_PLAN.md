# OpenMindSteed Implementation Plan

## 1. Product Goal

OpenMindSteed will be an open-source desktop knowledge learning app. A user starts from a topic or source text, talks with an AI tutor inside the current node, expands promising ideas into child nodes, and keeps the whole learning tree synchronized with Obsidian as readable Markdown.

The app should feel like a serious local knowledge workstation, not a chat wrapper. The core first-screen experience is a three-pane workspace:

- Left: knowledge tree and root management.
- Center: interactive 2D graph and current path context.
- Right: node conversation, suggestions, attachments, and sync status.

The existing SwiftUI app in `/Users/teancumtian/Desktop/Creative/MindSteed` is the behavior reference. OpenMindSteed should preserve the successful product model while moving the implementation to a React/TypeScript open-source stack.

## 2. Confirmed Architecture Decisions

### Runtime

- Use `Tauri + React + TypeScript + Vite`.
- Use Tauri because Obsidian sync needs durable local folder access and filesystem writes.
- Target macOS first, with Windows/Linux kept possible by avoiding macOS-only APIs in the core architecture.
- Keep pure web/PWA as a later export target only after the desktop app is working.

### Data

- Use SQLite as the local source of truth.
- Keep the current app's conceptual model:
  - `KnowledgeNode`
  - `ChatMessage`
  - `ConceptSuggestion`
  - provider settings
  - Obsidian sync manifest metadata
- Store secrets through the OS keychain via a Tauri plugin or Rust keyring crate, never in app settings JSON.

### AI Provider Strategy

OpenMindSteed will support three provider classes, in this order:

1. BYOK Direct Provider
   - Default and stable path.
   - User supplies an API key for OpenAI-compatible providers.
   - Works without Codex, ChatGPT subscription, or hosted backend.

2. Codex Local Provider
   - Advanced experimental path.
   - Uses the user's locally installed and authenticated Codex CLI/app-server.
   - Lets users who already use Codex with ChatGPT sign-in try OpenMindSteed without entering an OpenAI API key.
   - This is not "OpenMindSteed implements ChatGPT OAuth"; it is "OpenMindSteed talks to local Codex, and Codex owns the ChatGPT login".

3. Hosted Provider
   - Future commercial/community-hosted path.
   - Not part of v1 because it introduces account, billing, rate-limit, and secret-management complexity.

### Obsidian Sync

- v1 uses one-way managed sync from OpenMindSteed to Obsidian.
- Keep user-written content outside the managed block untouched.
- Do not implement Obsidian-to-app reverse sync in v1.
- Use a sync manifest so renamed/moved/generated files remain traceable.

## 3. Public Product Scope

### v1 Must Have

- Create, rename, select, and delete knowledge tree roots and nodes.
- Start a new root from a topic or pasted source text.
- Send a message in the selected node.
- Stream an AI response.
- Auto-generate a short node title, node summary, and 3-7 suggested branch concepts.
- Expand a suggestion into a child node.
- Expand selected answer text into a child node.
- Display the tree as both nested outline and interactive 2D graph.
- Sync all trees or selected trees into an Obsidian vault folder.
- Preserve user notes in Obsidian after repeated syncs.
- Settings for provider, model, API key, Codex Local status, and Obsidian folder.

### v1 Nice To Have

- Image input for provider models that support vision.
- Optional generated learning illustration per node.
- Local import/export of an OpenMindSteed backup JSON.
- Command palette for node search and fast navigation.

### Post-v1

- 3D graph mode.
- Browser/PWA mode with File System Access API fallback.
- Bidirectional Obsidian sync.
- Multi-user or cloud sync.
- Published hosted provider.
- Plugin system for export formats.

## 4. Frontend Design Direction

Use the `frontend-design` skill direction: make the app visually specific and production-grade, not a generic AI dashboard.

### Visual Positioning

The interface should feel like a refined "knowledge observatory":

- Calm, precise, readable.
- High-density enough for repeated desktop work.
- Graph-centered without becoming decorative.
- Distinct from common purple-gradient AI UI.

### First Screen

The first screen is the app itself, not a marketing landing page.

- Left rail: roots, tree outline, new root button, sync status.
- Center workspace: graph canvas, breadcrumb, graph scope controls, quick actions.
- Right pane: current node title, summary, conversation, suggested branches, composer.

### Interaction Patterns

- Use icon buttons for repeat actions: new node, rename, delete, sync, search, settings, expand graph.
- Use segmented controls for graph/tree mode and graph scope.
- Use menus for provider/model choices.
- Use toggles for web search, image generation, and auto-sync.
- Use stable dimensions for graph nodes, toolbars, and composer controls so streaming text does not shift layout.

### UI Implementation

- React components should be split by product domain, not by visual atoms too early.
- Preferred libraries:
  - `lucide-react` for icons.
  - `@tanstack/react-query` only if async cache complexity justifies it.
  - `zustand` or TanStack Store for local UI/app state.
  - `reactflow` can be evaluated, but a custom Canvas/SVG graph may be better if graph behavior needs to match MindSteed closely.
  - `framer-motion` only for important transitions, not every hover state.

## 5. Data Model

### KnowledgeNode

Required fields:

- `id: string`
- `parentId: string | null`
- `rootId: string`
- `title: string`
- `summary: string`
- `sourceText: string | null`
- `sourceMessageId: string | null`
- `creationMethod: "root" | "manual" | "suggestion" | "selection" | "follow_up_branch"`
- `nodeType: "root" | "concept"`
- `childOrder: number`
- `pendingAutoPrompt: boolean`
- `titleAutoGenerated: boolean`
- `titleManuallyEdited: boolean`
- `createdAt: string`
- `updatedAt: string`

### ChatMessage

Required fields:

- `id: string`
- `nodeId: string`
- `role: "user" | "assistant" | "system"`
- `content: string`
- `status: "streaming" | "complete" | "error"`
- `createdAt: string`

Generated images should be represented as a structured message payload rather than arbitrary inline text. For compatibility with the original app, the importer/exporter may still understand the legacy prefix:

`__mindsteed_generated_image__:`

### ConceptSuggestion

Required fields:

- `id: string`
- `nodeId: string`
- `label: string`
- `reason: string`
- `priority: number`
- `difficulty: "beginner" | "intermediate" | "advanced"`
- `relation: string`
- `status: "suggested" | "expanded" | "dismissed"`
- `createdAt: string`

## 6. AI Interface

All providers must implement a shared provider contract.

```ts
export interface MindSteedAIProvider {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  streamChat(
    request: ChatStreamRequest,
    handlers: AIStreamHandlers,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface AIStreamHandlers {
  onMessageDelta(text: string): void;
  onMessageDone(text: string): void;
  onTitleDone(title: string): void;
  onSummaryDone(summary: string): void;
  onSuggestionsDone(suggestions: APISuggestion[]): void;
  onImageDone?(image: GeneratedImage): void;
  onImageError?(message: string): void;
  onError(message: string): void;
}
```

### Prompt Contract

Keep the existing MindSteed tutor behavior:

- The model is a Chinese learning tutor.
- The model answers the current user question only; the app creates nodes.
- Context includes current node, parent node, root node, source text, recent messages, intent, and enabled tools.
- After the answer, extract:
  - short title
  - compact summary for future context
  - 3-7 suggested concepts

### Chat Intents

Keep the current intent set:

- `root_start`
- `branch_start`
- `follow_up`
- `follow_up_as_branch`

## 7. BYOK Direct Provider

This is the default provider and must be reliable before Codex Local is exposed.

### Provider Presets

v1 presets:

- OpenAI-compatible custom endpoint.
- DeepSeek.
- Qwen.
- Zhipu GLM.
- Kimi.
- Doubao.

Each preset declares:

- base URL
- default chat model
- optional vision model
- web search support
- image generation support
- JSON response support
- provider-specific request shape

### Request Flow

1. Build `ChatStreamRequest`.
2. Stream chat completion.
3. Append source citations if the provider returns web-search sources.
4. Emit `message.done`.
5. Run extraction request for title, summary, suggestions.
6. If extraction fails, use deterministic fallback extraction.
7. If image generation is enabled, generate and store the image locally.

## 8. Codex Local Provider

### Purpose

Codex Local Provider allows users to use OpenMindSteed through their local Codex login. This gives a practical "ChatGPT subscription path" without asking OpenMindSteed to handle ChatGPT OAuth or touch Codex credentials.

Official Codex docs establish these relevant boundaries:

- Codex supports ChatGPT sign-in and API-key sign-in.
- Codex app-server is the rich-client integration surface for local Codex.
- Codex access tokens are for trusted Codex local workflows, not general OpenAI API calls.

Reference links:

- https://developers.openai.com/codex/auth
- https://developers.openai.com/codex/app-server
- https://developers.openai.com/codex/enterprise/access-tokens

### Non-Negotiable Security Rules

- Never read `~/.codex/auth.json`.
- Never ask the user to paste a Codex token.
- Never store `CODEX_ACCESS_TOKEN`.
- Never expose a non-loopback app-server listener.
- Default to `stdio://` app-server transport.
- Treat Codex Local as a local trusted-user integration, not a SaaS backend.
- Surface clear warnings that Codex is an experimental provider for this product.

### CLI Detection

Tauri backend should resolve the Codex binary in this order:

1. user-configured path in settings
2. `OPENMINDSTEED_CODEX_BIN`
3. `codex` on `PATH`
4. macOS fallback: `/Applications/Codex.app/Contents/Resources/codex`

The settings screen should show:

- Codex binary found or missing
- CLI version
- login status if detectable through a safe command
- app-server compatibility status

### Transport

Use app-server over stdio first:

```bash
codex app-server --listen stdio://
```

Generate protocol types during development:

```bash
codex app-server generate-ts --out src-tauri/protocol/codex-generated
```

Pin the tested Codex CLI version range in docs and show a compatibility warning outside that range.

### Runtime Flow

1. Spawn `codex app-server --listen stdio://`.
2. Send `initialize` with `clientInfo.name = "openmindsteed"`.
3. Send `initialized`.
4. Start or resume a Codex thread for the current OpenMindSteed node.
5. Start a turn with a carefully built learning prompt.
6. Collect `item/agentMessage/delta` and final agent message events.
7. Map deltas to `onMessageDelta`.
8. On turn completion, run a second extraction step using Codex Local or local fallback.
9. Emit title, summary, and suggestions through the shared AI provider contract.

### Thread Mapping

Store an optional mapping:

- `nodeId`
- `codexThreadId`
- `createdAt`
- `lastUsedAt`

Default behavior:

- One Codex thread per OpenMindSteed node.
- If thread resume fails, create a new Codex thread and keep the OpenMindSteed conversation intact.

### Prompt Guardrails

Codex is a coding agent, so prompts must reduce irrelevant repo/file behavior:

- Tell Codex not to edit files or run commands for normal learning turns.
- Use an app-created empty working directory as `cwd`.
- Use the most restrictive available sandbox setting.
- Ignore tool events in the learning UI unless they affect final text.
- If Codex refuses or behaves like a code-review agent, fall back to a direct provider recommendation.

### UI Copy

Use precise labels:

- Provider name: `Codex Local`
- Description: `Use your locally signed-in Codex app/CLI. OpenMindSteed never handles your ChatGPT OAuth token.`
- Warning: `Experimental. Codex is optimized for software tasks, so BYOK Direct remains the recommended provider for everyday learning.`

Do not label this as `GPT OAuth` or `ChatGPT OAuth Provider`, because that would imply OpenMindSteed owns a general OAuth flow.

## 9. Obsidian Sync Design

### Folder Structure

Within the selected Obsidian vault folder:

```text
Index.md
.mindsteed-sync.json
Trees/
  <tree-title>-<root-short-id>/
    Index.md
    Nodes/
      01-<node-title>-<short-id>.md
    Assets/
      <generated-image-files>
_Deleted/
  <timestamp>/
    ...
```

### Managed Block

Every generated Markdown document must wrap generated content in:

```md
<!-- mindsteed:managed:start -->

...

<!-- mindsteed:managed:end -->

## My Notes
```

On repeated sync:

- Replace only the managed block.
- Preserve everything outside the block.
- If an existing file has no managed block, prepend a managed block and preserve the old content under `My Notes`.

### Markdown Content

Vault index:

- frontmatter with `mindsteed_export`, `mindsteed_scope`, `mindsteed_exported_at`
- list of synced trees

Tree index:

- frontmatter with `mindsteed_root_id`
- summary
- Mermaid tree diagram
- nested WikiLink tree

Node note:

- frontmatter with stable node IDs and timestamps
- title
- summary
- parent/children links
- source text
- conversation
- suggested branches
- generated image embeds

### Pruning

When a managed node disappears:

- Do not permanently delete immediately.
- Move prior managed file to `_Deleted/<timestamp>/...`.
- Mark manifest entry as deleted.

## 10. Implementation Phases

### Phase 0: Repository Foundation

Deliverables:

- Initialize git repository.
- Add license, contribution guide, code of conduct, and issue templates.
- Create Tauri + React + TypeScript scaffold.
- Add `pnpm`, ESLint, Prettier, Vitest, Playwright.
- Add basic CI workflow.
- Add architecture docs and provider docs.

Acceptance:

- `pnpm install`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm tauri dev` opens a shell app.

### Phase 1: Local Data and Workspace UI

Deliverables:

- SQLite schema and migrations.
- Node CRUD.
- Message CRUD.
- Suggestion CRUD.
- Three-pane desktop layout.
- Empty state and new root flow.
- Mock provider for deterministic local development.

Acceptance:

- User can create a root, add child nodes, select nodes, and see messages.
- No AI key required for local UI development.
- Playwright covers core navigation.

### Phase 2: BYOK Direct Provider

Deliverables:

- Provider settings screen.
- Secret storage.
- OpenAI-compatible streaming client.
- Extraction flow.
- Provider presets.
- Error states and retry.

Acceptance:

- User can configure a provider and get streamed responses.
- Title, summary, and suggestions update after response.
- Missing/invalid key errors are clear.

### Phase 3: Graph Experience

Deliverables:

- 2D graph view.
- Current node focus.
- Root/global/focus scope controls.
- Node selection from graph.
- Create branch from graph.

Acceptance:

- Graph stays readable with at least 100 nodes.
- Selecting a graph node updates the conversation pane.
- Layout does not jump during streaming.

### Phase 4: Obsidian Sync

Deliverables:

- Folder picker.
- Sync all trees.
- Sync selected tree.
- Manifest read/write.
- Managed block merge.
- Asset copy for generated images.
- Sync status UI.

Acceptance:

- Repeated sync preserves user-written notes.
- Deleted app nodes move to `_Deleted`.
- Obsidian WikiLinks resolve correctly.
- Tests cover Markdown generation and merge behavior.

### Phase 5: Codex Local Provider

Deliverables:

- Codex binary detection.
- Codex settings/status panel.
- app-server stdio client.
- Protocol type generation.
- Codex thread mapping.
- Provider adapter implementing `MindSteedAIProvider`.
- Clear experimental warnings.

Acceptance:

- If Codex is installed and signed in, user can select `Codex Local`.
- OpenMindSteed streams a node answer through Codex app-server.
- The app never reads Codex credential files.
- If Codex is missing or logged out, UI shows the exact setup action.

### Phase 6: Polish and Public Release

Deliverables:

- App icon and visual identity.
- README with screenshots.
- Example vault export.
- macOS signed development build instructions.
- Contributor docs.
- First GitHub release.

Acceptance:

- Fresh clone can run from documented commands.
- At least one screenshot-based UI verification pass is clean.
- No secrets are written to logs or repo files.

## 11. Testing Strategy

### Unit Tests

- Tree ordering.
- Node deletion cascade and child promotion.
- Prompt packing.
- Extraction JSON parser and fallback.
- Provider capability resolution.
- Obsidian safe file names.
- WikiLink escaping.
- Managed block merge.
- Manifest pruning.

### Integration Tests

- New root -> first AI response -> suggestions -> child expansion.
- Provider missing key -> actionable settings error.
- Obsidian sync -> manual note edit -> resync -> note preserved.
- Deleted node -> `_Deleted` movement.
- Codex Local missing binary -> clear error.
- Codex Local installed but unavailable -> clear error.

### UI Tests

- Desktop wide layout.
- Narrow layout.
- New root modal.
- Provider settings.
- Obsidian settings.
- Graph selection.
- Composer streaming state.
- Theme contrast and text overflow.

### Manual Release Checks

- Run with no provider configured.
- Run with BYOK provider configured.
- Run with Obsidian folder configured.
- Run with Codex Local selected on a machine with Codex installed.
- Verify no credential material appears in logs, SQLite, or exported Markdown.

## 12. Risks and Mitigations

### Codex Local Is Not a General GPT API

Risk:

- Codex may behave like a coding agent instead of a learning tutor.

Mitigation:

- Keep BYOK Direct as default.
- Mark Codex Local experimental.
- Use strong prompt guardrails.
- Keep provider adapter isolated so it can be removed or redesigned without touching core app logic.

### Obsidian Sync Data Loss

Risk:

- Bad merge logic could overwrite user notes.

Mitigation:

- Replace only managed blocks.
- Preserve unmanaged content.
- Move removed files to `_Deleted`.
- Write extensive merge tests before enabling auto-sync.

### Provider Fragmentation

Risk:

- Each provider has slightly different streaming, search, image, and JSON behavior.

Mitigation:

- Use a strict internal provider contract.
- Keep provider-specific code behind adapters.
- Add capability flags and clear UI gating.

### Overbuilding v1

Risk:

- 3D graph, bidirectional sync, and hosted accounts could delay open-source launch.

Mitigation:

- v1 ships local-first with 2D graph, BYOK, managed Obsidian sync.
- Codex Local lands after the stable direct provider.

## 13. Initial Repository Structure

Target structure after scaffold:

```text
OpenMindSteed/
  README.md
  LICENSE
  package.json
  pnpm-lock.yaml
  src/
    app/
    components/
    features/
      ai/
      graph/
      nodes/
      obsidian/
      settings/
    styles/
    test/
  src-tauri/
    src/
      ai/
      codex/
      db/
      obsidian/
      secrets/
    tauri.conf.json
  docs/
    OPENMINDSTEED_PLAN.md
    provider-contract.md
    obsidian-sync.md
    codex-local-provider.md
```

## 14. Done Definition

The plan is implemented when:

- A user can clone the repo, run the documented commands, and open the desktop app.
- The app supports local knowledge trees and node conversations.
- BYOK Direct provider works for at least one OpenAI-compatible provider.
- Obsidian managed sync works and preserves user notes.
- Codex Local Provider is available as an experimental provider without handling or storing ChatGPT OAuth tokens.
- Tests cover data model behavior, provider parsing, Obsidian sync, and the main UI flows.
- The README clearly explains setup, privacy, provider choices, and Obsidian sync behavior.
