import { describe, expect, it } from "vitest";

import {
  createPlanApprovalBinding,
  hashCanonicalJson,
} from "../../src/domain/integrity.js";

describe("approval integrity", () => {
  it("hashes recursively key-sorted JSON deterministically", () => {
    const left = {
      b: 2,
      nested: { z: 1, a: [{ y: true, x: "value" }] },
      a: 1,
    };
    const right = {
      nested: { a: [{ x: "value", y: true }], z: 1 },
      a: 1,
      b: 2,
    };

    expect(hashCanonicalJson(left)).toBe(
      "25176dce386345c9f6fd8a0103162f93f1ff68166f3e5ef7c7a94f63c2d9490a",
    );
    expect(hashCanonicalJson(right)).toBe(hashCanonicalJson(left));
  });

  it("keeps integer-like object keys in lexicographic order", () => {
    expect(hashCanonicalJson({ 10: "ten", 2: "two" })).toBe(
      "b71e124675fc80e7314688bffdb68e83515851fb51474125db9a0c4c8aca3808",
    );
  });

  it("binds the exact question, plan, Source Scope, and budget version", () => {
    expect(
      createPlanApprovalBinding({
        question: "How does approval binding work?",
        planHash:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sourceScope: {
          maxTotalBytes: 2_000_000,
          roots: ["/tmp/sources"],
          allowedExtensions: [".ts", ".md"],
          exclusions: ["**/node_modules/**"],
          maxFileBytes: 256_000,
        },
        runBudget: {
          maxToolCalls: 24,
          version: "budget-v1",
          maxWallTimeMs: 300_000,
          maxSourceBytes: 2_000_000,
          maxDistinctSources: 12,
          maxModelTurns: 8,
        },
      }),
    ).toEqual({
      questionHash:
        "d98a6997bf7cc6c081c6efd1b0c5b671f25e52ba4d6b3006e64fda3bf3b5fdc6",
      planHash:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sourceScopeHash:
        "564195c62dafa64798ee3b68655938a39b5b754ea0b9cf1d03fecdc7c809dfdd",
      budgetVersion: "budget-v1",
      budgetHash:
        "5435023e0e4fa9e60d09d0652b2e942eaf6850dd8424ac1a31b66828007ecb98",
      bindingHash:
        "95daa8be65be86da77ca4f8b2060d34777307607f659e6ac37ed5b34ca20709a",
    });
  });
});
