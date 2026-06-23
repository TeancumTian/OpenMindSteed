import type {
  APISuggestion,
  ChatStreamRequest,
  GeneratedImage,
  ProviderSettings,
} from "../../domain/types";

export interface ProviderCapabilities {
  streaming: boolean;
  webSearch: boolean;
  imageGeneration: boolean;
  visionInput: boolean;
  localAuth: boolean;
}

export interface AIStreamHandlers {
  onMessageDelta(text: string): void;
  onMessageDone(text: string): void;
  onTitleDone(title: string): void;
  onSummaryDone(summary: string): void;
  onSuggestionsDone(suggestions: APISuggestion[]): void;
  onImageDone?(image: GeneratedImage): void;
  onImageError?(message: string): void;
  onProviderMetadata?(metadata: Record<string, string>): void;
  onError(message: string): void;
}

export interface MindSteedAIProvider {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  streamChat(
    request: ChatStreamRequest,
    handlers: AIStreamHandlers,
    settings: ProviderSettings,
    signal?: AbortSignal,
  ): Promise<void>;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}
