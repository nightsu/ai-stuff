// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import mermaid from "mermaid";
import { expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

it("parses every architecture Mermaid block", async () => {
  const markdown = await readFile(
    resolve(projectRoot, "docs/architecture.md"),
    "utf8",
  );
  const diagrams = [...markdown.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(
    (match) => match[1]?.trim() ?? "",
  );

  expect(diagrams).toHaveLength(2);
  for (const diagram of diagrams) {
    await expect(mermaid.parse(diagram)).resolves.toBeTruthy();
  }
});
