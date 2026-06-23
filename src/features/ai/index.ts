import type { MindSteedAIProvider } from "./provider";
import { codexLocalProvider } from "./codexLocalProvider";
import { mockProvider } from "./mockProvider";
import { openAICompatibleProvider } from "./openAICompatibleProvider";
import type { ProviderKind } from "../../domain/types";

const providers: Record<ProviderKind, MindSteedAIProvider> = {
  mock: mockProvider,
  byok: openAICompatibleProvider,
  "codex-local": codexLocalProvider,
};

export function providerFor(kind: ProviderKind): MindSteedAIProvider {
  return providers[kind] ?? mockProvider;
}

export type { MindSteedAIProvider } from "./provider";
