import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ResearchAgentRuntime, ScriptedModel } from "../../src/index.js";
import type {
  ModelPort,
  PlanRequest,
  ResearchPlan,
} from "../../src/index.js";
import { hashCanonicalJson } from "../../src/domain/integrity.js";
import { sourceScopeSchema } from "../../src/domain/schemas.js";
import { PrivateSourceAccess } from "../../src/infrastructure/private-source-access.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("Source Scope root canonicalization", () => {
  it("persists and models the canonical root target with decimal device and inode identity", async () => {
    const fixture = await createFixture();
    const requests: PlanRequest[] = [];
    const model: ModelPort = {
      proposePlan: (request) => {
        requests.push(request);
        return Promise.resolve(plan);
      },
    };
    const runtime = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      model,
    });

    try {
      const requestedScope = sourceScopeRequest([fixture.sourceRoot]);
      const created = await runtime.createRun({
        question: "canonical Source Root 如何绑定审批？",
        sourceScope: requestedScope,
        runBudget,
      });
      const metadata = await lstat(fixture.sourceRoot, { bigint: true });
      const expectedRoot = {
        canonicalPath: await realpath(fixture.sourceRoot),
        device: metadata.dev.toString(10),
        inode: metadata.ino.toString(10),
      };

      expect(created.sourceScope.roots).toEqual([expectedRoot]);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.sourceScope).toEqual(created.sourceScope);
      expect(requestedScope.roots).toEqual([fixture.sourceRoot]);
      if (created.state.type !== "waiting_plan_approval") {
        throw new Error("测试要求 Run 等待计划审批");
      }
      expect(created.state.approvalBinding.sourceScopeHash).toBe(
        hashCanonicalJson(created.sourceScope),
      );
    } finally {
      runtime.close();
    }
  });

  it("rejects a root symlink at create without exposing filesystem details", async () => {
    const fixture = await createFixture();
    const linkedRoot = join(fixture.baseDirectory, "linked-source");
    await symlink(fixture.sourceRoot, linkedRoot, "dir");
    const runtime = openRuntime(fixture.runtimeHome);

    try {
      const creation = runtime.createRun({
        question: "root symlink 不得获得批准",
        sourceScope: sourceScopeRequest([linkedRoot]),
        runBudget,
      });
      await expect(creation).rejects.toMatchObject({
        name: "InvalidSourceScopeError",
        message: "Source Scope 无效或本地根不可用",
      });
      await expect(creation).rejects.not.toThrow(linkedRoot);
      await expect(creation).rejects.not.toThrow(fixture.sourceRoot);
    } finally {
      runtime.close();
    }
  });

  it.each([
    {
      name: "caller-forged root identity",
      roots: (fixture: Fixture) => [
        {
          canonicalPath: fixture.sourceRoot,
          device: "1",
          inode: "1",
        },
      ],
      allowedExtensions: [".md"],
    },
    {
      name: "uppercase allowed extension",
      roots: (fixture: Fixture) => [fixture.sourceRoot],
      allowedExtensions: [".MD"],
    },
    {
      name: "duplicate roots",
      roots: (fixture: Fixture) => [fixture.sourceRoot, fixture.sourceRoot],
      allowedExtensions: [".md"],
    },
    {
      name: "nested roots",
      roots: (fixture: Fixture) => [
        fixture.sourceRoot,
        join(fixture.sourceRoot, "nested"),
      ],
      allowedExtensions: [".md"],
    },
  ])("rejects $name before approval", async ({ roots, allowedExtensions }) => {
    const fixture = await createFixture();
    const runtime = openRuntime(fixture.runtimeHome);

    try {
      const creation = runtime.createRun({
        question: "invalid Source Scope 不得进入 Journal",
        sourceScope: {
          ...sourceScopeRequest([]),
          roots: roots(fixture),
          allowedExtensions,
        },
        runBudget,
      });
      await expect(creation).rejects.toMatchObject({
        name: "InvalidSourceScopeError",
        message: "Source Scope 无效或本地根不可用",
      });
      await expect(creation).rejects.not.toThrow(fixture.sourceRoot);
    } finally {
      runtime.close();
    }
  });

  it("rejects capture when an approved root path is replaced with a new directory", async () => {
    const fixture = await createFixture();
    const runtime = openRuntime(fixture.runtimeHome);
    const created = await runtime.createRun({
      question: "批准后替换 root 必须失效",
      sourceScope: sourceScopeRequest([fixture.sourceRoot]),
      runBudget,
    });
    runtime.close();

    const retiredRoot = join(fixture.baseDirectory, "retired-source");
    await rename(fixture.sourceRoot, retiredRoot);
    await mkdir(fixture.sourceRoot);
    await writeFile(join(fixture.sourceRoot, "replacement.md"), "replacement\n");

    const result = await new PrivateSourceAccess(created.sourceScope).capture(
      {
        rootIndex: 0,
        relativePath: "replacement.md",
        startLine: 1,
        endLine: 1,
      },
      2_000,
    );

    expect(result).toEqual({ status: "failed", code: "root_changed" });
    expect(JSON.stringify(result)).not.toContain(fixture.sourceRoot);
  });

  it("rejects capture when an approved root path becomes a retargeted symlink", async () => {
    const fixture = await createFixture();
    const runtime = openRuntime(fixture.runtimeHome);
    const created = await runtime.createRun({
      question: "批准后 symlink retarget 必须失效",
      sourceScope: sourceScopeRequest([fixture.sourceRoot]),
      runBudget,
    });
    runtime.close();

    const retiredRoot = join(fixture.baseDirectory, "retired-source");
    const attackerRoot = join(fixture.baseDirectory, "attacker-source");
    await rename(fixture.sourceRoot, retiredRoot);
    await mkdir(attackerRoot);
    await writeFile(join(attackerRoot, "replacement.md"), "replacement\n");
    await symlink(attackerRoot, fixture.sourceRoot, "dir");

    const result = await new PrivateSourceAccess(created.sourceScope).capture(
      {
        rootIndex: 0,
        relativePath: "replacement.md",
        startLine: 1,
        endLine: 1,
      },
      2_000,
    );

    expect(result).toEqual({ status: "failed", code: "root_changed" });
    expect(JSON.stringify(result)).not.toContain(attackerRoot);
  });

  it.each([
    ["device exponent", { device: "1e3", inode: "2" }],
    ["negative inode", { device: "1", inode: "-2" }],
    ["numeric device", { device: 1, inode: "2" }],
  ])("rejects non-decimal-string root identity for %s", (_name, identity) => {
    expect(
      sourceScopeSchema.safeParse({
        ...sourceScopeRequest([]),
        roots: [
          {
            canonicalPath: "/tmp/source",
            ...identity,
          },
        ],
      }).success,
    ).toBe(false);
  });
});

