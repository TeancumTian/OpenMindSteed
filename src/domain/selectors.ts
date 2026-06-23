import type {
  ChatMessage,
  ConceptSuggestion,
  KnowledgeNode,
  MindSteedState,
  NodeId,
} from "./types";

export function sortNodes(a: KnowledgeNode, b: KnowledgeNode): number {
  if (a.childOrder !== b.childOrder) return a.childOrder - b.childOrder;
  return a.title.localeCompare(b.title, "zh-CN");
}

export function rootNodes(nodes: KnowledgeNode[]): KnowledgeNode[] {
  return nodes
    .filter((node) => node.parentId === null)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function childrenOf(nodes: KnowledgeNode[], nodeId: NodeId): KnowledgeNode[] {
  return nodes.filter((node) => node.parentId === nodeId).sort(sortNodes);
}

export function descendantsOf(nodes: KnowledgeNode[], nodeId: NodeId): KnowledgeNode[] {
  const children = childrenOf(nodes, nodeId);
  return children.flatMap((child) => [child, ...descendantsOf(nodes, child.id)]);
}

export function selectedNode(state: MindSteedState): KnowledgeNode | null {
  const roots = rootNodes(state.nodes);
  if (state.selectedNodeId) {
    return state.nodes.find((node) => node.id === state.selectedNodeId) ?? roots[0] ?? null;
  }
  return roots[0] ?? null;
}

export function parentOf(nodes: KnowledgeNode[], node: KnowledgeNode): KnowledgeNode | null {
  if (!node.parentId) return null;
  return nodes.find((candidate) => candidate.id === node.parentId) ?? null;
}

export function rootOf(nodes: KnowledgeNode[], node: KnowledgeNode): KnowledgeNode | null {
  return nodes.find((candidate) => candidate.id === node.rootId) ?? null;
}

export function messagesFor(messages: ChatMessage[], nodeId: NodeId): ChatMessage[] {
  return messages
    .filter((message) => message.nodeId === nodeId)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export function suggestionsFor(
  suggestions: ConceptSuggestion[],
  nodeId: NodeId,
): ConceptSuggestion[] {
  return suggestions
    .filter((suggestion) => suggestion.nodeId === nodeId && suggestion.status === "suggested")
    .sort((a, b) => a.priority - b.priority);
}

export function pathToNode(nodes: KnowledgeNode[], nodeId: NodeId): KnowledgeNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: KnowledgeNode[] = [];
  const visited = new Set<string>();
  let cursor = byId.get(nodeId);

  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    path.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }

  return path.reverse();
}
