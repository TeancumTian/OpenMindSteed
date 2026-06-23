import { createInitialState } from "../domain/sampleData";
import type { MindSteedState } from "../domain/types";
import { isTauriRuntime, loadStateFromTauri, saveStateToTauri } from "../tauri/bridge";
import { normalizeState } from "../domain/normalize";

const storageKey = "openmindsteed.state.v1";

export function loadStateFromBrowser(): MindSteedState {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return createInitialState();
    return normalizeState(JSON.parse(stored));
  } catch {
    return createInitialState();
  }
}

export function saveStateToBrowser(state: MindSteedState): void {
  localStorage.setItem(storageKey, JSON.stringify(redactSecrets(state)));
}

export async function loadPersistedState(): Promise<MindSteedState | null> {
  if (!isTauriRuntime()) return null;
  const state = await loadStateFromTauri();
  return state ? normalizeState(state) : null;
}

export async function savePersistedState(state: MindSteedState): Promise<void> {
  const durableState = redactSecrets(state);
  saveStateToBrowser(durableState);
  if (isTauriRuntime()) {
    await saveStateToTauri(durableState);
  }
}

export { storageKey };

export interface MindSteedBackupPayload {
  app: "OpenMindSteed";
  version: 1;
  exportedAt: string;
  state: MindSteedState;
}

export function createBackupPayload(
  state: MindSteedState,
  exportedAt = new Date(),
): MindSteedBackupPayload {
  return {
    app: "OpenMindSteed",
    version: 1,
    exportedAt: exportedAt.toISOString(),
    state: redactSecrets(state),
  };
}

export function stateFromBackupPayload(value: unknown): MindSteedState {
  const candidate =
    value && typeof value === "object" && "state" in value && (value as { state?: unknown }).state
      ? (value as { state: unknown }).state
      : value;
  return redactSecrets(normalizeState(candidate));
}

export function redactSecrets(state: MindSteedState): MindSteedState {
  return {
    ...state,
    settings: {
      ...state.settings,
      provider: {
        ...state.settings.provider,
        apiKey: "",
      },
    },
  };
}