interface Fixture {
  /** 当前测试拥有并在结束后删除的临时父目录。 */
  readonly baseDirectory: string;
  /** 传给 Runtime 的私有状态目录。 */
  readonly runtimeHome: string;
  /** 调用方请求批准的真实非 symlink 源目录。 */
  readonly sourceRoot: string;
}

async function createFixture(): Promise<Fixture> {
  const baseDirectory = await mkdtemp(join(tmpdir(), "source-scope-root-"));
  temporaryDirectories.push(baseDirectory);
  const runtimeHome = join(baseDirectory, "runtime");
  const sourceRoot = join(baseDirectory, "source");
  await Promise.all([
    mkdir(runtimeHome),
    mkdir(join(sourceRoot, "nested"), { recursive: true }),
  ]);
  await writeFile(join(sourceRoot, "approved.md"), "approved\n");
  return { baseDirectory, runtimeHome, sourceRoot };
}

function openRuntime(runtimeHome: string): ResearchAgentRuntime {
  return ResearchAgentRuntime.open({
    runtimeHome,
    model: new ScriptedModel([plan]),
  });
}

function sourceScopeRequest(roots: readonly unknown[]) {
  return {
    roots,
    exclusions: ["**/.git/**"],
    allowedExtensions: [".md"],
    maxFileBytes: 256_000,
    maxTotalBytes: 2_000_000,
  };
}

const plan: ResearchPlan = {
  title: "绑定 canonical Source Root",
  objectives: ["让审批绑定稳定文件系统 identity"],
  steps: [{ id: "step-001", description: "验证 root identity" }],
};

const runBudget = {
  version: "budget-v1",
  maxModelTurns: 8,
  maxToolCalls: 24,
  maxDistinctSources: 12,
  maxSourceBytes: 2_000_000,
  maxWallTimeMs: 300_000,
} as const;
