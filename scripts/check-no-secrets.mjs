#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const ignoredPathParts = new Set([
  ".git",
  ".vite",
  "node_modules",
  "dist",
  "dist-ssr",
  "coverage",
  "playwright-report",
  "test-results",
  "target",
  "gen",
  "codex-generated",
  "var",
]);

const textExtensions = new Set([
  "",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".rs",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const forbiddenFileNames = [
  /^\.env(?:\.|$)/u,
  /^auth\.json$/u,
  /(?:^|[._-])secret(?:[._-]|$)/iu,
  /(?:^|[._-])token(?:[._-]|$)/iu,
];

const forbiddenExtensions = new Set([".key", ".pem", ".p12", ".mobileprovision"]);

const allowlistedFiles = new Set([
  "SECURITY.md",
  "docs/release.md",
  ".github/workflows/release.yml",
]);

const rules = [
  {
    name: "private-key-block",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u,
    message: "private key material must not be committed",
  },
  {
    name: "codex-access-token-assignment",
    pattern: /\bCODEX_ACCESS_TOKEN\s*=\s*["']?(?!["'\s<])[A-Za-z0-9._-]{12,}/u,
    message: "non-empty CODEX_ACCESS_TOKEN assignment must not be committed",
  },
  {
    name: "openai-api-key",
    pattern: /\bsk-(?!test\b)[A-Za-z0-9_-]{20,}\b/u,
    message: "provider API keys must not be committed",
  },
  {
    name: "anthropic-api-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/u,
    message: "provider API keys must not be committed",
  },
  {
    name: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
    message: "GitHub tokens must not be committed",
  },
];

function gitCandidateFiles() {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: root,
      encoding: "buffer",
    },
  );
  if (result.status !== 0) return null;
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((path) => !isIgnoredPath(path));
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const relPath = relative(root, fullPath);
    if (isIgnoredPath(relPath)) continue;
    const stat = lstatSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (stat.isFile()) {
      files.push(relPath.split(sep).join("/"));
    }
  }
  return files;
}

function isIgnoredPath(path) {
  return path.split(/[\\/]/u).some((part) => ignoredPathParts.has(part));
}

function isTextFile(path) {
  return textExtensions.has(extname(path).toLowerCase());
}

function lineAndColumn(text, index) {
  const before = text.slice(0, index);
  const lines = before.split("\n");
  return {
    line: lines.length,
    column: lines.at(-1).length + 1,
  };
}

const files = gitCandidateFiles() ?? walk(root);
const findings = [];

for (const path of files) {
  const fileName = path.split("/").at(-1) ?? path;
  const extension = extname(path).toLowerCase();

  if (!allowlistedFiles.has(path)) {
    if (
      forbiddenExtensions.has(extension) ||
      forbiddenFileNames.some((rule) => rule.test(fileName))
    ) {
      findings.push({
        path,
        rule: "sensitive-file-name",
        message: "sensitive credential-like files must not be committed",
      });
      continue;
    }
  }

  if (!isTextFile(path)) continue;
  const fullPath = resolve(root, path);
  if (!existsSync(fullPath)) continue;
  const text = readFileSync(fullPath, "utf8");
  for (const rule of rules) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    const location = lineAndColumn(text, match.index);
    findings.push({
      path,
      line: location.line,
      column: location.column,
      rule: rule.name,
      message: rule.message,
    });
  }
}

if (findings.length > 0) {
  console.error("Secret scan failed:");
  for (const finding of findings) {
    const location = finding.line ? `:${finding.line}:${finding.column}` : "";
    console.error(`- ${finding.path}${location} [${finding.rule}] ${finding.message}`);
  }
  process.exit(1);
}

console.log(`Secret scan passed (${files.length} candidate files checked).`);
