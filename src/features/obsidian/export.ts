import type {
  ChatMessage,
  ConceptSuggestion,
  GeneratedImage,
  KnowledgeNode,
  MindSteedState,
  NodeId,
} from "../../domain/types";
import { childrenOf, rootNodes, sortNodes } from "../../domain/selectors";

export interface ObsidianFile {
  relativePath: string;
  contents: string;
  kind: "vaultIndex" | "treeIndex" | "node";
  sourceId: string;
  rootId: string | null;
}

export interface ObsidianAsset {
  relativePath: string;
  sourcePath: string;
  kind: "generatedImage";
  sourceId: string;
  rootId: string;
  mimeType: string;
}

export interface ObsidianPackage {
  files: ObsidianFile[];
  assets: ObsidianAsset[];
  treeCount: number;
  nodeCount: number;
  scope: {
    kind: "vault" | "tree";
    rootId: string | null;
  };
}

export const managedStart = "<!-- mindsteed:managed:start -->";
export const managedEnd = "<!-- mindsteed:managed:end -->";

export interface BuildObsidianPackageOptions {
  rootId?: NodeId;
  includeVaultIndex?: boolean;
}

export function buildObsidianPackage(
  state: MindSteedState,
  exportedAt = new Date(),
  options: BuildObsidianPackageOptions = {},
): ObsidianPackage {
  const allRoots = rootNodes(state.nodes);
  const roots = options.rootId ? allRoots.filter((root) => root.id === options.rootId) : allRoots;
  const includeVaultIndex = options.includeVaultIndex ?? !options.rootId;
  const scope = {
    kind: options.rootId ? ("tree" as const) : ("vault" as const),
    rootId: options.rootId ?? null,
  };
  const files: ObsidianFile[] = includeVaultIndex
    ? [
        {
          relativePath: "Index.md",
          contents: wrapManaged(buildVaultIndex(roots, exportedAt)),
          kind: "vaultIndex",
          sourceId: "vault",
          rootId: null,
        },
      ]
    : [];
  const assets: ObsidianAsset[] = [];
  let nodeCount = 0;

  for (const root of roots) {
    const treeNodes = orderedTree(root, state.nodes);
    nodeCount += treeNodes.length;
    const treeFolder = treeFolderName(root);
    const treeMessages = state.messages.filter((message) =>
      treeNodes.some((node) => node.id === message.nodeId),
    );
    const imageAssets = buildGeneratedImageAssets(root.id, treeFolder, treeMessages);
    assets.push(...imageAssets.assets);
    files.push({
      relativePath: `Trees/${treeFolder}/Index.md`,
      contents: wrapManaged(buildTreeIndex(root, treeNodes, exportedAt)),
      kind: "treeIndex",
      sourceId: root.id,
      rootId: root.id,
    });

    const fileMap = makeFileMap(treeNodes);
    for (const node of treeNodes) {
      files.push({
        relativePath: `Trees/${treeFolder}/${fileMap.get(node.id)?.path ?? `Nodes/${node.id}.md`}`,
        contents: wrapManaged(
          buildNodeNote(
            node,
            treeNodes,
            fileMap,
            state.messages.filter((message) => message.nodeId === node.id),
            state.suggestions.filter((suggestion) => suggestion.nodeId === node.id),
            imageAssets.references,
            exportedAt,
          ),
        ),
        kind: "node",
        sourceId: node.id,
        rootId: root.id,
      });
    }
  }

  return {
    files,
    assets,
    treeCount: roots.length,
    nodeCount,
    scope,
  };
}

export function mergeManagedDocument(generated: string, existing?: string): string {
  const managed = wrapManaged(generated);
  if (!existing || existing.trim() === "") {
    return `${managed}\n\n## My Notes\n\n`;
  }
  const start = existing.indexOf(managedStart);
  const end = existing.indexOf(managedEnd, start + managedStart.length);
  if (start === -1 || end === -1) {
    return `${managed}\n\n## My Notes\n\n${existing.trim()}\n`;
  }
  return `${existing.slice(0, start)}${managed}${existing.slice(end + managedEnd.length)}`;
}

export function wrapManaged(contents: string): string {
  return `${managedStart}\n${contents.trim()}\n${managedEnd}`;
}

function buildVaultIndex(roots: KnowledgeNode[], exportedAt: Date): string {
  const lines = [
    "---",
    "mindsteed_export: true",
    'mindsteed_scope: "vault"',
    `mindsteed_exported_at: "${exportedAt.toISOString()}"`,
    "tags:",
    "  - mindsteed",
    "  - mindsteed/vault",
    "---",
    "",
    "# OpenMindSteed",
    "",
    `- Trees: ${roots.length}`,
    `- Synced: ${exportedAt.toISOString()}`,
    "",
    "## Knowledge Trees",
    "",
  ];
  if (roots.length === 0) {
    lines.push("No knowledge trees have been synced yet.");
  } else {
    for (const root of roots) {
      lines.push(`- [[Trees/${treeFolderName(root)}/Index|${wikiAlias(root.title)}]]`);
    }
  }
  return lines.join("\n");
}

