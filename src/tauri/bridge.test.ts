import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeTauri, isTauriRuntime, listenTauriEvent } from "./bridge";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => {
    throw new Error("listen blocked");
  }),
}));

declare global {
  // Tauri v2 exposes this runtime marker for @tauri-apps/api/core.isTauri().
  // The package does not add it to the TypeScript global namespace.
  var isTauri: boolean | undefined;
}

afterEach(() => {
  delete window.__TAURI__;
  delete globalThis.isTauri;
  vi.clearAllMocks();
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

  it("continues without streaming when event listener registration fails", async () => {
    globalThis.isTauri = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const unlisten = await listenTauriEvent("codex-local://delta", () => undefined);

      expect(unlisten()).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("continuing without streaming events"),
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
