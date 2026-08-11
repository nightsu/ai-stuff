import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";

const runtimeHomes: string[] = [];

afterEach(async () => {
  await Promise.all(
    runtimeHomes.splice(0).map((runtimeHome) =>
      rm(runtimeHome, { force: true, recursive: true }),
    ),
  );
});

it("creates, inspects, and traces one Run through the thin CLI adapter", async () => {
  const runtimeHome = await mkdtemp(join(tmpdir(), "evidence-agent-cli-"));
  runtimeHomes.push(runtimeHome);
  const output: string[] = [];
  const errorOutput: string[] = [];
  const io = {
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => errorOutput.push(line),
  };

  expect(
    await runCli(
      [
        "run",
        "--runtime-home",
        runtimeHome,
        "--question",
        "Run Journal 和 Projection 有什么区别？",
        "--source-root",
        "/tmp/agent-learning-sources",
        "--json",
      ],
      io,
    ),
  ).toBe(0);
  const created = JSON.parse(output.pop() ?? "null") as {
    /** CLI 返回的稳定 Research Run identity。 */
    runId: string;
    /** CLI 返回的当前派生状态。 */
    state: {
      /** 状态机判别字段。 */
      type: string;
    };
  };
  expect(created.state.type).toBe("waiting_plan_approval");

  expect(
    await runCli(
      [
        "inspect",
        "--runtime-home",
        runtimeHome,
        "--run-id",
        created.runId,
        "--json",
      ],
      io,
    ),
  ).toBe(0);
  expect(JSON.parse(output.pop() ?? "null")).toMatchObject({
    runId: created.runId,
    state: { type: "waiting_plan_approval" },
  });

  expect(
    await runCli(
      [
        "trace",
        "--runtime-home",
        runtimeHome,
        "--run-id",
        created.runId,
      ],
      io,
    ),
  ).toBe(0);
  expect(output.pop()).toContain("#3 plan_proposed → waiting_plan_approval");
  expect(errorOutput).toEqual([]);
});
