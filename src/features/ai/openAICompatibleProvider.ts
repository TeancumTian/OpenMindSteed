import type { MindSteedAIProvider } from "./provider";
import { providerPresetById } from "./providerPresets";
import type { ChatStreamRequest, GeneratedImage, ProviderSettings } from "../../domain/types";
import {
  buildExtractionPrompt,
  buildTutorPrompt,
  fallbackExtraction,
  parseExtraction,
} from "./prompts";

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
  }>;
  web_search?: unknown;
  search_results?: unknown;
  search_info?: unknown;
}

interface ChatCompletionToolCall {
  id: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: ChatCompletionToolCall[];
    };
  }>;
}

interface SearchSource {
  title: string;
  url: string;
  snippet: string;
  site: string;
  publishedAt: string;
}

export const openAICompatibleProvider: MindSteedAIProvider = {
  id: "byok",
  displayName: "BYOK Direct",
  capabilities: {
    streaming: true,
    webSearch: true,
    imageGeneration: true,
    visionInput: false,
    localAuth: false,
  },
  async streamChat(request, handlers, settings, signal) {
    const configurationError = validateByokProviderSettings(settings);
    if (configurationError) {
      const message = configurationError;
      handlers.onError(message);
      throw new Error(message);
    }

    const endpoint = settings.endpoint.replace(/\/+$/u, "");
    const preset = providerPresetById(settings.providerPreset);
    if (request.tools?.webSearch && preset.webSearchAdapter === "kimi-builtin-web-search") {
      await streamKimiBuiltinWebSearch(
        endpoint,
        settings.apiKey,
        request,
        handlers,
        settings,
        signal,
      );
      return;
    }
    if (request.tools?.webSearch && preset.webSearchAdapter === "doubao-responses-web-search") {
      await streamDoubaoResponsesWebSearch(
        endpoint,
        settings.apiKey,
        request,
        handlers,
        settings,
        signal,
      );
      return;
    }

    const body = buildChatCompletionPayload(request, settings);
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok || !response.body) {
      const message = await providerResponseError("Provider", response);
      handlers.onError(message);
      throw new Error(message);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    const searchSources: SearchSource[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data) as ChatCompletionChunk;
          addSearchSources(searchSources, extractSearchSources(chunk));
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            fullText += delta;
            handlers.onMessageDelta(delta);
          }
        } catch {
          // Ignore provider keepalive or vendor-specific event lines.
        }
      }
    }

    const citations = formatSearchCitations(searchSources);
    if (citations) {
      fullText += citations;
      handlers.onMessageDelta(citations);
    }
    handlers.onMessageDone(fullText);
    await completeProviderResponse(endpoint, settings, request, fullText, handlers, signal);
  },
};

export function validateByokProviderSettings(settings: ProviderSettings): string | null {
  if (!settings.apiKey.trim()) {
    return "还没有配置 API Key。请在设置里填写 BYOK Provider 密钥。";
  }
  if (!settings.endpoint.trim()) {
    return "还没有配置 BYOK Endpoint。请在设置里选择 Provider preset 或填写 OpenAI-compatible endpoint。";
  }
  if (!isHttpEndpoint(settings.endpoint)) {
    return "BYOK Endpoint 不是有效的 HTTP(S) URL。请在设置里填写完整地址，例如 https://api.example.com/v1。";
  }
  if (!settings.model.trim()) {
    return "还没有配置模型名称。请在设置里选择 Provider preset 或填写 model。";
  }
  return null;
}

function isHttpEndpoint(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function buildChatCompletionPayload(request: ChatStreamRequest, settings: ProviderSettings) {
  const preset = providerPresetById(settings.providerPreset);
  const payload: Record<string, unknown> = {
    model: settings.model,
    stream: true,
    messages: [
      {
        role: "system",
        content: "你是 OpenMindSteed 的中文学习导师。回答要清晰、分层、可沉淀为知识树。",
      },
      {
        role: "user",
        content: buildTutorPrompt(request),
      },
    ],
  };

  if (!request.tools?.webSearch) {
    return payload;
  }

  if (preset.webSearchAdapter === "qwen-enable-search") {
    payload.enable_search = true;
    payload.search_options = {
      forced_search: true,
    };
  }

  if (preset.webSearchAdapter === "zai-web-search-tool") {
    payload.tools = [
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
    ];
  }

  if (preset.webSearchAdapter === "kimi-builtin-web-search") {
    payload.tools = [kimiWebSearchTool()];
    payload.thinking = { type: "disabled" };
  }

  return payload;
}

export function buildImageGenerationPayload(
  request: ChatStreamRequest,
  answer: string,
  settings: ProviderSettings,
) {
  const preset = providerPresetById(settings.providerPreset);
  if (preset.imageGenerationAdapter !== "zai-image-generations") return null;
  return {
    model: "glm-image",
    prompt: buildLearningImagePrompt(request, answer),
    size: request.tools?.imageGeneration?.size ?? "1280x1280",
    quality: request.tools?.imageGeneration?.quality ?? "standard",
  };
}

export function buildDoubaoResponsesPayload(
  request: ChatStreamRequest,
  settings: ProviderSettings,
) {
  return {
    model: settings.model,
    stream: true,
    tools: [
      {
        type: "web_search",
      },
    ],
    instructions: "你是 OpenMindSteed 的中文学习导师。回答要清晰、分层、可沉淀为知识树。",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: buildTutorPrompt(request),
          },
        ],
      },
    ],
  };
}

