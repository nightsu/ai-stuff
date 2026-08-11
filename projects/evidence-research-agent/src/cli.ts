#!/usr/bin/env node

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { ScriptedModel } from "./adapters/scripted-model.js";
import { ResearchAgentRuntime } from "./application/research-agent-runtime.js";
import { formatRunTrace } from "./application/trace-format.js";
import type {
  ResearchPlan,
  RunBudget,
  RunProjection,
} from "./domain/types.js";

/** 让 CLI 测试可以捕获输出而不替换全局 console。 */
export interface CliIo {
  /** 写入一条标准输出消息；调用方负责决定终端或测试缓冲区。 */
  readonly stdout: (message: string) => void;
  /** 写入一条标准错误消息；不得用于正常机器可读结果。 */
  readonly stderr: (message: string) => void;
}

const processIo: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

const DEFAULT_RUN_BUDGET: RunBudget = Object.freeze({
  version: "budget-v1",
  maxModelTurns: 12,
  maxToolCalls: 40,
  maxDistinctSources: 24,
  maxSourceBytes: 5_000_000,
  maxWallTimeMs: 300_000,
});

export async function runCli(
  args: readonly string[],
  io: CliIo = processIo,
): Promise<number> {
  try {
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        "allowed-extension": { type: "string", multiple: true },
        "exclude": { type: "string", multiple: true },
        "json": { type: "boolean", default: false },
        "max-file-bytes": { type: "string" },
        "max-total-bytes": { type: "string" },
        "question": { type: "string" },
        "run-id": { type: "string" },
        "runtime-home": { type: "string" },
        "source-root": { type: "string", multiple: true },
      },
    });
    const command = positionals[0];
    const runtimeHome = resolve(values["runtime-home"] ?? ".runtime");

    switch (command) {
      case "run": {
        const question = requireOption(values.question, "--question");
        const roots = requireMultipleOption(values["source-root"], "--source-root");
        const runtime = ResearchAgentRuntime.open({
          runtimeHome,
          model: new ScriptedModel([createLearningPlan(question)]),
        });
        try {
          const projection = await runtime.createRun({
            question,
            sourceScope: {
              roots: roots.map((root) => resolve(root)),
              exclusions: values.exclude ?? ["**/node_modules/**", "**/.git/**"],
              allowedExtensions: values["allowed-extension"] ?? [".md", ".ts", ".json"],
              maxFileBytes: parsePositiveInteger(
                values["max-file-bytes"] ?? "512000",
                "--max-file-bytes",
              ),
              maxTotalBytes: parsePositiveInteger(
                values["max-total-bytes"] ?? "5000000",
                "--max-total-bytes",
              ),
            },
            runBudget: DEFAULT_RUN_BUDGET,
          });
          io.stdout(formatProjection(projection, values.json));
        } finally {
          runtime.close();
        }
        return 0;
      }
      case "inspect": {
        const runId = requireOption(values["run-id"], "--run-id");
        const runtime = ResearchAgentRuntime.open({
          runtimeHome,
          model: new ScriptedModel([]),
        });
        try {
          const projection = await runtime.inspectRun({ runId });
          io.stdout(formatProjection(projection, values.json));
        } finally {
          runtime.close();
        }
        return 0;
      }
      case "trace": {
        const runId = requireOption(values["run-id"], "--run-id");
        const runtime = ResearchAgentRuntime.open({
          runtimeHome,
          model: new ScriptedModel([]),
        });
        try {
          const trace = await runtime.traceRun({ runId });
          io.stdout(formatRunTrace(trace, values.json ? "json" : "human"));
        } finally {
          runtime.close();
        }
        return 0;
      }
      default:
        io.stderr(usage());
        return 1;
    }
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function createLearningPlan(question: string): ResearchPlan {
  return {
    title: `研究计划：${question}`,
    objectives: [`基于授权的本地来源回答：${question}`],
    steps: [
      {
        id: "scope-and-evidence",
        description: "确认 Source Scope，并定位可形成证据的相关材料",
      },
      {
        id: "claims-and-gaps",
        description: "组织候选 Claim，标记证据缺口并准备用户审批",
      },
    ],
  };
}

function formatProjection(projection: RunProjection, json: boolean): string {
  if (json) {
    return JSON.stringify(projection, null, 2);
  }
  return [
    `Run: ${projection.runId}`,
    `State: ${projection.state.type}`,
    `Question: ${projection.question}`,
    `Last event: #${projection.lastEventSequence}`,
  ].join("\n");
}

function requireOption(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`缺少必填参数 ${name}`);
  }
  return value;
}

function requireMultipleOption(
  value: string[] | undefined,
  name: string,
): string[] {
  if (value === undefined || value.length === 0) {
    throw new Error(`缺少必填参数 ${name}`);
  }
  return value;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return parsed;
}

function usage(): string {
  return [
    "Usage:",
    "  evidence-research-agent run --question <text> --source-root <absolute-path> [--runtime-home <path>] [--json]",
    "  evidence-research-agent inspect --run-id <id> [--runtime-home <path>] [--json]",
    "  evidence-research-agent trace --run-id <id> [--runtime-home <path>] [--json]",
  ].join("\n");
}

const executedPath = process.argv[1];
if (
  executedPath !== undefined &&
  fileURLToPath(import.meta.url) === resolve(executedPath)
) {
  process.exitCode = await runCli(process.argv.slice(2));
}
