// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import mermaid from "mermaid";
import { expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

it("parses every architecture Mermaid block", async () => {
  const diagrams = extractMermaidDiagrams(await readArchitecture());

  expect(diagrams).toHaveLength(2);
  for (const diagram of diagrams) {
    await expect(mermaid.parse(diagram)).resolves.toBeTruthy();
  }
});

it("documents the private source snapshot flow without leaving researching", async () => {
  const markdown = await readArchitecture();
  const stateDiagram = extractMermaidDiagrams(markdown).find((diagram) =>
    /^stateDiagram-v2\b/m.test(diagram),
  );
  expect(stateDiagram).toBeDefined();
  if (stateDiagram === undefined) {
    throw new Error("architecture 缺少 stateDiagram-v2");
  }

  expect(markdown).toContain("Runtime --> Policy");
  expect(markdown).toContain(
    'Policy -->|"approved explicit read"| Reader',
  );
  expect(markdown).toContain("Reader --> Snapshot");
  expect(markdown).toContain("Snapshot --> Registry");
  expect(markdown).toContain("Registry --> Journal");
  expect(markdown).toContain(
    'Policy -->|"denied or failed<br/>no snapshot"| Journal',
  );
  expect(markdown).toContain("Journal --> Projection");
  expect(markdown).toContain("Journal --> Trace");
  expect(stateDiagram).toMatch(
    /^\s*researching\s*-->\s*researching\s*:\s*source_read_observed\s*$/m,
  );
  expect(stateDiagram).not.toMatch(
    /^\s*researching\s*-->\s*completed(?:\s*:\s*.*)?\s*$/im,
  );
  expect(stateDiagram).not.toMatch(/\bsearch_sources\b/i);

  const stateEdges = stateDiagram
    .split("\n")
    .filter((line) => /-->/.test(line))
    .join("\n");
  expect(stateEdges).not.toMatch(/\b(?:model|research[\s_-]*loop)\b/i);
});

async function readArchitecture(): Promise<string> {
  return readFile(resolve(projectRoot, "docs/architecture.md"), "utf8");
}

function extractMermaidDiagrams(markdown: string): string[] {
  return [
    ...markdown.matchAll(/```mermaid[^\S\r\n]*\r?\n([\s\S]*?)```/g),
  ].map((match) => match[1]?.trim() ?? "");
}