function buildTreeIndex(root: KnowledgeNode, nodes: KnowledgeNode[], exportedAt: Date): string {
  const lines = [
    "---",
    "mindsteed_export: true",
    `mindsteed_root_id: "${escapeYaml(root.id)}"`,
    `mindsteed_exported_at: "${exportedAt.toISOString()}"`,
    "tags:",
    "  - mindsteed",
    "  - mindsteed/tree",
    "---",
    "",
    `# ${root.title}`,
    "",
  ];
  if (root.summary.trim()) {
    lines.push(`> ${root.summary}`, "");
  }
  lines.push("- Nodes: " + nodes.length, "- Exported: " + exportedAt.toISOString(), "");
  lines.push("## Tree", "", "```mermaid", "graph TD");
  for (const node of nodes) {
    lines.push(`  ${mermaidId(node.id)}["${mermaidLabel(node.title)}"]`);
  }
  for (const node of nodes) {
    if (node.parentId && nodes.some((candidate) => candidate.id === node.parentId)) {
      lines.push(`  ${mermaidId(node.parentId)} --> ${mermaidId(node.id)}`);
    }
  }
  lines.push("```", "", "## Nodes", "");
  appendTreeBullets(lines, root, nodes, makeFileMap(nodes), 0);
  return lines.join("\n");
}

interface NoteFile {
  path: string;
  linkTarget: string;
  title: string;
}

