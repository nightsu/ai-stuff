import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  auditProjectTypeScriptFieldDocs,
  auditTypeScriptFieldDocs,
} from "../../src/documentation/field-doc-audit.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("TypeScript field TSDoc audit", () => {
  it("rejects a project-owned type field without meaningful TSDoc", () => {
    const issues = auditTypeScriptFieldDocs({
      fileName: "negative-fixture.ts",
      sourceText: `
        interface BrokenProjection {
          runId: string;
        }
      `,
    });

    expect(issues).toEqual([
      {
        fileName: "negative-fixture.ts",
        fieldName: "runId",
        line: 3,
        reason: "missing-field-tsdoc",
      },
    ]);
  });

  it("rejects an undocumented project-owned class field", () => {
    const issues = auditTypeScriptFieldDocs({
      fileName: "class-negative-fixture.ts",
      sourceText: `
        class BrokenStore {
          readonly database = "runtime.sqlite";
        }
      `,
    });

    expect(issues).toEqual([
      {
        fileName: "class-negative-fixture.ts",
        fieldName: "database",
        line: 3,
        reason: "missing-field-tsdoc",
      },
    ]);
  });

  it("accepts a field whose TSDoc explains its domain meaning", () => {
    expect(
      auditTypeScriptFieldDocs({
        fileName: "documented.ts",
        sourceText: `
          interface RunIdentity {
            /** 跨进程稳定的 Research Run identity。 */
            runId: string;
          }
        `,
      }),
    ).toEqual([]);
  });

  it("keeps every project-owned TypeScript type field documented", async () => {
    expect(await auditProjectTypeScriptFieldDocs(projectRoot)).toEqual([]);
  });
});