export function extractSearchSources(chunk: unknown): SearchSource[] {
  if (!chunk || typeof chunk !== "object") return [];
  const value = chunk as Record<string, unknown>;
  return [
    ...sourcesFromUnknown(value.web_search),
    ...sourcesFromUnknown(value.search_results),
    ...sourcesFromSearchInfo(value.search_info),
    ...sourcesFromUnknown(value.sources),
    ...sourcesFromUnknown(value.results),
    ...sourcesFromUnknown(value.annotations),
    ...extractSearchSources(value.item),
    ...extractSearchSources(value.response),
  ];
}

export function formatSearchCitations(sources: SearchSource[]) {
  const unique = dedupeSearchSources(sources).slice(0, 6);
  if (unique.length === 0) return "";
  const lines = unique.map((source, index) => {
    const label = source.title || source.site || source.url;
    const date = source.publishedAt ? ` · ${source.publishedAt}` : "";
    const snippet = source.snippet
      ? ` — ${source.snippet.replace(/\s+/gu, " ").slice(0, 140)}`
      : "";
    return `${index + 1}. [${label}](${source.url})${date}${snippet}`;
  });
  return `\n\n### 来源\n${lines.join("\n")}`;
}

function sourcesFromSearchInfo(value: unknown) {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [
    ...sourcesFromUnknown(record.search_results),
    ...sourcesFromUnknown(record.sources),
    ...sourcesFromUnknown(record.results),
  ];
}

function sourcesFromUnknown(value: unknown): SearchSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const url = stringFrom(record.link) || stringFrom(record.url);
    if (!url) return [];
    return [
      {
        title: stringFrom(record.title),
        url,
        snippet:
          stringFrom(record.content) || stringFrom(record.snippet) || stringFrom(record.summary),
        site: stringFrom(record.media) || stringFrom(record.site_name) || stringFrom(record.site),
        publishedAt:
          stringFrom(record.publish_date) ||
          stringFrom(record.published_at) ||
          stringFrom(record.date),
      },
    ];
  });
}

function addSearchSources(target: SearchSource[], incoming: SearchSource[]) {
  if (incoming.length === 0) return;
  target.push(...incoming);
}

function dedupeSearchSources(sources: SearchSource[]) {
  const seen = new Set<string>();
  const unique: SearchSource[] = [];
  for (const source of sources) {
    const key = source.url || source.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(source);
  }
  return unique;
}

function stringFrom(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

async function providerResponseError(label: string, response: Response) {
  const text = sanitizeProviderErrorText(await response.text());
  return text ? `${label} 返回 ${response.status}: ${text}` : `${label} 返回 ${response.status}`;
}

export function sanitizeProviderErrorText(value: string, limit = 900) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

async function completeProviderResponse(
  endpoint: string,
  settings: ProviderSettings,
  request: ChatStreamRequest,
  fullText: string,
  handlers: Parameters<MindSteedAIProvider["streamChat"]>[1],
  signal?: AbortSignal,
) {
  const extraction = await extractWithProvider(
    endpoint,
    settings.apiKey,
    settings.model,
    request,
    fullText,
    signal,
  );
  handlers.onTitleDone(extraction.title);
  handlers.onSummaryDone(extraction.summary);
  handlers.onSuggestionsDone(extraction.suggestions);

  if (request.tools?.generateImage) {
    try {
      const image = await generateImageWithProvider(
        endpoint,
        settings.apiKey,
        request,
        fullText,
        settings,
        signal,
      );
      if (image) {
        handlers.onImageDone?.(image);
      }
    } catch (error) {
      handlers.onImageError?.(error instanceof Error ? error.message : "Image generation failed");
    }
  }
}

async function streamKimiBuiltinWebSearch(
  endpoint: string,
  apiKey: string,
  request: ChatStreamRequest,
  handlers: Parameters<MindSteedAIProvider["streamChat"]>[1],
  settings: ProviderSettings,
  signal?: AbortSignal,
) {
  const messages: Array<Record<string, unknown>> = [
    {
      role: "system",
      content: "你是 OpenMindSteed 的中文学习导师。回答要清晰、分层、可沉淀为知识树。",
    },
    {
      role: "user",
      content: buildTutorPrompt(request),
    },
  ];
  const searchSources: SearchSource[] = [];
  let answer = "";

  for (let turn = 0; turn < 4; turn += 1) {
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        stream: false,
        messages,
        tools: [kimiWebSearchTool()],
        thinking: { type: "disabled" },
      }),
      signal,
    });

    if (!response.ok) {
      const message = await providerResponseError("Kimi web search", response);
      handlers.onError(message);
      throw new Error(message);
    }
    const data = (await response.json()) as ChatCompletionResponse;
    const choice = data.choices?.[0];
    const message = choice?.message;
    if (!choice || !message) {
      const error = "Kimi web search 没有返回可用回答。";
      handlers.onError(error);
      throw new Error(error);
    }

    if (choice.finish_reason === "tool_calls" && message.tool_calls?.length) {
      messages.push({
        role: "assistant",
        content: message.content ?? "",
        tool_calls: message.tool_calls,
        ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
      });
      for (const toolCall of message.tool_calls) {
        const name = toolCall.function?.name ?? "";
        const args = parseToolCallArguments(toolCall.function?.arguments ?? "{}");
        addSearchSources(searchSources, extractSearchSources(args));
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name,
          content: JSON.stringify(
            name === "$web_search" ? args : { error: `Unknown tool ${name}` },
          ),
        });
      }
      continue;
    }

    answer = message.content ?? "";
    break;
  }

  if (!answer.trim()) {
    const error = "Kimi web search completed without a final answer.";
    handlers.onError(error);
    throw new Error(error);
  }

  const fullText = `${answer}${formatSearchCitations(searchSources)}`;
  handlers.onMessageDelta(fullText);
  handlers.onMessageDone(fullText);
  await completeProviderResponse(endpoint, settings, request, fullText, handlers, signal);
}

