import { describe, expect, it } from "vitest";
import { createInitialState } from "../domain/sampleData";
import { createBackupPayload, stateFromBackupPayload } from "./persistence";

describe("backup persistence", () => {
  it("exports a versioned backup without provider secrets", () => {
    const state = createInitialState();
    state.settings.provider.apiKey = "sk-test";

    const backup = createBackupPayload(state, new Date("2026-06-23T18:20:00.000Z"));

    expect(backup.app).toBe("OpenMindSteed");
    expect(backup.version).toBe(1);
    expect(backup.exportedAt).toBe("2026-06-23T18:20:00.000Z");
    expect(backup.state.settings.provider.apiKey).toBe("");
  });

  it("imports a backup envelope through normalization and redacts secrets", () => {
    const state = createInitialState();
    state.settings.provider.apiKey = "sk-test";
    const legacy = {
      app: "OpenMindSteed",
      version: 1,
      exportedAt: "2026-06-23T18:20:00.000Z",
      state: {
        ...state,
        codexThreads: undefined,
      },
    };

    const imported = stateFromBackupPayload(legacy);

    expect(imported.nodes).toHaveLength(state.nodes.length);
    expect(imported.codexThreads).toEqual([]);
    expect(imported.settings.provider.apiKey).toBe("");
  });

  it("also accepts a raw persisted state JSON", () => {
    const state = createInitialState();

    const imported = stateFromBackupPayload(state);

    expect(imported.selectedNodeId).toBe(state.selectedNodeId);
    expect(imported.nodes).toHaveLength(state.nodes.length);
  });
});
