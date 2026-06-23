import { describe, expect, it, vi } from "vitest";
import { createInitialState } from "../../domain/sampleData";
import type { ChatStreamRequest } from "../../domain/types";
import {
  buildChatCompletionPayload,
  buildDoubaoResponsesPayload,
  buildImageGenerationPayload,
  extractSearchSources,
  formatSearchCitations,
  openAICompatibleProvider,
  sanitizeProviderErrorText,
  validateByokProviderSettings,
} from "./openAICompatibleProvider";
import { applyProviderPreset, providerPresetById } from "./providerPresets";

const request: ChatStreamRequest = {
  node: { id: "node-a", title: "测试节点", summary: "" },
  recentMessages: [],
  userMessage: "今天有什么新进展？",
  intent: "follow_up",
  locale: "zh-CN",
  tools: { webSearch: true, generateImage: false },
  imageInputs: [],
};

describe("provider presets", () => {
  it("applies a BYOK provider preset while preserving secrets and local Codex path", () => {
    const settings = createInitialState().settings.provider;
    settings.apiKey = "sk-test";
    settings.codexBin = "/Applications/Codex.app/Contents/Resources/codex";

    const next = applyProviderPreset(settings, "deepseek");

    expect(next.provider).toBe("byok");
    expect(next.providerPreset).toBe("deepseek");
    expect(next.endpoint).toBe("https://api.deepseek.com");
    expect(next.model).toBe("deepseek-v4-flash");
    expect(next.apiKey).toBe("sk-test");
    expect(next.codexBin).toBe("/Applications/Codex.app/Contents/Resources/codex");
  });

  it("keeps current endpoint and model when switching back to custom", () => {
    const settings = applyProviderPreset(createInitialState().settings.provider, "qwen-global");

    const custom = applyProviderPreset(settings, "custom");

    expect(custom.providerPreset).toBe("custom");
    expect(custom.endpoint).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
    expect(custom.model).toBe("qwen-plus");
  });

  it("falls back to the custom preset for unknown persisted values", () => {
    expect(providerPresetById("unknown" as never).id).toBe("custom");
  });

  it("enables BYOK web search only through preset adapters", () => {
    expect(openAICompatibleProvider.capabilities.webSearch).toBe(true);
    expect(openAICompatibleProvider.capabilities.imageGeneration).toBe(true);

    expect(providerPresetById("qwen-global").webSearchAdapter).toBe("qwen-enable-search");
    expect(providerPresetById("zhipu").webSearchAdapter).toBe("zai-web-search-tool");
    expect(providerPresetById("kimi").webSearchAdapter).toBe("kimi-builtin-web-search");
    expect(providerPresetById("zhipu").imageGenerationAdapter).toBe("zai-image-generations");
    expect(providerPresetById("doubao").webSearchAdapter).toBe("doubao-responses-web-search");
  });

  it("validates actionable BYOK configuration errors before network requests", () => {
    const settings = applyProviderPreset(createInitialState().settings.provider, "deepseek");

    expect(validateByokProviderSettings(settings)).toContain("API Key");
    expect(
      validateByokProviderSettings({ ...settings, apiKey: "sk-test", endpoint: "" }),
    ).toContain("Endpoint");
    expect(
      validateByokProviderSettings({ ...settings, apiKey: "sk-test", endpoint: "api.example.com" }),
    ).toContain("HTTP(S) URL");
    expect(validateByokProviderSettings({ ...settings, apiKey: "sk-test", model: "" })).toContain(
      "模型名称",
    );
    expect(validateByokProviderSettings({ ...settings, apiKey: "sk-test" })).toBeNull();
  });

  it("reports missing BYOK API keys through the provider error handler", async () => {
    const settings = applyProviderPreset(createInitialState().settings.provider, "deepseek");
    const onError = vi.fn();

    await expect(
      openAICompatibleProvider.streamChat(
        request,
        {
          onMessageDelta: vi.fn(),
          onMessageDone: vi.fn(),
          onTitleDone: vi.fn(),
          onSummaryDone: vi.fn(),
          onSuggestionsDone: vi.fn(),
          onError,
        },
        settings,
      ),
    ).rejects.toThrow("API Key");

    expect(onError).toHaveBeenCalledWith(expect.stringContaining("API Key"));
  });

  it("trims and truncates provider error bodies", () => {
    const longError = ` first line\n${"x".repeat(20)} `;

    expect(sanitizeProviderErrorText(longError, 14)).toBe("first line xx…");
    expect(sanitizeProviderErrorText("   \n\t  ")).toBe("");
  });

  it("adds Qwen web search fields to chat completions payloads", () => {
    const settings = applyProviderPreset(createInitialState().settings.provider, "qwen-global");

    const payload = buildChatCompletionPayload(request, settings);

    expect(payload.enable_search).toBe(true);
    expect(payload.search_options).toEqual({ forced_search: true });
    expect(payload.tools).toBeUndefined();
  });

  it("adds Z.AI web search tool parameters to chat completions payloads", () => {
    const settings = applyProviderPreset(createInitialState().settings.provider, "zhipu");

    const payload = buildChatCompletionPayload(request, settings);

    expect(payload.tools).toEqual([
      {
        type: "web_search",
        web_search: {
          enable: "True",
          search_engine: "search-prime",
          search_result: "True",
          count: "5",
          search_recency_filter: "noLimit",
          content_size: "medium",
        },
      },
    ]);
  });

  it("adds Kimi builtin web search tool parameters to chat completions payloads", () => {
    const settings = applyProviderPreset(createInitialState().settings.provider, "kimi");

    const payload = buildChatCompletionPayload(request, settings);

    expect(settings.model).toBe("kimi-k2.6");
    expect(payload.tools).toEqual([
      {
        type: "builtin_function",
        function: {
          name: "$web_search",
        },
      },
    ]);
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("builds Doubao Responses web search payloads", () => {
    const settings = applyProviderPreset(createInitialState().settings.provider, "doubao");
    settings.model = "doubao-seed-1-6-250615";

    const payload = buildDoubaoResponsesPayload(request, settings);

    expect(payload).toMatchObject({
      model: "doubao-seed-1-6-250615",
      stream: true,
      tools: [{ type: "web_search" }],
    });
    expect(payload.input[0].content[0].type).toBe("input_text");
    expect(payload.input[0].content[0].text).toContain("今天有什么新进展？");
  });

  it("formats provider search citations from returned source payloads", () => {
    const sources = extractSearchSources({
      web_search: [
        {
          title: "Source A",
          link: "https://example.com/a",
          content: "A useful result.",
          media: "Example",
          publish_date: "2026-06-23",
        },
        {
          title: "Source A duplicate",
          link: "https://example.com/a",
          content: "Duplicate result.",
        },
      ],
    });

    expect(formatSearchCitations(sources)).toBe(
      "\n\n### 来源\n1. [Source A](https://example.com/a) · 2026-06-23 — A useful result.",
    );
  });

  it("builds Z.AI image generation payloads", () => {
    const settings = applyProviderPreset(createInitialState().settings.provider, "zhipu");

    const payload = buildImageGenerationPayload(
      {
        ...request,
        tools: {
          webSearch: false,
          generateImage: true,
          imageGeneration: { size: "1280x1280", quality: "standard" },
        },
      },
      "用几何结构解释核心概念。",
      settings,
    );

    expect(payload).toMatchObject({
      model: "glm-image",
      size: "1280x1280",
      quality: "standard",
    });
    expect(payload?.prompt).toContain("测试节点");
  });
});
