import { createInitialState } from "./sampleData";
import type { MindSteedState, ProviderPresetId } from "./types";

const providerPresetIds = new Set<ProviderPresetId>([
  "custom",
  "deepseek",
  "qwen-global",
  "qwen-china",
  "zhipu",
  "kimi",
  "doubao",
]);

export function normalizeState(value: unknown): MindSteedState {
  const fallback = createInitialState();
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<MindSteedState>;
  return {
    ...fallback,
    ...candidate,
    nodes: Array.isArray(candidate.nodes) ? candidate.nodes : fallback.nodes,
    messages: Array.isArray(candidate.messages) ? candidate.messages : fallback.messages,
    suggestions: Array.isArray(candidate.suggestions)
      ? candidate.suggestions
      : fallback.suggestions,
    codexThreads: Array.isArray(candidate.codexThreads) ? candidate.codexThreads : [],
    streamingNodeIds: Array.isArray(candidate.streamingNodeIds) ? candidate.streamingNodeIds : [],
    settings: {
      ...fallback.settings,
      ...candidate.settings,
      provider: {
        ...fallback.settings.provider,
        ...candidate.settings?.provider,
        providerPreset: providerPresetIds.has(
          candidate.settings?.provider?.providerPreset as ProviderPresetId,
        )
          ? (candidate.settings?.provider?.providerPreset as ProviderPresetId)
          : fallback.settings.provider.providerPreset,
      },
      obsidian: {
        ...fallback.settings.obsidian,
        ...candidate.settings?.obsidian,
      },
    },
  };
}
