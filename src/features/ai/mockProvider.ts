import type { MindSteedAIProvider } from "./provider";
import { sleep } from "./provider";
import { fallbackExtraction, hasMeaningfulQuestion, truncate } from "./prompts";

export const mockProvider: MindSteedAIProvider = {
  id: "mock",
  displayName: "Mock Tutor",
  capabilities: {
    streaming: true,
    webSearch: false,
    imageGeneration: false,
    visionInput: false,
    localAuth: false,
  },
  async streamChat(request, handlers, _settings, signal) {
    const topic = request.node.title || "当前主题";
    const parentText = request.parent?.title ? `它和“${request.parent.title}”保持上下文关系。` : "";
    const question = hasMeaningfulQuestion(request.userMessage)
      ? request.userMessage
      : `请继续解释“${topic}”。`;
    const answer = [
      `关于“${topic}”，可以先把问题压缩成一句话：${truncate(question, 80)}`,
      "",
      `1. 核心定义：${topic} 是当前知识树里的一个学习节点，适合承载一个可继续追问的问题。`,
      `2. 学习路径：先弄清定义，再看例子，最后把容易混淆的概念拆成子节点。${parentText}`,
      "3. 下一步：选择一个推荐分支，或者直接在这里追问一个更具体的场景。",
    ].join("\n");

    let emitted = "";
    for (let index = 0; index < answer.length; index += 18) {
      const chunk = answer.slice(index, index + 18);
      emitted += chunk;
      handlers.onMessageDelta(chunk);
      await sleep(24, signal);
    }
    handlers.onMessageDone(emitted);

    const extraction = fallbackExtraction(emitted, question);
    handlers.onTitleDone(extraction.title);
    handlers.onSummaryDone(extraction.summary);
    handlers.onSuggestionsDone([
      {
        label: `${topic}的定义`,
        reason: "先把当前概念说清楚。",
        priority: 1,
        difficulty: "beginner",
        relation: "definition",
      },
      {
        label: "实际例子",
        reason: "用例子检验理解是否稳固。",
        priority: 2,
        difficulty: "beginner",
        relation: "example",
      },
      {
        label: "常见误区",
        reason: "把相近概念拆开，避免知识树变成一团。",
        priority: 3,
        difficulty: "intermediate",
        relation: "related",
      },
    ]);
  },
};
