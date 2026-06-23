import { describe, expect, it } from "vitest";
import { createInitialState } from "../../domain/sampleData";
import type { ChatMessage } from "../../domain/types";
import {
  buildChatStreamRequest,
  buildTutorPrompt,
  fallbackExtraction,
  parseExtraction,
} from "./prompts";

const baseTime = "2026-06-23T18:00:00.000Z";

function message(index: number, nodeId: string): ChatMessage {
  return {
    id: `msg-${index}`,
    nodeId,
    role: index % 2 === 0 ? "assistant" : "user",
    content: `message ${index}`,
    status: "complete",
    createdAt: baseTime,
  };
}

describe("prompt packing", () => {
  it("packs node context, source text, tools, intent, and the latest six messages", () => {
    const state = createInitialState();
    const root = state.nodes[0];
    const messages = Array.from({ length: 8 }, (_, index) => message(index, root.id));

    const request = buildChatStreamRequest({
      node: root,
      nodes: state.nodes,
      messages,
      userMessage: "如何开始？",
      intent: "root_start",
      webSearch: true,
      generateImage: true,
    });

    expect(request.intent).toBe("root_start");
    expect(request.sourceText).toBe(root.sourceText);
    expect(request.root?.id).toBe(root.id);
    expect(request.parent).toBeUndefined();
    expect(request.tools).toEqual({ webSearch: true, generateImage: true });
    expect(request.recentMessages.map((item) => item.content)).toEqual([
      "message 2",
      "message 3",
      "message 4",
      "message 5",
      "message 6",
      "message 7",
    ]);
  });

  it("includes parent and root context for child nodes in the tutor prompt", () => {
    const state = createInitialState();
    const child = state.nodes[1];
    const request = buildChatStreamRequest({
      node: child,
      nodes: state.nodes,
      messages: [],
      userMessage: "解释这个分支",
      intent: "branch_start",
      webSearch: false,
      generateImage: false,
    });
    const prompt = buildTutorPrompt(request);

    expect(prompt).toContain("对话意图: branch_start");
    expect(prompt).toContain(`当前节点: ${child.title}`);
    expect(prompt).toContain(`父节点: ${state.nodes[0].title}`);
    expect(prompt).toContain(`根节点: ${state.nodes[0].title}`);
    expect(prompt).toContain("联网搜索: disabled");
    expect(prompt).toContain("图片生成: disabled");
    expect(prompt).toContain("用户新问题: 解释这个分支");
  });
});

describe("extraction parsing", () => {
  it("parses extraction JSON and limits suggestions to seven", () => {
    const text = JSON.stringify({
      title: "节点标题",
      summary: "节点摘要",
      suggestions: Array.from({ length: 9 }, (_, index) => ({
        label: `概念 ${index + 1}`,
        reason: "继续学习",
        priority: index + 1,
        difficulty: index % 2 === 0 ? "advanced" : "unexpected",
        relation: "child",
      })),
    });

    const extraction = parseExtraction(`prefix\n${text}\nsuffix`);

    expect(extraction?.title).toBe("节点标题");
    expect(extraction?.summary).toBe("节点摘要");
    expect(extraction?.suggestions).toHaveLength(7);
    expect(extraction?.suggestions[0].difficulty).toBe("advanced");
    expect(extraction?.suggestions[1].difficulty).toBe("beginner");
  });

  it("falls back to deterministic labels when extraction JSON is unavailable", () => {
    const extraction = fallbackExtraction("第一层解释。第二层路径。第三层例子。", "用户问题");

    expect(extraction.title).toBe("用户问题");
    expect(extraction.summary).toContain("第一层解释");
    expect(extraction.suggestions.length).toBeGreaterThan(0);
  });
});
