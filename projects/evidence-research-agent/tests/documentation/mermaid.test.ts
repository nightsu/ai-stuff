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

it("documents the bounded Research Loop and its publication handoff", async () => {
  const markdown = await readArchitecture();
  const stateDiagram = extractMermaidDiagrams(markdown).find((diagram) =>
    /^stateDiagram-v2\b/m.test(diagram),
  );
  expect(stateDiagram).toBeDefined();
  if (stateDiagram === undefined) {
    throw new Error("architecture 缺少 stateDiagram-v2");
  }

  expect(markdown).toContain("Runtime --> Harness");
  expect(markdown).toContain("Harness <--> Journal");
  expect(markdown).toContain("Journal --> Projection");
  expect(markdown).toContain("Projection --> View");
  expect(markdown).toContain("View --> Model");
  expect(markdown).toContain("Model --> AiSdk");
  expect(markdown).toContain("AiSdk --> Provider");
  expect(markdown).toContain("Model --> Loop");
  expect(markdown).toContain("Loop --> Scheduler");
  expect(markdown).toContain("Scheduler --> Search");
  expect(markdown).toContain("Scheduler --> Read");
  expect(markdown).toContain("Scheduler --> RecordEvidence");
  expect(markdown).toContain("Scheduler --> ProposeClaim");
  expect(markdown).toContain("Scheduler --> CompleteResearch");
  expect(markdown).toContain('Search["search_sources"]');
  expect(markdown).toContain('Read["read_source"]');
  expect(markdown).toContain('RecordEvidence["record_evidence"]');
  expect(markdown).toContain('ProposeClaim["propose_claim"]');
  expect(markdown).toContain('CompleteResearch["complete_research"]');
  expect(markdown).toContain("Journal --> Trace");
  expect(markdown).toContain("CompleteResearch --> Journal");
  expect(markdown).toContain("ResearchComplete --> Gate");
  expect(markdown).toContain("Gate --> Draft");
  expect(markdown).toContain("Draft --> Approval");
  expect(markdown).toContain("Approval --> Publisher");
  expect(markdown).toContain('Control["pause / resume / cancel<br/>extend-budget"]');
  expect(markdown).toContain("Control --> Journal");
  expect(markdown).toContain("Output Root");
  expect(stateDiagram).toMatch(
    /^\s*researching\s*-->\s*researching\s*:\s*model_turn_completed\s*$/m,
  );
  expect(stateDiagram).toMatch(
    /^\s*researching\s*-->\s*researching\s*:\s*research_tool_observed\s*$/m,
  );
  expect(stateDiagram).toMatch(
    /^\s*researching\s*-->\s*research_complete\s*:\s*research_completed\s*$/m,
  );
  expect(stateDiagram).toMatch(
    /^\s*researching\s*-->\s*budget_exhausted\s*:\s*run_budget_exhausted\s*$/m,
  );
  expect(stateDiagram).toMatch(
    /^\s*research_complete\s*-->\s*waiting_publication_approval\s*:\s*learning_artifact_draft_proposed\s*$/m,
  );
  expect(stateDiagram).toMatch(
    /^\s*waiting_publication_approval\s*-->\s*ready_to_publish\s*:\s*publication_approved\s*$/m,
  );
  expect(stateDiagram).toMatch(
    /^\s*ready_to_publish\s*-->\s*completed\s*:\s*learning_artifact_published\s*$/m,
  );
  expect(stateDiagram).toMatch(
    /^\s*researching\s*-->\s*user_paused\s*:\s*run_paused\s*$/m,
  );
  expect(stateDiagram).toMatch(
    /^\s*user_paused\s*-->\s*researching\s*:\s*run_resumed \(researching origin\)\s*$/m,
  );
  expect(stateDiagram).toMatch(
    /^\s*budget_exhausted\s*-->\s*research_complete\s*:\s*run_budget_extended \(completed origin\)\s*$/m,
  );
  expect(stateDiagram).toMatch(
    /^\s*waiting_publication_approval\s*-->\s*cancelled\s*:\s*run_cancelled\s*$/m,
  );
  expect(markdown).toContain("budget_exhausted");
  expect(markdown).toContain("research_complete");
  expect(markdown).toContain("completed`、`cancelled` 与 `failed` 是不可恢复 terminal states");
});

async function readArchitecture(): Promise<string> {
  return readFile(resolve(projectRoot, "docs/architecture.md"), "utf8");
}

function extractMermaidDiagrams(markdown: string): string[] {
  return [
    ...markdown.matchAll(/```mermaid[^\S\r\n]*\r?\n([\s\S]*?)```/g),
  ].map((match) => match[1]?.trim() ?? "");
}
