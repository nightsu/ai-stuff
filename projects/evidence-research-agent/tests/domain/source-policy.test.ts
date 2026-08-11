import { describe, expect, it } from "vitest";

import { sourcePathPolicyDenial } from "../../src/domain/source-policy.js";
import type { SourceScope } from "../../src/domain/types.js";

const scope: SourceScope = {
  roots: [
    {
      canonicalPath: "/private/approved-source",
      device: "1",
      inode: "2",
    },
  ],
  exclusions: ["blocked/**"],
  allowedExtensions: [".md"],
  maxFileBytes: 4_096,
  maxTotalBytes: 8_192,
};

describe("source path policy", () => {
  it("returns one exact denial using exclusion, secret, then extension priority", () => {
    expect(sourcePathPolicyDenial("blocked/secret.pem", scope)).toBe(
      "excluded_path",
    );
    expect(sourcePathPolicyDenial("visible/.env", scope)).toBe("secret_path");
    expect(sourcePathPolicyDenial("visible/plain.txt", scope)).toBe(
      "extension_not_allowed",
    );
    expect(sourcePathPolicyDenial("visible/approved.md", scope)).toBeUndefined();
  });

  it("fails closed when the supplied path is not normalized", () => {
    expect(sourcePathPolicyDenial("visible/../approved.md", scope)).toBe(
      "invalid_path",
    );
  });
});
