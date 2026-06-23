import {
  Bot,
  Braces,
  Check,
  ChevronRight,
  CircleAlert,
  Download,
  FolderOpen,
  GitBranchPlus,
  KeyRound,
  Moon,
  Network,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createId, nowIso } from "./domain/ids";
import {
  childrenOf,
  descendantsOf,
  messagesFor,
  pathToNode,
  rootNodes,
  selectedNode,
  suggestionsFor,
} from "./domain/selectors";
import type {
  ChatMessage,
  ConceptSuggestion,
  GeneratedImage,
  KnowledgeNode,
  NodeId,
  ProviderKind,
  ProviderPresetId,
} from "./domain/types";
import { providerFor } from "./features/ai";
import {
  applyProviderPreset,
  providerPresetById,
  providerPresets,
} from "./features/ai/providerPresets";
import { buildChatStreamRequest } from "./features/ai/prompts";
import { buildObsidianPackage } from "./features/obsidian/export";
import { createBackupPayload, stateFromBackupPayload } from "./state/persistence";
import { useMindSteed } from "./state/MindSteedStore";
import {
  checkCodexStatus,
  type CodexStatusResult,
  deleteSecret,
  isTauriRuntime,
  loadSecret,
  pickDirectory,
  saveSecret,
  storeGeneratedImageAsset,
  syncObsidianPackage,
} from "./tauri/bridge";

