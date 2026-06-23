import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { managedEnd, managedStart } from "./export";

interface ExampleManifestEntry {
  relativePath: string;
  status: string;
}

interface ExampleManifest {
  version: number;
  treeCount: number;
  nodeCount: number;
  entries: ExampleManifestEntry[];
}

const exampleVaultRoot = join(process.cwd(), "docs", "example-vault");

function listMarkdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listMarkdownFiles(path);
    return path.endsWith(".md") ? [path] : [];
  });
}

describe("example Obsidian vault", () => {
  it("contains safe active manifest paths that exist in the example vault", () => {
    const manifest = JSON.parse(
      readFileSync(join(exampleVaultRoot, ".mindsteed-sync.json"), "utf8"),
    ) as ExampleManifest;

    expect(manifest.version).toBe(1);
    expect(manifest.treeCount).toBe(1);
    expect(manifest.nodeCount).toBe(3);

    for (const entry of manifest.entries.filter((item) => item.status === "active")) {
      expect(entry.relativePath.startsWith("/")).toBe(false);
      expect(entry.relativePath.includes("..")).toBe(false);
      expect(existsSync(join(exampleVaultRoot, entry.relativePath))).toBe(true);
    }
  });

  it("keeps generated Markdown inside managed blocks and user notes outside them", () => {
    const markdownFiles = listMarkdownFiles(exampleVaultRoot);

    expect(markdownFiles.length).toBeGreaterThanOrEqual(5);
    for (const file of markdownFiles) {
      const contents = readFileSync(file, "utf8");
      expect(contents).toContain(managedStart);
      expect(contents).toContain(managedEnd);
      expect(contents).toContain("## My Notes");
      expect(contents.indexOf(managedStart)).toBeLessThan(contents.indexOf(managedEnd));
      expect(contents.indexOf(managedEnd)).toBeLessThan(contents.indexOf("## My Notes"));
    }
  });
});