function buildNodeNote(
  node: KnowledgeNode,
  treeNodes: KnowledgeNode[],
  fileMap: Map<NodeId, NoteFile>,
  messages: ChatMessage[],
  suggestions: ConceptSuggestion[],
  imageReferences: Map<string, string>,
  exportedAt: Date,
): string {
  const children = childrenOf(treeNodes, node.id);
  const lines = [
    "---",
    `mindsteed_id: "${escapeYaml(node.id)}"`,
    `mindsteed_root_id: "${escapeYaml(node.rootId)}"`,
  ];
  if (node.parentId) lines.push(`mindsteed_parent_id: "${escapeYaml(node.parentId)}"`);
  lines.push(
    `mindsteed_title: "${escapeYaml(node.title)}"`,
    `mindsteed_created_at: "${node.createdAt}"`,
    `mindsteed_updated_at: "${node.updatedAt}"`,
    `mindsteed_exported_at: "${exportedAt.toISOString()}"`,
    "tags:",
    "  - mindsteed",
    "  - mindsteed/node",
    "---",
    "",
    `# ${node.title}`,
    "",
  );

  if (node.summary.trim()) {
    lines.push("## Summary", "", node.summary, "");
  }

  lines.push("## Connections", "", "- Tree: [[Index|树索引]]");
  if (node.parentId) {
    const parent = fileMap.get(node.parentId);
    if (parent) lines.push(`- Parent: [[${parent.linkTarget}|${wikiAlias(parent.title)}]]`);
  }
  if (children.length === 0) {
    lines.push("- Children: none");
  } else {
    lines.push("- Children:");
    for (const child of children) {
      const childFile = fileMap.get(child.id);
      if (childFile) lines.push(`  - [[${childFile.linkTarget}|${wikiAlias(childFile.title)}]]`);
    }
  }
  lines.push("");

  if (node.sourceText?.trim()) {
    lines.push("## Source", "", node.sourceText, "");
  }

  lines.push("## Conversation", "");
  const orderedMessages = [...messages].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  if (orderedMessages.length === 0) {
    lines.push("No conversation has been recorded for this node.", "");
  } else {
    for (const message of orderedMessages) {
      lines.push(
        `### ${roleName(message.role)} · ${message.createdAt}`,
        "",
        formatMessageContentForObsidian(message.content, imageReferences),
        "",
      );
    }
  }

  const activeSuggestions = suggestions
    .filter((suggestion) => suggestion.status === "suggested")
    .sort((a, b) => a.priority - b.priority);
  if (activeSuggestions.length > 0) {
    lines.push("## Suggested Branches", "");
    for (const suggestion of activeSuggestions) {
      lines.push(`- ${suggestion.label}: ${suggestion.reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function orderedTree(root: KnowledgeNode, nodes: KnowledgeNode[]): KnowledgeNode[] {
  const treeNodes = nodes.filter((node) => node.id === root.id || node.rootId === root.id);
  const result: KnowledgeNode[] = [];
  const visited = new Set<string>();

  function visit(node: KnowledgeNode) {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    result.push(node);
    for (const child of childrenOf(treeNodes, node.id)) {
      visit(child);
    }
  }

  visit(root);
  for (const node of [...treeNodes].sort(sortNodes)) {
    visit(node);
  }
  return result;
}

function makeFileMap(nodes: KnowledgeNode[]): Map<NodeId, NoteFile> {
  return new Map(
    nodes.map((node, index) => {
      const filename = `${String(index + 1).padStart(2, "0")}-${safeFileComponent(node.title)}-${shortId(node.id)}.md`;
      const path = `Nodes/${filename}`;
      return [
        node.id,
        {
          path,
          linkTarget: path.replace(/\.md$/u, ""),
          title: node.title,
        },
      ];
    }),
  );
}

function appendTreeBullets(
  lines: string[],
  node: KnowledgeNode,
  nodes: KnowledgeNode[],
  fileMap: Map<NodeId, NoteFile>,
  depth: number,
) {
  const file = fileMap.get(node.id);
  if (!file) return;
  lines.push(`${"  ".repeat(depth)}- [[${file.linkTarget}|${wikiAlias(file.title)}]]`);
  for (const child of childrenOf(nodes, node.id)) {
    appendTreeBullets(lines, child, nodes, fileMap, depth + 1);
  }
}

export function safeFileComponent(value: string, fallback = "Untitled"): string {
  const cleaned = value
    .trim()
    .replace(/[/\\:*?"<>|#[\]\n\r]/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/-+\s+-+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[ .-]+|[ .-]+$/gu, "");
  return (cleaned || fallback).slice(0, 64);
}

export function shortId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "")
    .slice(0, 8);
}

function treeFolderName(root: KnowledgeNode): string {
  return `${safeFileComponent(root.title, "Knowledge")}-${shortId(root.id)}`;
}

function wikiAlias(value: string): string {
  return value.replace(/[|[\]\n\r]/gu, "-");
}

function escapeYaml(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

function mermaidId(id: string): string {
  return `n_${shortId(id)}`;
}

function mermaidLabel(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, " ");
}

const generatedImagePrefix = "__mindsteed_generated_image__:";

function buildGeneratedImageAssets(rootId: string, treeFolder: string, messages: ChatMessage[]) {
  const assets: ObsidianAsset[] = [];
  const references = new Map<string, string>();
  const usedFilenames = new Set<string>();

  for (const message of messages) {
    const image = parseGeneratedImageForObsidian(message.content);
    if (!image?.localPath) continue;
    if (references.has(image.id)) continue;

    const extension = imageExtensionForMime(image.mimeType);
    const base = safeFileComponent(
      image.prompt || image.id || "generated-image",
      "generated-image",
    );
    let filename = `${shortId(image.id) || "image"}-${base}.${extension}`;
    let suffix = 2;
    while (usedFilenames.has(filename)) {
      filename = `${shortId(image.id) || "image"}-${base}-${suffix}.${extension}`;
      suffix += 1;
    }
    usedFilenames.add(filename);

    const relativePath = `Trees/${treeFolder}/Assets/${filename}`;
    assets.push({
      relativePath,
      sourcePath: image.localPath,
      kind: "generatedImage",
      sourceId: image.id,
      rootId,
      mimeType: image.mimeType,
    });
    references.set(image.id, `../Assets/${filename}`);
  }

  return { assets, references };
}

function imageExtensionForMime(mimeType: string): string {
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function formatMessageContentForObsidian(
  content: string,
  imageReferences: Map<string, string>,
): string {
  if (!content) return "_Empty message_";
  const image = parseGeneratedImageForObsidian(content);
  if (!image) return content;
  const target = imageReferences.get(image.id) || image.url;
  const alt = (image.prompt || "Generated learning illustration")
    .replace(/[[\]\n\r]/gu, " ")
    .slice(0, 120);
  const lines = [`![${alt}](<${target}>)`];
  if (image.prompt) {
    lines.push("", `Prompt: ${image.prompt}`);
  }
  if (image.sourceUrl && image.sourceUrl !== image.url) {
    lines.push("", `Source URL: ${image.sourceUrl}`);
  }
  return lines.join("\n");
}

function parseGeneratedImageForObsidian(content: string): GeneratedImage | null {
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
    if (!/^https?:\/\//iu.test(legacyUrl)) return null;
    return {
      id: "legacy-generated-image",
      url: legacyUrl,
      mimeType: "image/png",
      sourceUrl: legacyUrl,
    };
  }
}

function roleName(role: string): string {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  if (role === "system") return "System";
  return role;
}
