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

it("documents the Evidence-backed publication flow without introducing a research loop", async () => {
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
  expect(markdown).toContain("Registry --> Observation");
  expect(markdown).toContain(
    'Policy -->|"denied or failed<br/>no snapshot"| Observation',
  );
  expect(markdown).toContain("Journal --> Projection");
  expect(markdown).toContain("Journal --> Trace");
  expect(markdown).toContain("Observation --> Evidence");
  expect(markdown).toContain("Evidence --> Claim");
  expect(markdown).toContain("Claim --> Gate");
  expect(markdown).toContain("Gate --> Draft");
  expect(markdown).toContain("Draft --> Approval");
  expect(markdown).toContain("Approval --> Publisher");
  expect(markdown).toContain("Output Root");
  expect(stateDiagram).toMatch(
    /^\s*researching\s*-->\s*researching\s*:\s*source_read_observed\s*$/m,
  );
  expect(stateDiagram).toMatch(
    /^\s*researching\s*-->\s*researching\s*:\s*evidence_recorded\s*$/m,
  );
  expect(stateDiagram).toMatch(
    /^\s*researching\s*-->\s*researching\s*:\s*claim_recorded\s*$/m,
  );
  expect(stateDiagram).toMatch(
    /^\s*researching\s*-->\s*waiting_publication_approval\s*:\s*learning_artifact_draft_proposed\s*$/m,
  );
  expect(stateDiagram).toMatch(
    /^\s*waiting_publication_approval\s*-->\s*ready_to_publish\s*:\s*publication_approved\s*$/m,
  );
  expect(stateDiagram).toMatch(
    /^\s*ready_to_publish\s*-->\s*completed\s*:\s*learning_artifact_published\s*$/m,
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
