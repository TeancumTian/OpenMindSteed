import type {
  APISuggestion,
  ChatMessage,
  ChatStreamRequest,
  KnowledgeNode,
} from "../../domain/types";
import { messagesFor, parentOf, rootOf } from "../../domain/selectors";

export function truncate(value: string, limit: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
}

export function hasMeaningfulQuestion(message: string): boolean {
  return /[A-Za-z0-9\u4e00-\u9fff]/u.test(message);
}

export function buildChatStreamRequest(input: {
  node: KnowledgeNode;
  nodes: KnowledgeNode[];
  messages: ChatMessage[];
  userMessage: string;
  intent?: ChatStreamRequest["intent"];
  webSearch: boolean;
  generateImage: boolean;
}): ChatStreamRequest {
  const parent = parentOf(input.nodes, input.node);
  const root = rootOf(input.nodes, input.node);
  const recentMessages = messagesFor(input.messages, input.node.id)
    .slice(-6)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));

  return {
    node: {
      id: input.node.id,
      title: input.node.title,
      summary: input.node.summary,
    },
    parent: parent
      ? {
          id: parent.id,
          title: parent.title,
          summary: parent.summary,
        }
      : undefined,
    root: root
      ? {
          id: root.id,
          title: root.title,
          summary: root.summary,
        }
      : undefined,
    recentMessages,
    userMessage: input.userMessage,
    intent: input.intent ?? "follow_up",
    sourceText: input.node.sourceText ?? undefined,
    locale: navigator.language || "zh-CN",
    tools: {
      webSearch: input.webSearch,
      generateImage: input.generateImage,
    },
    imageInputs: [],
  };
}

export function buildTutorPrompt(request: ChatStreamRequest): string {
  const recent = request.recentMessages
    .map((message) => `- ${message.role}: ${truncate(message.content, 800)}`)
    .join("\n");
  return [
    "你是 OpenMindSteed 的中文学习导师。回答要清晰、分层、适合长期沉淀到知识树。",
    "不要创建节点，只解释当前问题，并在回答中保留当前节点和父节点的关系。",
    `对话意图: ${request.intent}`,
    `当前节点: ${request.node.title}`,
    `当前节点摘要: ${request.node.summary}`,
    `父节点: ${request.parent?.title ?? ""}`,
    `父节点摘要: ${request.parent?.summary ?? ""}`,
    `根节点: ${request.root?.title ?? ""}`,
    `根节点摘要: ${request.root?.summary ?? ""}`,
    `来源文本: ${request.sourceText ?? ""}`,
    `联网搜索: ${request.tools?.webSearch ? "enabled" : "disabled"}`,
    `图片生成: ${request.tools?.generateImage ? "enabled" : "disabled"}`,
    "最近消息:",
    recent || "- none",
    `用户新问题: ${request.userMessage}`,
  ].join("\n");
}

export function buildExtractionPrompt(request: ChatStreamRequest, answer: string): string {
  return [
    "请根据当前节点上下文、用户问题和 AI 回答，生成一个更适合作为知识树节点名的短标题，更新节点摘要，并提取 3-7 个用户可能想继续学习的概念。",
    "请只输出 JSON，不要输出其他文字。",
    '格式: {"title":"...","summary":"...","suggestions":[{"label":"...","reason":"...","priority":1,"difficulty":"beginner","relation":"child"}]}',
    "",
    "上下文:",
    buildTutorPrompt(request),
    "",
    "AI 回答:",
    answer,
  ].join("\n");
}

export function parseExtraction(text: string): {
  title: string;
  summary: string;
  suggestions: APISuggestion[];
} | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as {
      title?: unknown;
      summary?: unknown;
      suggestions?: unknown;
    };
    if (typeof raw.title !== "string" || typeof raw.summary !== "string") {
      return null;
    }
    const suggestions = Array.isArray(raw.suggestions)
      ? raw.suggestions.flatMap((item, index) => {
          if (!item || typeof item !== "object") return [];
          const candidate = item as Record<string, unknown>;
          if (typeof candidate.label !== "string" || candidate.label.trim() === "") return [];
          const difficulty: APISuggestion["difficulty"] =
            candidate.difficulty === "intermediate" || candidate.difficulty === "advanced"
              ? candidate.difficulty
              : "beginner";
          return [
            {
              label: candidate.label,
              reason: typeof candidate.reason === "string" ? candidate.reason : "",
              priority: typeof candidate.priority === "number" ? candidate.priority : index + 1,
              difficulty,
              relation: typeof candidate.relation === "string" ? candidate.relation : "child",
            },
          ];
        })
      : [];
    return {
      title: raw.title,
      summary: raw.summary,
      suggestions: suggestions.slice(0, 7),
    };
  } catch {
    return null;
  }
}

export function fallbackExtraction(answer: string, userMessage: string) {
  const words = answer
    .replaceAll("\n", " ")
    .split(/[，。！？、\s]+/u)
    .map((token) => token.trim())
    .filter(
      (token, index, list) =>
        token.length >= 2 && token.length <= 18 && list.indexOf(token) === index,
    )
    .slice(0, 5);
  const labels = words.length > 0 ? words : [truncate(userMessage, 18) || "继续探索"];

  return {
    title: truncate(userMessage || labels[0], 22),
    summary: truncate(answer, 420),
    suggestions: labels.map((label, index) => ({
      label,
      reason: "这是当前回答里值得继续展开的概念。",
      priority: index + 1,
      difficulty: "beginner" as const,
      relation: "child",
    })),
  };
}
