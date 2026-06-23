import type { GeneratedImage, MindSteedState, ObsidianSettings } from "../domain/types";
import type { ObsidianPackage } from "../features/obsidian/export";

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

declare global {
  interface Window {
    __TAURI__?: {
      core?: {
        invoke?: TauriInvoke;
      };
    };
  }
}

function invoke(): TauriInvoke | null {
  return window.__TAURI__?.core?.invoke ?? null;
}

export function isTauriRuntime(): boolean {
  return invoke() !== null;
}

export async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const tauriInvoke = invoke();
  if (!tauriInvoke) {
    throw new Error("Tauri runtime is not available.");
  }
  return tauriInvoke<T>(command, args);
}

export async function listenTauriEvent<T>(
  eventName: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(eventName, (event) => handler(event.payload));
}

export const codexDeltaEvent = "codex-local://delta";
export const codexThreadEvent = "codex-local://thread";
export const codexStatusEvent = "codex-local://status";

export async function cancelCodexLocalTurn(requestId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeTauri<void>("codex_local_cancel", {
    payload: {
      requestId,
    },
  });
}

export async function loadStateFromTauri(): Promise<MindSteedState | null> {
  if (!isTauriRuntime()) return null;
  return invokeTauri<MindSteedState | null>("load_state");
}

export async function saveStateToTauri(state: MindSteedState): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeTauri<void>("save_state", { state });
}

export async function loadSecret(key: string): Promise<string> {
  if (!isTauriRuntime()) return "";
  return invokeTauri<string>("load_secret", { key });
}

export async function saveSecret(key: string, value: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeTauri<void>("save_secret", { key, value });
}

export async function deleteSecret(key: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeTauri<void>("delete_secret", { key });
}

export async function pickDirectory(title: string): Promise<string | null> {
  if (!isTauriRuntime()) {
    throw new Error("Folder picker is available in the Tauri desktop app.");
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title,
    directory: true,
    multiple: false,
  });
  return typeof selected === "string" ? selected : null;
}

export interface CodexStatusResult {
  binary: string;
  version: string;
  loginStatus: string;
  loggedIn: boolean;
  appServerCompatible: boolean;
  compatibilityNote: string;
}

export async function checkCodexStatus(codexBin: string): Promise<CodexStatusResult> {
  return invokeTauri<CodexStatusResult>("codex_status", {
    payload: {
      codexBin,
    },
  });
}

export interface StoredGeneratedImageAsset {
  localPath: string;
  mimeType: string;
  byteLength: number;
}

export async function storeGeneratedImageAsset(image: GeneratedImage): Promise<GeneratedImage> {
  if (!isTauriRuntime()) return image;
  const stored = await invokeTauri<StoredGeneratedImageAsset>("store_generated_image_asset", {
    payload: {
      sourceUrl: image.sourceUrl ?? image.url,
      imageId: image.id,
      mimeType: image.mimeType,
    },
  });
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return {
    ...image,
    sourceUrl: image.sourceUrl ?? image.url,
    url: convertFileSrc(stored.localPath),
    localPath: stored.localPath,
    mimeType: stored.mimeType,
    byteLength: stored.byteLength,
    storedAt: new Date().toISOString(),
  };
}

export interface ObsidianSyncResult {
  rootDirectory: string;
  filesWritten: number;
  filesMovedToDeleted: number;
  manifestPath: string;
}

export async function syncObsidianPackage(
  obsidian: ObsidianSettings,
  packagePayload: ObsidianPackage,
): Promise<ObsidianSyncResult> {
  if (!obsidian.vaultPath.trim()) {
    throw new Error("还没有设置 Obsidian vault 路径。");
  }
  return invokeTauri<ObsidianSyncResult>("sync_obsidian_vault", {
    payload: {
      vaultPath: obsidian.vaultPath,
      packagePayload,
    },
  });
}