export function App() {
  const { state, dispatch, actions } = useMindSteed();
  const node = selectedNode(state);
  const roots = useMemo(() => rootNodes(state.nodes), [state.nodes]);
  const selectedMessages = node ? messagesFor(state.messages, node.id) : [];
  const selectedSuggestions = node ? suggestionsFor(state.suggestions, node.id) : [];
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncNotice, setSyncNotice] = useState("");
  const [syncScope, setSyncScope] = useState<"all" | "selected">("all");
  const [graphScope, setGraphScope] = useState<"global" | "root" | "focus">("root");
  const [commandOpen, setCommandOpen] = useState(false);
  const streamControllersRef = useRef(new Map<NodeId, AbortController>());
  const autoPromptStartedRef = useRef(new Set<NodeId>());

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function sendMessage(text: string) {
    if (!node || state.streamingNodeIds.includes(node.id)) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    const userMessage: ChatMessage = {
      id: createId("msg"),
      nodeId: node.id,
      role: "user",
      content: trimmed,
      status: "complete",
      createdAt: nowIso(),
    };
    const assistantId = createId("msg");
    const assistantMessage: ChatMessage = {
      id: assistantId,
      nodeId: node.id,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: nowIso(),
    };
    dispatch({ type: "add-message", message: userMessage });
    dispatch({ type: "add-message", message: assistantMessage });
    dispatch({ type: "set-streaming", nodeId: node.id, streaming: true });

    const controller = new AbortController();
    streamControllersRef.current.set(node.id, controller);
    const provider = providerFor(state.settings.provider.provider);
    const selectedProviderPreset = providerPresetById(state.settings.provider.providerPreset);
    const request = buildChatStreamRequest({
      node,
      nodes: state.nodes,
      messages: [...state.messages, userMessage],
      userMessage: trimmed,
      intent: chatIntentForNodeTurn(node, messagesFor(state.messages, node.id).length),
      webSearch:
        state.settings.provider.webSearch &&
        provider.capabilities.webSearch &&
        selectedProviderPreset.webSearchAdapter !== "none",
      generateImage:
        state.settings.provider.generateImage &&
        provider.capabilities.imageGeneration &&
        selectedProviderPreset.imageGenerationAdapter !== "none",
    });
    const codexThread = state.codexThreads.find((mapping) => mapping.nodeId === node.id);
    if (codexThread) {
      request.codexThreadId = codexThread.threadId;
    }

    let fullText = "";
    let codexDiagnosticNoticeShown = false;
    const codexStatusNoticesShown = new Set<string>();
    try {
      await provider.streamChat(
        request,
        {
          onMessageDelta(delta) {
            fullText += delta;
            dispatch({
              type: "update-message",
              messageId: assistantId,
              patch: { content: fullText },
            });
          },
          onMessageDone(answer) {
            fullText = answer || fullText;
            dispatch({
              type: "update-message",
              messageId: assistantId,
              patch: { content: fullText, status: "complete" },
            });
          },
          onTitleDone(title) {
            if (!node.titleManuallyEdited && title.trim()) {
              dispatch({
                type: "update-node",
                nodeId: node.id,
                patch: {
                  title: title.trim().slice(0, 48),
                  titleAutoGenerated: true,
                  pendingAutoPrompt: false,
                },
              });
            }
          },
          onSummaryDone(summary) {
            dispatch({
              type: "update-node",
              nodeId: node.id,
              patch: { summary, pendingAutoPrompt: false },
            });
          },
          onSuggestionsDone(suggestions) {
            dispatch({ type: "replace-suggestions", nodeId: node.id, suggestions });
          },
          onImageDone(image) {
            const imageMessageId = createId("msg");
            dispatch({
              type: "add-message",
              message: {
                id: imageMessageId,
                nodeId: node.id,
                role: "assistant",
                content: serializeGeneratedImageMessage(image),
                status: "complete",
                createdAt: nowIso(),
              },
            });
            void storeGeneratedImageAsset(image)
              .then((storedImage) => {
                dispatch({
                  type: "update-message",
                  messageId: imageMessageId,
                  patch: { content: serializeGeneratedImageMessage(storedImage) },
                });
              })
              .catch((error) => {
                dispatch({
                  type: "add-message",
                  message: {
                    id: createId("msg"),
                    nodeId: node.id,
                    role: "system",
                    content: `Image asset was generated but could not be saved locally: ${
                      error instanceof Error ? error.message : "unknown error"
                    }`,
                    status: "error",
                    createdAt: nowIso(),
                  },
                });
              });
          },
          onImageError(message) {
            dispatch({
              type: "add-message",
              message: {
                id: createId("msg"),
                nodeId: node.id,
                role: "system",
                content: `Image generation failed: ${message}`,
                status: "error",
                createdAt: nowIso(),
              },
            });
          },
          onProviderMetadata(metadata) {
            if (metadata.codexThreadId) {
              dispatch({
                type: "set-codex-thread",
                nodeId: node.id,
                threadId: metadata.codexThreadId,
              });
            }
            const codexNotice = codexThreadNoticeFromMetadata(metadata);
            if (codexNotice && !codexDiagnosticNoticeShown) {
              codexDiagnosticNoticeShown = true;
              dispatch({
                type: "add-message",
                message: {
                  id: createId("msg"),
                  nodeId: node.id,
                  role: "system",
                  content: codexNotice,
                  status: "complete",
                  createdAt: nowIso(),
                },
              });
            }
            const statusNotice = codexStatusNoticeFromMetadata(metadata);
            if (statusNotice && !codexStatusNoticesShown.has(statusNotice)) {
              codexStatusNoticesShown.add(statusNotice);
              dispatch({
                type: "add-message",
                message: {
                  id: createId("msg"),
                  nodeId: node.id,
                  role: "system",
                  content: statusNotice,
                  status: metadata.codexStatusSeverity === "warning" ? "error" : "complete",
                  createdAt: nowIso(),
                },
              });
            }
          },
          onError(message) {
            dispatch({
              type: "update-message",
              messageId: assistantId,
              patch: { content: message, status: "error" },
            });
          },
        },
        state.settings.provider,
        controller.signal,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI provider failed";
      if (controller.signal.aborted) {
        dispatch({
          type: "update-message",
          messageId: assistantId,
          patch: { content: fullText || "已停止生成。", status: "complete" },
        });
        return;
      }
      dispatch({
        type: "update-message",
        messageId: assistantId,
        patch: { content: fullText || message, status: fullText ? "complete" : "error" },
      });
    } finally {
      streamControllersRef.current.delete(node.id);
      dispatch({ type: "set-streaming", nodeId: node.id, streaming: false });
    }
  }

  useEffect(() => {
    if (!node?.pendingAutoPrompt) return;
    if (state.streamingNodeIds.includes(node.id)) return;
    if (selectedMessages.length > 0) return;
    if (autoPromptStartedRef.current.has(node.id)) return;
    const prompt = autoPromptForNode(node);
    if (!prompt) return;

    autoPromptStartedRef.current.add(node.id);
    void sendMessage(prompt);
  }, [node, selectedMessages.length, state.streamingNodeIds]);

  function cancelGeneration(nodeId: NodeId) {
    streamControllersRef.current.get(nodeId)?.abort();
  }

  function deleteNodeWithConfirmation(nodeId: NodeId) {
    const message = deleteNodeConfirmationMessage(state.nodes, nodeId);
    if (!message) return;
    if (window.confirm(message)) {
      actions.deleteNode(nodeId, true);
    }
  }

  function expandSuggestion(suggestion: ConceptSuggestion) {
    if (!node) return;
    dispatch({ type: "mark-suggestion-expanded", suggestionId: suggestion.id });
    actions.createChild(
      node.id,
      suggestion.label,
      "suggestion",
      `${suggestion.label}: ${suggestion.reason}`,
    );
  }

  function expandSelectedText(sourceMessageId: string, selectedText: string) {
    if (!node) return;
    const normalized = selectedText.replace(/\s+/gu, " ").trim();
    if (!normalized) return;
    const title = normalized.slice(0, 32);
    actions.createChild(node.id, title, "selection", normalized, sourceMessageId);
  }

  function buildScopedObsidianPackage() {
    return buildObsidianPackage(
      state,
      new Date(),
      syncScope === "selected" && node ? { rootId: node.rootId } : {},
    );
  }

  function createSyncPreview() {
    const pkg = buildScopedObsidianPackage();
    const scopeLabel = syncScope === "selected" ? "当前知识树" : "全部知识树";
    setSyncNotice(
      `${scopeLabel}: 已生成 ${pkg.files.length} 个 Markdown 文件，包含 ${pkg.treeCount} 棵树 / ${pkg.nodeCount} 个节点。`,
    );
    dispatch({ type: "record-sync-status", status: `${pkg.files.length} files prepared` });
  }

  function downloadSyncPackage() {
    const pkg = buildScopedObsidianPackage();
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "openmindsteed-obsidian-package.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function syncToVault() {
    const pkg = buildScopedObsidianPackage();
    if (!isTauriRuntime()) {
      setSyncNotice(
        "当前是浏览器预览环境，不能直接写入本地 vault；请使用 Export JSON 或在 Tauri 桌面环境运行。",
      );
      return;
    }
    try {
      const result = await syncObsidianPackage(state.settings.obsidian, pkg);
      const status = `${result.filesWritten} files synced`;
      const deletedNote =
        result.filesMovedToDeleted > 0
          ? `，${result.filesMovedToDeleted} 个旧文件已移到 _Deleted`
          : "";
      setSyncNotice(
        `已同步到 ${result.rootDirectory}${deletedNote}，manifest: ${result.manifestPath}`,
      );
      dispatch({ type: "record-sync-status", status });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Obsidian sync failed";
      setSyncNotice(message);
      dispatch({ type: "record-sync-status", status: message });
    }
  }

  return (
    <main className="app-shell">
      <TreePane
        roots={roots}
        nodes={state.nodes}
        selectedNodeId={node?.id ?? null}
        onSelect={(nodeId) => dispatch({ type: "select-node", nodeId })}
        onCreateRoot={actions.createRoot}
        onCreateChild={(parentId) => actions.createChild(parentId, "新分支", "manual")}
        onDeleteNode={deleteNodeWithConfirmation}
      />

      <section className="graph-pane" aria-label="知识图谱">
        <TopBar
          node={node}
          onOpenCommand={() => setCommandOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onReset={() => dispatch({ type: "reset-demo" })}
          theme={state.settings.theme}
          onToggleTheme={() =>
            dispatch({
              type: "update-settings",
              patch: { theme: state.settings.theme === "dark" ? "light" : "dark" },
            })
          }
        />
        <GraphCanvas
          nodes={state.nodes}
          graphScope={graphScope}
          selectedNodeId={node?.id ?? null}
          currentNode={node}
          onSelect={(nodeId) => dispatch({ type: "select-node", nodeId })}
          onScopeChange={setGraphScope}
          onCreateBranch={(parentId) => actions.createChild(parentId, "新分支", "manual")}
        />
        <SyncStrip
          provider={state.settings.provider.provider}
          syncScope={syncScope}
          syncNotice={syncNotice}
          lastSyncStatus={state.settings.obsidian.lastSyncStatus}
          onScopeChange={setSyncScope}
          onPrepare={createSyncPreview}
          onDownload={downloadSyncPackage}
          onSync={() => void syncToVault()}
        />
      </section>

      <ChatPane
        node={node}
        path={node ? pathToNode(state.nodes, node.id) : []}
        messages={selectedMessages}
        suggestions={selectedSuggestions}
        isStreaming={node ? state.streamingNodeIds.includes(node.id) : false}
        onSend={sendMessage}
        onExpandSuggestion={expandSuggestion}
        onExpandSelection={expandSelectedText}
        onCancel={() => node && cancelGeneration(node.id)}
        onRename={(nodeId, title) => actions.renameNode(nodeId, title)}
      />

      {commandOpen ? (
        <CommandPalette
          nodes={state.nodes}
          selectedNodeId={node?.id ?? null}
          onClose={() => setCommandOpen(false)}
          onSelect={(nodeId) => {
            dispatch({ type: "select-node", nodeId });
            setCommandOpen(false);
          }}
        />
      ) : null}

      {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
    </main>
  );
}

function TreePane(props: {
  roots: KnowledgeNode[];
  nodes: KnowledgeNode[];
  selectedNodeId: NodeId | null;
  onSelect(nodeId: NodeId): void;
  onCreateRoot(seedText: string): void;
  onCreateChild(parentId: NodeId): void;
  onDeleteNode(nodeId: NodeId): void;
}) {
  const [seedText, setSeedText] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    props.onCreateRoot(seedText);
    setSeedText("");
  }

  return (
    <aside className="tree-pane" aria-label="知识树">
      <div className="brand-lockup">
        <div className="brand-mark">
          <Network size={22} />
        </div>
        <div>
          <p>OpenMindSteed</p>
          <span>local knowledge observatory</span>
        </div>
      </div>

      <form className="new-root-form" onSubmit={submit}>
        <label htmlFor="new-root">新知识树</label>
        <div className="new-root-controls">
          <textarea
            id="new-root"
            value={seedText}
            onChange={(event) => setSeedText(event.target.value)}
            placeholder="输入主题、问题或粘贴一段原始材料"
          />
          <button
            className="icon-button solid"
            type="submit"
            aria-label="创建知识树"
            disabled={!seedText.trim()}
          >
            <Plus size={18} />
          </button>
        </div>
      </form>

      <div className="tree-list">
        {props.roots.map((root) => (
          <TreeNodeRow
            key={root.id}
            node={root}
            nodes={props.nodes}
            selectedNodeId={props.selectedNodeId}
            depth={0}
            onSelect={props.onSelect}
            onCreateChild={props.onCreateChild}
            onDeleteNode={props.onDeleteNode}
          />
        ))}
      </div>
    </aside>
  );
}

function TreeNodeRow(props: {
  node: KnowledgeNode;
  nodes: KnowledgeNode[];
  selectedNodeId: NodeId | null;
  depth: number;
  onSelect(nodeId: NodeId): void;
  onCreateChild(parentId: NodeId): void;
  onDeleteNode(nodeId: NodeId): void;
}) {
  const children = childrenOf(props.nodes, props.node.id);
  const active = props.selectedNodeId === props.node.id;
  return (
    <div>
      <div
        className={active ? "tree-row active" : "tree-row"}
        style={{ paddingLeft: `${12 + props.depth * 16}px` }}
      >
        <button type="button" onClick={() => props.onSelect(props.node.id)}>
          <ChevronRight size={14} className={children.length ? "chevron visible" : "chevron"} />
          <span>{props.node.title}</span>
        </button>
        <button
          type="button"
          className="micro-button"
          aria-label="添加分支"
          onClick={() => props.onCreateChild(props.node.id)}
        >
          <GitBranchPlus size={14} />
        </button>
        <button
          type="button"
          className="micro-button danger"
          aria-label="删除节点"
          onClick={() => props.onDeleteNode(props.node.id)}
        >
          <Trash2 size={13} />
        </button>
      </div>
      {children.map((child) => (
        <TreeNodeRow
          key={child.id}
          node={child}
          nodes={props.nodes}
          selectedNodeId={props.selectedNodeId}
          depth={props.depth + 1}
          onSelect={props.onSelect}
          onCreateChild={props.onCreateChild}
          onDeleteNode={props.onDeleteNode}
        />
      ))}
    </div>
  );
}

function TopBar(props: {
  node: KnowledgeNode | null;
  theme: "dark" | "light";
  onOpenCommand(): void;
  onOpenSettings(): void;
  onReset(): void;
  onToggleTheme(): void;
}) {
  return (
    <header className="top-bar">
      <div>
        <p className="eyebrow">Current Node</p>
        <h1>{props.node?.title ?? "还没有知识树"}</h1>
      </div>
      <div className="top-actions">
        <button
          className="icon-button"
          type="button"
          aria-label="搜索"
          onClick={props.onOpenCommand}
        >
          <Search size={18} />
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label="切换主题"
          onClick={props.onToggleTheme}
        >
          {props.theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <button className="icon-button" type="button" aria-label="重置示例" onClick={props.onReset}>
          <RotateCcw size={18} />
        </button>
        <button
          className="icon-button solid"
          type="button"
          aria-label="设置"
          onClick={props.onOpenSettings}
        >
          <Settings size={18} />
        </button>
      </div>
    </header>
  );
}

function GraphCanvas(props: {
  nodes: KnowledgeNode[];
  graphScope: "global" | "root" | "focus";
  selectedNodeId: NodeId | null;
  currentNode: KnowledgeNode | null;
  onSelect(nodeId: NodeId): void;
  onScopeChange(scope: "global" | "root" | "focus"): void;
  onCreateBranch(parentId: NodeId): void;
}) {
  const visibleNodes = useMemo(
    () => visibleGraphNodes(props.nodes, props.currentNode, props.graphScope),
    [props.nodes, props.currentNode, props.graphScope],
  );
  const layout = useMemo(() => layoutNodes(visibleNodes), [visibleNodes]);
  const byId = new Map(layout.map((item) => [item.node.id, item]));
  const edges = visibleNodes.flatMap((node) => {
    if (!node.parentId) return [];
    const from = byId.get(node.parentId);
    const to = byId.get(node.id);
    return from && to ? [{ from, to }] : [];
  });

  return (
    <div className="graph-stage">
      <div className="graph-toolbar">
        <div className="graph-scope-toggle" aria-label="Graph scope">
          {(["global", "root", "focus"] as const).map((scope) => (
            <button
              key={scope}
              type="button"
              className={props.graphScope === scope ? "active" : ""}
              onClick={() => props.onScopeChange(scope)}
            >
              {scope}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="graph-branch-action"
          disabled={!props.currentNode}
          onClick={() => props.currentNode && props.onCreateBranch(props.currentNode.id)}
        >
          <GitBranchPlus size={15} />
          Branch
        </button>
      </div>
      <svg viewBox="0 0 980 620" role="img" aria-label="知识图谱可视化">
        <defs>
          <filter id="nodeGlow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feColorMatrix
              in="blur"
              type="matrix"
              values="0 0 0 0 0.13 0 0 0 0 0.85 0 0 0 0 0.72 0 0 0 0.55 0"
            />
            <feBlend in="SourceGraphic" />
          </filter>
        </defs>
        {edges.map((edge) => (
          <path
            key={`${edge.from.node.id}-${edge.to.node.id}`}
            d={`M ${edge.from.x + 54} ${edge.from.y} C ${edge.from.x + 142} ${edge.from.y}, ${edge.to.x - 142} ${edge.to.y}, ${edge.to.x - 54} ${edge.to.y}`}
            className="graph-edge"
          />
        ))}
        {layout.map((item) => {
          const active = props.selectedNodeId === item.node.id;
          return (
            <g
              key={item.node.id}
              className={active ? "graph-node active" : "graph-node"}
              transform={`translate(${item.x}, ${item.y})`}
              onClick={() => props.onSelect(item.node.id)}
              tabIndex={0}
              role="button"
              aria-label={item.node.title}
            >
              <circle r={active ? 46 : 36} filter={active ? "url(#nodeGlow)" : undefined} />
              <text y="-2">{item.node.title.slice(0, 8)}</text>
              <text y="17" className="depth-label">
                {item.node.nodeType === "root" ? "root" : `d${item.depth}`}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ChatPane(props: {
  node: KnowledgeNode | null;
  path: KnowledgeNode[];
  messages: ChatMessage[];
  suggestions: ConceptSuggestion[];
  isStreaming: boolean;
  onSend(text: string): Promise<void>;
  onCancel(): void;
  onExpandSuggestion(suggestion: ConceptSuggestion): void;
  onExpandSelection(sourceMessageId: string, selectedText: string): void;
  onRename(nodeId: NodeId, title: string): void;
}) {
  const [text, setText] = useState("");
  const [renameDraft, setRenameDraft] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = text;
    setText("");
    void props.onSend(value);
  }

  function expandMessageSelection(message: ChatMessage) {
    const selection = window.getSelection()?.toString() ?? "";
    const selectedText = selection.replace(/\s+/gu, " ").trim();
    if (!selectedText || !message.content.replace(/\s+/gu, " ").includes(selectedText)) return;
    props.onExpandSelection(message.id, selectedText);
    window.getSelection()?.removeAllRanges();
  }

  if (!props.node) {
    return (
      <aside className="chat-pane empty">
        <CircleAlert size={24} />
        <p>创建一棵知识树开始。</p>
      </aside>
    );
  }

  return (
    <aside className="chat-pane" aria-label="节点对话">
      <div className="node-header">
        <div className="breadcrumb">
          {props.path.map((node) => (
            <span key={node.id}>{node.title}</span>
          ))}
        </div>
        <input
          value={renameDraft || props.node.title}
          onChange={(event) => setRenameDraft(event.target.value)}
          onBlur={() => {
            if (renameDraft.trim()) props.onRename(props.node!.id, renameDraft);
            setRenameDraft("");
          }}
          aria-label="节点标题"
        />
        <p>{props.node.summary || "这个节点还没有摘要。发送一次消息后会自动生成。"}</p>
      </div>

      <div className="message-list">
        {props.messages.map((message) => {
          const generatedImage = parseGeneratedImageMessage(message.content);
          return (
            <article key={message.id} className={`message ${message.role} ${message.status}`}>
              <div className="message-meta">
                {message.role === "assistant" ? (
                  <Bot size={16} />
                ) : message.role === "system" ? (
                  <Network size={16} />
                ) : (
                  <Sparkles size={16} />
                )}
                <span>
                  {message.role === "assistant"
                    ? "Tutor"
                    : message.role === "system"
                      ? "System"
                      : "You"}
                </span>
                {message.status === "streaming" ? <i>streaming</i> : null}
                {message.status === "error" ? <i>error</i> : null}
                {message.role === "assistant" &&
                message.status === "complete" &&
                !generatedImage ? (
                  <button
                    type="button"
                    className="message-branch-button"
                    aria-label="从选中文本创建分支"
                    title="从选中文本创建分支"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => expandMessageSelection(message)}
                  >
                    <GitBranchPlus size={14} />
                  </button>
                ) : null}
              </div>
              {generatedImage ? (
                <figure className="generated-image">
                  <img
                    src={generatedImage.url}
                    alt={generatedImage.prompt || "Generated learning illustration"}
                  />
                  <figcaption>
                    {generatedImage.prompt || "Generated learning illustration"}
                  </figcaption>
                </figure>
              ) : (
                <p>{message.content || "..."}</p>
              )}
            </article>
          );
        })}
      </div>

      <div className="suggestions">
        <div className="section-title">
          <Braces size={16} />
          <span>Suggested Branches</span>
        </div>
        {props.suggestions.length === 0 ? (
          <p className="muted">回答完成后会出现可展开分支。</p>
        ) : (
          props.suggestions.map((suggestion) => (
            <button
              key={suggestion.id}
              type="button"
              className="suggestion"
              onClick={() => props.onExpandSuggestion(suggestion)}
            >
              <span>{suggestion.label}</span>
              <small>{suggestion.reason}</small>
            </button>
          ))
        )}
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="继续追问，或要求它举例、比较、拆分..."
          disabled={props.isStreaming}
        />
        <button
          className={props.isStreaming ? "send-button stop" : "send-button"}
          type={props.isStreaming ? "button" : "submit"}
          disabled={!props.isStreaming && !text.trim()}
          onClick={props.isStreaming ? props.onCancel : undefined}
        >
          {props.isStreaming ? "停止" : "发送"}
        </button>
      </form>
    </aside>
  );
}

function CommandPalette(props: {
  nodes: KnowledgeNode[];
  selectedNodeId: NodeId | null;
  onClose(): void;
  onSelect(nodeId: NodeId): void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const results = useMemo(() => searchKnowledgeNodes(props.nodes, query), [props.nodes, query]);

  useEffect(() => {
    inputRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        props.onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.onClose]);

  return (
    <div className="command-backdrop" role="dialog" aria-modal="true">
      <section className="command-palette">
        <div className="command-search">
          <Search size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search nodes"
            aria-label="搜索节点"
          />
          <button
            type="button"
            className="micro-button"
            aria-label="关闭搜索"
            onClick={props.onClose}
          >
            <X size={14} />
          </button>
        </div>
        <div className="command-results">
          {results.map((node) => (
            <button
              key={node.id}
              type="button"
              className={
                props.selectedNodeId === node.id ? "command-result active" : "command-result"
              }
              onClick={() => props.onSelect(node.id)}
            >
              <span>{node.title}</span>
              <small>{node.summary || node.sourceText || "No summary yet"}</small>
            </button>
          ))}
          {results.length === 0 ? <p className="muted">No matching nodes</p> : null}
        </div>
      </section>
    </div>
  );
}

function SettingsPanel({ onClose }: { onClose(): void }) {
  const { state, dispatch } = useMindSteed();
  const provider = state.settings.provider;
  const obsidian = state.settings.obsidian;
  const selectedPreset = providerPresetById(provider.providerPreset);
  const activeProvider = providerFor(provider.provider);
  const webSearchAvailable =
    activeProvider.capabilities.webSearch && selectedPreset.webSearchAdapter !== "none";
  const imageGenerationAvailable =
    activeProvider.capabilities.imageGeneration && selectedPreset.imageGenerationAdapter !== "none";
  const autoSyncAvailable = false;
  const [secretStatus, setSecretStatus] = useState("");
  const [codexStatus, setCodexStatus] = useState("");
  const [vaultStatus, setVaultStatus] = useState("");
  const [backupStatus, setBackupStatus] = useState("");
  const [checkingCodex, setCheckingCodex] = useState(false);
  const backupInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadSecret("byok-api-key")
      .then((stored) => {
        if (!cancelled && stored && !provider.apiKey) {
          dispatch({
            type: "update-settings",
            patch: { provider: { ...provider, apiKey: stored } },
          });
          setSecretStatus("Loaded from OS keychain");
        }
      })
      .catch(() => {
        if (!cancelled) setSecretStatus("Keychain unavailable in this runtime");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function persistApiKey(value: string) {
    dispatch({
      type: "update-settings",
      patch: { provider: { ...provider, apiKey: value } },
    });
    if (!isTauriRuntime()) {
      setSecretStatus("Browser preview keeps API key in memory only");
      return;
    }
    try {
      if (value.trim()) {
        await saveSecret("byok-api-key", value);
        setSecretStatus("Saved to OS keychain");
      } else {
        await deleteSecret("byok-api-key");
        setSecretStatus("Removed from OS keychain");
      }
    } catch (error) {
      setSecretStatus(error instanceof Error ? error.message : "Could not update keychain");
    }
  }

  async function refreshCodexStatus() {
    if (!isTauriRuntime()) {
      setCodexStatus("Codex status is available in the Tauri desktop app.");
      return;
    }
    setCheckingCodex(true);
    try {
      const status = await checkCodexStatus(provider.codexBin);
      setCodexStatus(formatCodexStatusDisplay(status));
    } catch (error) {
      setCodexStatus(error instanceof Error ? error.message : "Could not check Codex status");
    } finally {
      setCheckingCodex(false);
    }
  }

  async function chooseObsidianVault() {
    if (!isTauriRuntime()) {
      setVaultStatus("Folder picker is available in the Tauri desktop app.");
      return;
    }
    try {
      const selected = await pickDirectory("Choose Obsidian Vault");
      if (!selected) {
        setVaultStatus("Folder selection cancelled");
        return;
      }
      dispatch({
        type: "update-settings",
        patch: { obsidian: { ...obsidian, vaultPath: selected } },
      });
      setVaultStatus("Vault folder selected");
    } catch (error) {
      setVaultStatus(error instanceof Error ? error.message : "Could not open folder picker");
    }
  }

  function exportBackup() {
    const payload = createBackupPayload(state);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `openmindsteed-backup-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setBackupStatus("Backup exported without provider secrets");
  }

  async function importBackup(file: File | null) {
    if (!file) return;
    try {
      const raw = await file.text();
      const imported = stateFromBackupPayload(JSON.parse(raw));
      dispatch({ type: "hydrate", state: imported });
      setBackupStatus(
        `Imported ${imported.nodes.length} nodes and ${imported.messages.length} messages`,
      );
    } catch (error) {
      setBackupStatus(error instanceof Error ? error.message : "Could not import backup JSON");
    } finally {
      if (backupInputRef.current) backupInputRef.current.value = "";
    }
  }

  return (
    <div className="settings-backdrop" role="dialog" aria-modal="true">
      <section className="settings-panel">
        <header>
          <div>
            <p className="eyebrow">Settings</p>
            <h2>Provider & Sync</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭设置">
            <Check size={18} />
          </button>
        </header>

        <label>
          AI Provider
          <select
            value={provider.provider}
            onChange={(event) =>
              dispatch({
                type: "update-settings",
                patch: {
                  provider: {
                    ...provider,
                    provider: event.target.value as ProviderKind,
                  },
                },
              })
            }
          >
            <option value="mock">Mock Tutor</option>
            <option value="byok">BYOK Direct</option>
            <option value="codex-local">Codex Local</option>
          </select>
        </label>

        <label>
          BYOK Preset
          <select
            value={provider.providerPreset}
            disabled={provider.provider !== "byok"}
            onChange={(event) =>
              dispatch({
                type: "update-settings",
                patch: {
                  provider: applyProviderPreset(provider, event.target.value as ProviderPresetId),
                },
              })
            }
          >
            {providerPresets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
          <small className="field-note">{selectedPreset.note}</small>
        </label>

        <label>
          Endpoint
          <input
            value={provider.endpoint}
            onChange={(event) =>
              dispatch({
                type: "update-settings",
                patch: {
                  provider: {
                    ...provider,
                    providerPreset: "custom",
                    endpoint: event.target.value,
                  },
                },
              })
            }
          />
        </label>

        <label>
          Model
          <input
            value={provider.model}
            onChange={(event) =>
              dispatch({
                type: "update-settings",
                patch: {
                  provider: {
                    ...provider,
                    providerPreset: "custom",
                    model: event.target.value,
                  },
                },
              })
            }
          />
        </label>

        <label>
          API Key
          <span className="input-with-icon">
            <KeyRound size={16} />
            <input
              type="password"
              value={provider.apiKey}
              placeholder="只用于 BYOK Direct；Tauri 环境保存到 OS keychain"
              onChange={(event) =>
                dispatch({
                  type: "update-settings",
                  patch: { provider: { ...provider, apiKey: event.target.value } },
                })
              }
              onBlur={(event) => void persistApiKey(event.target.value)}
            />
          </span>
          {secretStatus ? <small className="field-note">{secretStatus}</small> : null}
        </label>

        <label>
          Codex Binary
          <input
            value={provider.codexBin}
            placeholder="/Applications/Codex.app/Contents/Resources/codex"
            onChange={(event) =>
              dispatch({
                type: "update-settings",
                patch: { provider: { ...provider, codexBin: event.target.value } },
              })
            }
          />
          <span className="codex-status-row">
            <button
              type="button"
              onClick={() => void refreshCodexStatus()}
              disabled={checkingCodex}
            >
              {checkingCodex ? "Checking" : "Check Codex"}
            </button>
            {codexStatus ? <small className="field-note">{codexStatus}</small> : null}
          </span>
        </label>

        <label>
          Obsidian Vault Path
          <span className="path-picker-row">
            <input
              value={obsidian.vaultPath}
              placeholder="/Users/you/Documents/ObsidianVault"
              onChange={(event) =>
                dispatch({
                  type: "update-settings",
                  patch: { obsidian: { ...obsidian, vaultPath: event.target.value } },
                })
              }
            />
            <button
              type="button"
              className="icon-button"
              aria-label="选择 Obsidian vault 文件夹"
              title="选择 Obsidian vault 文件夹"
              onClick={() => void chooseObsidianVault()}
            >
              <FolderOpen size={17} />
            </button>
          </span>
          {vaultStatus ? <small className="field-note">{vaultStatus}</small> : null}
        </label>

        <div className="toggle-grid">
          <label>
            <input
              type="checkbox"
              checked={provider.webSearch && webSearchAvailable}
              disabled={!webSearchAvailable}
              onChange={(event) =>
                dispatch({
                  type: "update-settings",
                  patch: { provider: { ...provider, webSearch: event.target.checked } },
                })
              }
            />
            Web search
          </label>
          <label>
            <input
              type="checkbox"
              checked={provider.generateImage && imageGenerationAvailable}
              disabled={!imageGenerationAvailable}
              onChange={(event) =>
                dispatch({
                  type: "update-settings",
                  patch: { provider: { ...provider, generateImage: event.target.checked } },
                })
              }
            />
            Image generation
          </label>
          <label>
            <input
              type="checkbox"
              checked={obsidian.autoSync && autoSyncAvailable}
              disabled={!autoSyncAvailable}
              onChange={(event) =>
                dispatch({
                  type: "update-settings",
                  patch: { obsidian: { ...obsidian, autoSync: event.target.checked } },
                })
              }
            />
            Auto sync
          </label>
        </div>
        <small className="field-note">
          Tool toggles are disabled until the selected provider has an implemented adapter for that
          capability. Obsidian sync is manual in this build.
        </small>

        <section className="backup-panel" aria-label="OpenMindSteed backup">
          <div className="section-title">
            <Download size={16} />
            <span>Backup</span>
          </div>
          <div className="backup-actions">
            <button type="button" onClick={exportBackup}>
              <Download size={15} />
              Export
            </button>
            <button type="button" onClick={() => backupInputRef.current?.click()}>
              <Upload size={15} />
              Import
            </button>
          </div>
          <input
            ref={backupInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => void importBackup(event.target.files?.[0] ?? null)}
          />
          {backupStatus ? <small className="field-note">{backupStatus}</small> : null}
        </section>

        <div className="codex-warning">
          <CircleAlert size={18} />
          <p>
            Codex Local 只会通过本机 Tauri 后端调用 Codex app-server。OpenMindSteed 不读取
            auth.json，也不保存 CODEX_ACCESS_TOKEN。
          </p>
        </div>
      </section>
    </div>
  );
}

function SyncStrip(props: {
  provider: ProviderKind;
  syncScope: "all" | "selected";
  syncNotice: string;
  lastSyncStatus: string | null;
  onScopeChange(scope: "all" | "selected"): void;
  onPrepare(): void;
  onDownload(): void;
  onSync(): void;
}) {
  return (
    <footer className="sync-strip">
      <div>
        <span className="status-dot" />
        <p>
          Provider: <b>{props.provider}</b>
          {props.lastSyncStatus ? ` · ${props.lastSyncStatus}` : ""}
        </p>
      </div>
      <p className="muted">
        {props.syncNotice || "Obsidian sync currently prepares a package preview."}
      </p>
      <div className="sync-actions">
        <span className="scope-toggle" aria-label="Obsidian sync scope">
          <button
            type="button"
            className={props.syncScope === "all" ? "active" : ""}
            onClick={() => props.onScopeChange("all")}
          >
            All
          </button>
          <button
            type="button"
            className={props.syncScope === "selected" ? "active" : ""}
            onClick={() => props.onScopeChange("selected")}
          >
            Current
          </button>
        </span>
        <button type="button" onClick={props.onPrepare}>
          <Check size={16} />
          Prepare
        </button>
        <button type="button" onClick={props.onDownload}>
          <Download size={16} />
          Export JSON
        </button>
        <button type="button" onClick={props.onSync}>
          <Network size={16} />
          Sync Vault
        </button>
      </div>
    </footer>
  );
}

function layoutNodes(nodes: KnowledgeNode[]) {
  const byParent = new Map<string | null, KnowledgeNode[]>();
  for (const node of nodes) {
    const siblings = byParent.get(node.parentId) ?? [];
    siblings.push(node);
    byParent.set(node.parentId, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.childOrder - b.childOrder || a.title.localeCompare(b.title, "zh-CN"));
  }

  const items: Array<{ node: KnowledgeNode; x: number; y: number; depth: number }> = [];
  const roots = byParent.get(null) ?? [];
  let row = 0;

  function visit(node: KnowledgeNode, depth: number) {
    const children = byParent.get(node.id) ?? [];
    const startRow = row;
    if (children.length === 0) {
      row += 1;
    } else {
      for (const child of children) visit(child, depth + 1);
    }
    const endRow = row - 1;
    items.push({
      node,
      depth,
      x: 110 + depth * 220,
      y: 78 + ((startRow + endRow) / 2) * 92,
    });
  }

  for (const root of roots) {
    visit(root, 0);
    row += 0.5;
  }

  return items;
}

export function visibleGraphNodes(
  nodes: KnowledgeNode[],
  currentNode: KnowledgeNode | null,
  scope: "global" | "root" | "focus",
) {
  if (!currentNode || scope === "global") return nodes;
  if (scope === "root") {
    return nodes.filter((node) => node.rootId === currentNode.rootId);
  }

  const visible = new Set<NodeId>([currentNode.id]);
  for (const ancestor of pathToNode(nodes, currentNode.id)) {
    visible.add(ancestor.id);
  }
  for (const child of childrenOf(nodes, currentNode.id)) {
    visible.add(child.id);
  }
  if (currentNode.parentId) {
    for (const sibling of childrenOf(nodes, currentNode.parentId)) {
      visible.add(sibling.id);
    }
  }
  return nodes.filter((node) => visible.has(node.id));
}

export function deleteNodeConfirmationMessage(
  nodes: KnowledgeNode[],
  nodeId: NodeId,
): string | null {
  const target = nodes.find((node) => node.id === nodeId);
  if (!target) return null;
  const descendantCount = descendantsOf(nodes, target.id).length;
  const scope =
    descendantCount > 0 ? `“${target.title}”和 ${descendantCount} 个子节点` : `“${target.title}”`;
  return `删除${scope}？这只会删除 OpenMindSteed 中的节点；下次同步到 Obsidian 时，对应的托管文件会移动到 _Deleted。`;
}

export function autoPromptForNode(node: KnowledgeNode) {
  const source = node.sourceText?.trim();
  if (source) {
    return node.nodeType === "root"
      ? `请基于下面的主题或材料开始第一轮学习讲解，并给出可继续展开的分支：\n\n${source}`
      : `请基于下面的分支材料开始讲解，并联系当前知识树上下文给出可继续展开的分支：\n\n${source}`;
  }

  const title = node.title.trim();
  if (!title) return null;
  return `请围绕“${title}”开始讲解，给出核心定义、学习路径和可继续展开的分支。`;
}

export function chatIntentForNodeTurn(node: KnowledgeNode, existingMessageCount: number) {
  if (node.pendingAutoPrompt) {
    if (node.creationMethod === "selection" || node.creationMethod === "follow_up_branch") {
      return "follow_up_as_branch";
    }
    return node.nodeType === "root" ? "root_start" : "branch_start";
  }
  if (node.nodeType === "root" && existingMessageCount === 0) {
    return "root_start";
  }
  return "follow_up";
}

export function formatCodexStatusDisplay(status: CodexStatusResult) {
  const login = status.loggedIn
    ? status.loginStatus
    : `Not signed in: ${status.loginStatus}. Run \`codex login\` or open Codex and sign in with ChatGPT, then check again.`;
  const compatibility = status.appServerCompatible
    ? status.compatibilityNote
    : `Compatibility warning: ${status.compatibilityNote}`;
  return `${status.version} · ${login} · ${compatibility} · ${status.binary}`;
}

export function searchKnowledgeNodes(nodes: KnowledgeNode[], query: string, limit = 12) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [...nodes]
      .sort(
        (a, b) =>
          Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
          a.title.localeCompare(b.title, "zh-CN"),
      )
      .slice(0, limit);
  }

  return nodes
    .map((node) => {
      const title = node.title.toLowerCase();
      const summary = node.summary.toLowerCase();
      const source = (node.sourceText ?? "").toLowerCase();
      let score = 0;
      if (title === normalized) score += 120;
      if (title.startsWith(normalized)) score += 100;
      if (title.includes(normalized)) score += 80;
      if (summary.includes(normalized)) score += 45;
      if (source.includes(normalized)) score += 25;
      return { node, score };
    })
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Date.parse(b.node.updatedAt) - Date.parse(a.node.updatedAt) ||
        a.node.title.localeCompare(b.node.title, "zh-CN"),
    )
    .slice(0, limit)
    .map((item) => item.node);
}

export function codexThreadNoticeFromMetadata(metadata: Record<string, string>) {
  if (metadata.codexThreadStatus !== "resume-fallback") return null;
  const reason = (metadata.codexThreadResumeError ?? "").replace(/\s+/gu, " ").trim();
  if (!reason) {
    return "Codex Local 无法恢复上一次会话，已为当前节点创建新的本机会话。";
  }
  return `Codex Local 无法恢复上一次会话，已为当前节点创建新的本机会话。原因：${reason}`;
}

export function codexStatusNoticeFromMetadata(metadata: Record<string, string>) {
  if (!metadata.codexStatus || !metadata.codexStatusKind) return null;
  const kind = metadata.codexStatusKind.replace(/[_-]+/gu, " ").trim();
  const label = (metadata.codexStatusLabel ?? "").replace(/\s+/gu, " ").trim();
  const suffix = label ? `: ${label}` : "";
  if (metadata.codexStatusSeverity === "warning" && metadata.codexStatus === "blocked") {
    return `Codex Local tried to perform ${kind}${suffix}. OpenMindSteed stopped this learning turn to avoid local tool or command work.`;
  }
  return `Codex Local reported ${kind} ${metadata.codexStatus}${suffix}`;
}

const generatedImagePrefix = "__mindsteed_generated_image__:";

export function serializeGeneratedImageMessage(image: GeneratedImage) {
  return `${generatedImagePrefix}${JSON.stringify(image)}`;
}

export function parseGeneratedImageMessage(content: string): GeneratedImage | null {
  if (!content.startsWith(generatedImagePrefix)) return null;
  const payload = content.slice(generatedImagePrefix.length);
  try {
    const image = JSON.parse(payload) as Partial<GeneratedImage>;
    if (!image.url || !image.id || !image.mimeType) return null;
    return {
      id: image.id,
      url: image.url,
      mimeType: image.mimeType,
      sourceUrl: image.sourceUrl,
      localPath: image.localPath,
      byteLength: image.byteLength,
      storedAt: image.storedAt,
      prompt: image.prompt,
      size: image.size,
      quality: image.quality,
    };
  } catch {
    const legacyUrl = payload.trim();
    if (/^https?:\/\//iu.test(legacyUrl)) {
      return {
        id: "legacy-generated-image",
        url: legacyUrl,
        mimeType: "image/png",
        sourceUrl: legacyUrl,
      };
    }
    return null;
  }
}
