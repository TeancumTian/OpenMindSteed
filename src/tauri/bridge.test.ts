import { afterEach, describe, expect, it } from "vitest";
import { invokeTauri, isTauriRuntime } from "./bridge";

declare global {
  // Tauri v2 exposes this runtime marker for @tauri-apps/api/core.isTauri().
  // The package does not add it to the TypeScript global namespace.
  var isTauri: boolean | undefined;
}

afterEach(() => {
  delete window.__TAURI__;
  delete globalThis.isTauri;
});

describe("Tauri bridge runtime detection", () => {
  it("recognizes the Tauri v2 runtime marker", () => {
    globalThis.isTauri = true;

    expect(isTauriRuntime()).toBe(true);
  });

  it("uses the global invoke fallback when available", async () => {
    window.__TAURI__ = {
      core: {
        invoke: async <T>(command: string, args?: Record<string, unknown>) =>
          ({ command, args }) as T,
      },
    };

    await expect(invokeTauri("ping", { value: 1 })).resolves.toEqual({
      command: "ping",
      args: { value: 1 },
    });
  });

  it("returns false when neither Tauri runtime path exists", () => {
    expect(isTauriRuntime()).toBe(false);
  });
});
