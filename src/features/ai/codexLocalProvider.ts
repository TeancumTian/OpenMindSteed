import type { MindSteedAIProvider } from "./provider";
import {
  cancelCodexLocalTurn,
  codexDeltaEvent,
  codexStatusEvent,
  codexThreadEvent,
  invokeTauri,
  isTauriRuntime,
  listenTauriEvent,
} from "../../tauri/bridge";

export const codexLocalProvider: MindSteedAIProvider = {
  id: "codex-local",
  displayName: "Codex Local",
  capabilities: {
    streaming: true,
    webSearch: false,
    imageGeneration: false,
    visionInput: false,
    localAuth: true,
  },
  async streamChat(request, handlers, settings, signal) {
    if (!isTauriRuntime()) {
      const message =
        "Codex Local 需要在 Tauri 桌面环境中运行。当前 Web 预览不会读取 Codex token，也不会启动 app-server。";
      handlers.onError(message);
      throw new Error(message);
    }

    const requestId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    let streamed = false;
    const abortCodexTurn = () => {
      void cancelCodexLocalTurn(requestId);
    };
    signal?.addEventListener("abort", abortCodexTurn, { once: true });
    const unlistenDelta = await listenTauriEvent<{ requestId: string; delta: string }>(
      codexDeltaEvent,
      (event) => {
        if (event.requestId !== requestId) return;
        streamed = true;
        handlers.onMessageDelta(event.delta);
      },
    );
    const unlistenThread = await listenTauriEvent<{
      requestId: string;
      threadId: string;
      threadStatus?: string;
      resumeError?: string | null;
    }>(codexThreadEvent, (event) => {
      if (event.requestId !== requestId) return;
      handlers.onProviderMetadata?.({
        codexThreadId: event.threadId,
        codexThreadStatus: event.threadStatus ?? "",
        codexThreadResumeError: event.resumeError ?? "",
      });
    });
    const unlistenStatus = await listenTauriEvent<{
      requestId: string;
      status: string;
      kind: string;
      label?: string;
      severity?: string;
    }>(codexStatusEvent, (event) => {
      if (event.requestId !== requestId) return;
      handlers.onProviderMetadata?.({
        codexStatus: event.status,
        codexStatusKind: event.kind,
        codexStatusLabel: event.label ?? "",
        codexStatusSeverity: event.severity ?? "",
      });
    });

    try {
      const result = await invokeTauri<{
        answer: string;
        title: string;
        summary: string;
        codexThreadId: string;
        codexThreadStatus?: string;
        codexThreadResumeError?: string | null;
        suggestions: Array<{
          label: string;
          reason: string;
          priority: number;
          difficulty: "beginner" | "intermediate" | "advanced";
          relation: string;
        }>;
      }>("codex_local_turn", {
        payload: {
          requestId,
          request,
          codexThreadId: request.codexThreadId,
          codexBin: settings.codexBin,
        },
      });

      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      if (!streamed) {
        handlers.onMessageDelta(result.answer);
      }
      handlers.onMessageDone(result.answer);
      handlers.onProviderMetadata?.({
        codexThreadId: result.codexThreadId,
        codexThreadStatus: result.codexThreadStatus ?? "",
        codexThreadResumeError: result.codexThreadResumeError ?? "",
      });
      handlers.onTitleDone(result.title);
      handlers.onSummaryDone(result.summary);
      handlers.onSuggestionsDone(result.suggestions);
    } finally {
      signal?.removeEventListener("abort", abortCodexTurn);
      unlistenDelta();
      unlistenThread();
      unlistenStatus();
    }
  },
};