async function streamDoubaoResponsesWebSearch(
  endpoint: string,
  apiKey: string,
  request: ChatStreamRequest,
  handlers: Parameters<MindSteedAIProvider["streamChat"]>[1],
  settings: ProviderSettings,
  signal?: AbortSignal,
) {
  const response = await fetch(`${endpoint}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(buildDoubaoResponsesPayload(request, settings)),
    signal,
  });

  if (!response.ok || !response.body) {
    const message = await providerResponseError("Doubao Responses web search", response);
    handlers.onError(message);
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  const searchSources: SearchSource[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      try {
        const event = JSON.parse(data) as Record<string, unknown>;
        addSearchSources(searchSources, extractSearchSources(event));
        const delta = responseOutputTextDelta(event);
        if (delta) {
          fullText += delta;
          handlers.onMessageDelta(delta);
        }
      } catch {
        // Ignore provider keepalive or vendor-specific event lines.
      }
    }
  }

  if (!fullText.trim()) {
    const error = "Doubao Responses web search completed without a final answer.";
    handlers.onError(error);
    throw new Error(error);
  }

  const citations = formatSearchCitations(searchSources);
  if (citations) {
    fullText += citations;
    handlers.onMessageDelta(citations);
  }
  handlers.onMessageDone(fullText);
  await completeProviderResponse(endpoint, settings, request, fullText, handlers, signal);
}

function responseOutputTextDelta(event: Record<string, unknown>) {
  if (event.type !== "response.output_text.delta") return "";
  return stringFrom(event.delta);
}

function kimiWebSearchTool() {
  return {
    type: "builtin_function",
    function: {
      name: "$web_search",
    },
  };
}

function parseToolCallArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

async function generateImageWithProvider(
  endpoint: string,
  apiKey: string,
  request: ChatStreamRequest,
  answer: string,
  settings: ProviderSettings,
  signal?: AbortSignal,
): Promise<GeneratedImage | null> {
  const payload = buildImageGenerationPayload(request, answer, settings);
  if (!payload) return null;
  const response = await fetch(`${endpoint}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    throw new Error(await providerResponseError("Image provider", response));
  }
  const data = (await response.json()) as {
    data?: Array<{ url?: string }>;
  };
  const url = data.data?.[0]?.url;
  if (!url) {
    throw new Error("Image provider 没有返回图片 URL。");
  }
  return {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    url,
    sourceUrl: url,
    mimeType: "image/png",
    prompt: payload.prompt,
    size: payload.size,
    quality: payload.quality,
  };
}

function buildLearningImagePrompt(request: ChatStreamRequest, answer: string) {
  return [
    "Create a clean, text-light learning illustration for a knowledge graph note.",
    "Style: precise editorial diagram, calm workstation aesthetic, high contrast, no UI chrome.",
    `Topic: ${request.node.title}`,
    request.node.summary ? `Node summary: ${request.node.summary}` : "",
    request.userMessage ? `Learner question: ${request.userMessage}` : "",
    answer ? `Tutor answer summary: ${answer.slice(0, 900)}` : "",
    "Avoid dense paragraphs and avoid rendering small text. Use visual metaphors, labeled shapes only if the text is short and legible.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function extractWithProvider(
  endpoint: string,
  apiKey: string,
  model: string,
  request: Parameters<MindSteedAIProvider["streamChat"]>[0],
  answer: string,
  signal?: AbortSignal,
) {
  try {
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        stream: false,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: buildExtractionPrompt(request, answer) }],
      }),
      signal,
    });
    if (!response.ok) return fallbackExtraction(answer, request.userMessage);
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    return parseExtraction(content) ?? fallbackExtraction(answer, request.userMessage);
  } catch {
    return fallbackExtraction(answer, request.userMessage);
  }
}
