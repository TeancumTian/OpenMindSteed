import type { ProviderPresetId, ProviderSettings } from "../../domain/types";

export interface ProviderPreset {
  id: ProviderPresetId;
  label: string;
  endpoint: string;
  defaultChatModel: string;
  webSearchSupport: "none" | "provider-specific";
  imageGenerationSupport: "none" | "provider-specific";
  requestShape:
    | "openai-chat-completions"
    | "qwen-chat-completions"
    | "zai-chat-completions"
    | "volcengine-ark-chat-completions";
  webSearchAdapter:
    | "none"
    | "qwen-enable-search"
    | "zai-web-search-tool"
    | "kimi-builtin-web-search"
    | "doubao-responses-web-search";
  imageGenerationAdapter: "none" | "zai-image-generations";
  jsonResponseSupport: boolean;
  docsUrl: string;
  note: string;
}

export const providerPresets: ProviderPreset[] = [
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    endpoint: "",
    defaultChatModel: "",
    webSearchSupport: "none",
    imageGenerationSupport: "none",
    requestShape: "openai-chat-completions",
    webSearchAdapter: "none",
    imageGenerationAdapter: "none",
    jsonResponseSupport: false,
    docsUrl: "",
    note: "Keep the current endpoint and model; use this for local gateways, proxies, or unlisted providers.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com",
    defaultChatModel: "deepseek-v4-flash",
    webSearchSupport: "none",
    imageGenerationSupport: "none",
    requestShape: "openai-chat-completions",
    webSearchAdapter: "none",
    imageGenerationAdapter: "none",
    jsonResponseSupport: true,
    docsUrl: "https://api-docs.deepseek.com/",
    note: "OpenAI-compatible chat endpoint. DeepSeek notes older deepseek-chat/reasoner aliases are scheduled for deprecation.",
  },
  {
    id: "qwen-global",
    label: "Qwen / DashScope Global",
    endpoint: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    defaultChatModel: "qwen-plus",
    webSearchSupport: "provider-specific",
    imageGenerationSupport: "none",
    requestShape: "qwen-chat-completions",
    webSearchAdapter: "qwen-enable-search",
    imageGenerationAdapter: "none",
    jsonResponseSupport: true,
    docsUrl:
      "https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope",
    note: "Singapore/global DashScope endpoint. API keys differ by region.",
  },
  {
    id: "qwen-china",
    label: "Qwen / DashScope China",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultChatModel: "qwen-plus",
    webSearchSupport: "provider-specific",
    imageGenerationSupport: "none",
    requestShape: "qwen-chat-completions",
    webSearchAdapter: "qwen-enable-search",
    imageGenerationAdapter: "none",
    jsonResponseSupport: true,
    docsUrl:
      "https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope",
    note: "China Beijing DashScope endpoint. Use the region that matches your API key.",
  },
  {
    id: "zhipu",
    label: "Z.AI / Zhipu GLM",
    endpoint: "https://api.z.ai/api/paas/v4",
    defaultChatModel: "glm-5.2",
    webSearchSupport: "provider-specific",
    imageGenerationSupport: "provider-specific",
    requestShape: "zai-chat-completions",
    webSearchAdapter: "zai-web-search-tool",
    imageGenerationAdapter: "zai-image-generations",
    jsonResponseSupport: true,
    docsUrl: "https://docs.z.ai/api-reference/introduction",
    note: "General Z.AI endpoint. GLM Coding Plan uses a separate coding endpoint and is not the default learning-chat path.",
  },
  {
    id: "kimi",
    label: "Kimi / Moonshot",
    endpoint: "https://api.moonshot.ai/v1",
    defaultChatModel: "kimi-k2.6",
    webSearchSupport: "provider-specific",
    imageGenerationSupport: "none",
    requestShape: "openai-chat-completions",
    webSearchAdapter: "kimi-builtin-web-search",
    imageGenerationAdapter: "none",
    jsonResponseSupport: true,
    docsUrl: "https://platform.kimi.ai/docs/api/overview",
    note: "Moonshot's global OpenAI-compatible endpoint. Kimi web search uses the built-in $web_search tool-call loop.",
  },
  {
    id: "doubao",
    label: "Doubao / Volcengine Ark",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3",
    defaultChatModel: "",
    webSearchSupport: "provider-specific",
    imageGenerationSupport: "provider-specific",
    requestShape: "volcengine-ark-chat-completions",
    webSearchAdapter: "doubao-responses-web-search",
    imageGenerationAdapter: "none",
    jsonResponseSupport: true,
    docsUrl: "https://www.volcengine.com/docs/82379/1330626",
    note: "Ark requires an enabled inference endpoint/model id in your Volcengine console. Web search uses the Ark Responses API.",
  },
];

export function providerPresetById(id: ProviderPresetId): ProviderPreset {
  return providerPresets.find((preset) => preset.id === id) ?? providerPresets[0];
}

export function applyProviderPreset(
  settings: ProviderSettings,
  presetId: ProviderPresetId,
): ProviderSettings {
  const preset = providerPresetById(presetId);
  if (preset.id === "custom") {
    return {
      ...settings,
      provider: "byok",
      providerPreset: "custom",
    };
  }

  return {
    ...settings,
    provider: "byok",
    providerPreset: preset.id,
    endpoint: preset.endpoint,
    model: preset.defaultChatModel || settings.model,
    webSearch: false,
    generateImage: false,
  };
}
