import { describe, expect, it } from "vitest";
import { createInitialState } from "./sampleData";
import { normalizeState } from "./normalize";
import { redactSecrets } from "../state/persistence";

describe("state normalization", () => {
  it("adds codex thread mapping storage to older persisted states", () => {
    const state = createInitialState();
    const legacy = { ...state };
    delete (legacy as Partial<typeof state>).codexThreads;
    delete (legacy.settings.provider as Partial<typeof state.settings.provider>).providerPreset;

    const normalized = normalizeState(legacy);

    expect(normalized.codexThreads).toEqual([]);
    expect(normalized.settings.provider.providerPreset).toBe("custom");
    expect(normalized.nodes).toHaveLength(state.nodes.length);
  });

  it("rejects unknown provider preset ids from persisted state", () => {
    const state = createInitialState();
    state.settings.provider.providerPreset = "deepseek";
    const unsafe = {
      ...state,
      settings: {
        ...state.settings,
        provider: {
          ...state.settings.provider,
          providerPreset: "not-real",
        },
      },
    };

    const normalized = normalizeState(unsafe);

    expect(normalized.settings.provider.providerPreset).toBe("custom");
  });

  it("redacts provider API keys before durable persistence", () => {
    const state = createInitialState();
    state.settings.provider.apiKey = "secret";

    const redacted = redactSecrets(state);

    expect(redacted.settings.provider.apiKey).toBe("");
    expect(state.settings.provider.apiKey).toBe("secret");
  });
});
