#!/usr/bin/env node

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { ScriptedModel } from "./adapters/scripted-model.js";
import {
  IllegalPlanApprovalStateError,
  InvalidPlanApprovalCommandError,
  PlanApprovalConflictError,
  ResearchAgentRuntime,
  RunBusyError,
  StalePlanApprovalError,
} from "./application/research-agent-runtime.js";
import type { EvaluatorPort, ModelPort } from "./application/ports.js";
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

/** CLI 的进程外 system boundaries；测试可替换 live provider 装载。 */
export interface CliDependencies {
  /** 从环境配置创建同时实现 Model/Evaluator Port 的 live adapter。 */
  readonly loadLiveModelPort: () => Promise<ModelPort & EvaluatorPort>;
}

const processIo: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

const productionDependencies: CliDependencies = {
  loadLiveModelPort,
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
  dependencies: CliDependencies = productionDependencies,
): Promise<number> {
  const jsonRequested = args.includes("--json");
  try {
    const command = args[0];
    const commandArgs = args.slice(1);

    // 子命令专属 option 是授权边界而不只是 CLI 易用性：先固定唯一命令，再只把
    // 该命令获准的字段交给 strict parser，可防止 approval hash、question 等跨边界
    // 参数被静默接受，更不会在拒绝前打开 Runtime Home 或追加 Journal 事件。
    switch (command) {
      case "run": {
        const { values } = parseArgs({
          args: commandArgs,
          allowPositionals: false,
          strict: true,
          options: {
            "allowed-extension": { type: "string", multiple: true },
            exclude: { type: "string", multiple: true },
            json: { type: "boolean", default: false },
            "max-file-bytes": { type: "string" },
            "max-total-bytes": { type: "string" },
            question: { type: "string" },
            "runtime-home": { type: "string" },
            "source-root": { type: "string", multiple: true },
            "live-model": { type: "boolean", default: false },
          },
        });
        const runtimeHome = resolve(values["runtime-home"] ?? ".runtime");
        const question = requireOption(values.question, "--question");
        const roots = requireMultipleOption(values["source-root"], "--source-root");
        const model = values["live-model"]
          ? await dependencies.loadLiveModelPort()
          : new ScriptedModel([createLearningPlan(question)]);
        const runtime = ResearchAgentRuntime.open({
          runtimeHome,
          model,
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
        const { values } = parseArgs({
          args: commandArgs,
          allowPositionals: false,
          strict: true,
          options: {
            json: { type: "boolean", default: false },
            "run-id": { type: "string" },
            "runtime-home": { type: "string" },
          },
        });
        const runtimeHome = resolve(values["runtime-home"] ?? ".runtime");
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
      case "approve-plan": {
        const { values } = parseArgs({
          args: commandArgs,
          allowPositionals: false,
          strict: true,
          options: {
            "binding-hash": { type: "string" },
            json: { type: "boolean", default: false },
            "run-id": { type: "string" },
            "runtime-home": { type: "string" },
          },
        });
        const approvalRuntimeHome = resolve(
          requireOption(values["runtime-home"], "--runtime-home"),
        );
        const runId = requireOption(values["run-id"], "--run-id");
        const bindingHash = requireOption(
          values["binding-hash"],
          "--binding-hash",
        );
        // CLI 只承担显式用户命令边界：审批 authority 不得来自模型、Research
        // Tool、环境变量或调用方拼装的 Receipt。空 ScriptedModel 进一步证明此命令
        // 只恢复 durable waiting state，并不会重新采样计划。
        const runtime = ResearchAgentRuntime.open({
          runtimeHome: approvalRuntimeHome,
          model: new ScriptedModel([]),
        });
        try {
          const projection = await runtime.approvePlan({ runId, bindingHash });
          io.stdout(formatProjection(projection, values.json));
        } finally {
          runtime.close();
        }
        return 0;
      }
      case "advance": {
        const { values } = parseArgs({
          args: commandArgs,
          allowPositionals: false,
          strict: true,
          options: {
            json: { type: "boolean", default: false },
            "live-model": { type: "boolean", default: false },
            "run-id": { type: "string" },
            "runtime-home": { type: "string" },
            steering: { type: "string" },
          },
        });
        if (!values["live-model"]) {
          throw new CliUsageError("advance 需要显式 --live-model");
        }
        const model = await dependencies.loadLiveModelPort();
        const runtime = ResearchAgentRuntime.open({
          runtimeHome: resolve(
            requireOption(values["runtime-home"], "--runtime-home"),
          ),
          model,
          evaluator: model,
        });
        try {
          const projection = await runtime.advanceResearch({
            runId: requireOption(values["run-id"], "--run-id"),
            ...(values.steering === undefined
              ? {}
              : { steering: values.steering }),
          });
          io.stdout(formatProjection(projection, values.json));
        } finally {
          runtime.close();
        }
        return 0;
      }
      case "trace": {
        const { values } = parseArgs({
          args: commandArgs,
          allowPositionals: false,
          strict: true,
          options: {
            json: { type: "boolean", default: false },
            "run-id": { type: "string" },
            "runtime-home": { type: "string" },
          },
        });
        const runtimeHome = resolve(values["runtime-home"] ?? ".runtime");
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
      case "operation": {
        const { values } = parseArgs({
          args: commandArgs,
          allowPositionals: false,
          strict: true,
          options: {
            json: { type: "boolean", default: false },
            "run-id": { type: "string" },
            "runtime-home": { type: "string" },
          },
        });
        const runtime = ResearchAgentRuntime.open({
          runtimeHome: resolve(values["runtime-home"] ?? ".runtime"),
          model: new ScriptedModel([]),
        });
        try {
          const view = await runtime.inspectRunOperation({
            runId: requireOption(values["run-id"], "--run-id"),
          });
          io.stdout(values.json
            ? JSON.stringify(view, null, 2)
            : [
                `Operation: ${view.lease?.operationId ?? "none"}`,
                `Kind: ${view.lease?.kind ?? "none"}`,
                `Heartbeat: ${view.lease?.heartbeatAt ?? "none"}`,
                `Expires: ${view.lease?.expiresAt ?? "none"}`,
                `Cancellation: ${view.cancellationRequest?.requestId ?? "none"}`,
                `Consumed: ${view.cancellationRequest?.consumedAt ?? "none"}`,
              ].join("\n"));
        } finally {
          runtime.close();
        }
        return 0;
      }
      case "pause":
      case "resume":
      case "cancel": {
        const { values } = parseArgs({
          args: commandArgs,
          allowPositionals: false,
          strict: true,
          options: {
            json: { type: "boolean", default: false },
            "run-id": { type: "string" },
            "runtime-home": { type: "string" },
          },
        });
        const runtime = ResearchAgentRuntime.open({
          runtimeHome: resolve(
            requireOption(values["runtime-home"], "--runtime-home"),
          ),
          model: new ScriptedModel([]),
        });
        try {
          const runId = requireOption(values["run-id"], "--run-id");
          const projection = command === "pause"
            ? await runtime.pauseRun({ runId })
            : command === "resume"
              ? await runtime.resumeRun({ runId })
              : await runtime.cancelRun({ runId });
          io.stdout(formatProjection(projection, values.json));
        } finally {
          runtime.close();
        }
        return 0;
      }
      case "extend-budget": {
        const { values } = parseArgs({
          args: commandArgs,
          allowPositionals: false,
          strict: true,
          options: {
            json: { type: "boolean", default: false },
            "max-distinct-sources": { type: "string" },
            "max-model-turns": { type: "string" },
            "max-source-bytes": { type: "string" },
            "max-tool-calls": { type: "string" },
            "max-wall-time-ms": { type: "string" },
            "run-id": { type: "string" },
            "runtime-home": { type: "string" },
            version: { type: "string" },
          },
        });
        const runtime = ResearchAgentRuntime.open({
          runtimeHome: resolve(
            requireOption(values["runtime-home"], "--runtime-home"),
          ),
          model: new ScriptedModel([]),
        });
        try {
          const projection = await runtime.extendRunBudget({
            runId: requireOption(values["run-id"], "--run-id"),
            runBudget: {
              version: requireOption(values.version, "--version"),
              maxModelTurns: parsePositiveInteger(
                requireOption(values["max-model-turns"], "--max-model-turns"),
                "--max-model-turns",
              ),
              maxToolCalls: parsePositiveInteger(
                requireOption(values["max-tool-calls"], "--max-tool-calls"),
                "--max-tool-calls",
              ),
              maxDistinctSources: parsePositiveInteger(
                requireOption(
                  values["max-distinct-sources"],
                  "--max-distinct-sources",
                ),
                "--max-distinct-sources",
              ),
              maxSourceBytes: parsePositiveInteger(
                requireOption(values["max-source-bytes"], "--max-source-bytes"),
                "--max-source-bytes",
              ),
              maxWallTimeMs: parsePositiveInteger(
                requireOption(values["max-wall-time-ms"], "--max-wall-time-ms"),
                "--max-wall-time-ms",
              ),
            },
          });
          io.stdout(formatProjection(projection, values.json));
        } finally {
          runtime.close();
        }
        return 0;
      }
      case "propose-artifact": {
        const { values } = parseArgs({
          args: commandArgs,
          allowPositionals: false,
          strict: true,
          options: {
            json: { type: "boolean", default: false },
            "live-model": { type: "boolean", default: false },
            "output-root": { type: "string" },
            "run-id": { type: "string" },
            "runtime-home": { type: "string" },
            "target-path": { type: "string" },
          },
        });
        if (!values["live-model"]) {
          throw new CliUsageError("propose-artifact 需要显式 --live-model");
        }
        const model = await dependencies.loadLiveModelPort();
        const runtime = ResearchAgentRuntime.open({
          runtimeHome: resolve(
            requireOption(values["runtime-home"], "--runtime-home"),
          ),
          outputRoot: resolve(
            requireOption(values["output-root"], "--output-root"),
          ),
          model,
          evaluator: model,
        });
        try {
          const projection = await runtime.proposeLearningArtifact({
            runId: requireOption(values["run-id"], "--run-id"),
            targetPath: resolve(
              requireOption(values["target-path"], "--target-path"),
            ),
          });
          io.stdout(formatProjection(projection, values.json));
        } finally {
          runtime.close();
        }
        return 0;
      }
      case "retry-evaluator": {
        const { values } = parseArgs({
          args: commandArgs,
          allowPositionals: false,
          strict: true,
          options: {
            json: { type: "boolean", default: false },
            "live-model": { type: "boolean", default: false },
            "output-root": { type: "string" },
            "run-id": { type: "string" },
            "runtime-home": { type: "string" },
          },
        });
        if (!values["live-model"]) {
          throw new CliUsageError("retry-evaluator 需要显式 --live-model");
        }
        const model = await dependencies.loadLiveModelPort();
        const runtime = ResearchAgentRuntime.open({
          runtimeHome: resolve(
            requireOption(values["runtime-home"], "--runtime-home"),
          ),
          outputRoot: resolve(
            requireOption(values["output-root"], "--output-root"),
          ),
          model,
          evaluator: model,
        });
        try {
          const projection = await runtime.retryEvaluatorReview({
            runId: requireOption(values["run-id"], "--run-id"),
          });
          io.stdout(formatProjection(projection, values.json));
        } finally {
          runtime.close();
        }
        return 0;
      }
      case "skip-evaluator": {
        const { values } = parseArgs({
          args: commandArgs,
          allowPositionals: false,
          strict: true,
          options: {
            json: { type: "boolean", default: false },
            "output-root": { type: "string" },
            "run-id": { type: "string" },
            "runtime-home": { type: "string" },
          },
        });
        const runtime = ResearchAgentRuntime.open({
          runtimeHome: resolve(
            requireOption(values["runtime-home"], "--runtime-home"),
          ),
          outputRoot: resolve(
            requireOption(values["output-root"], "--output-root"),
          ),
          model: new ScriptedModel([]),
        });
        try {
          const projection = await runtime.skipEvaluatorReview({
            runId: requireOption(values["run-id"], "--run-id"),
          });
          io.stdout(formatProjection(projection, values.json));
        } finally {
          runtime.close();
        }
        return 0;
      }
      case "approve-publication": {
        const { values } = parseArgs({
          args: commandArgs,
          allowPositionals: false,
          strict: true,
          options: {
            "binding-hash": { type: "string" },
            json: { type: "boolean", default: false },
            "output-root": { type: "string" },
            "run-id": { type: "string" },
            "runtime-home": { type: "string" },
          },
        });
        const runtime = ResearchAgentRuntime.open({
          runtimeHome: resolve(
            requireOption(values["runtime-home"], "--runtime-home"),
          ),
          outputRoot: resolve(
            requireOption(values["output-root"], "--output-root"),
          ),
          model: new ScriptedModel([]),
        });
        try {
          const projection = await runtime.approvePublication({
            runId: requireOption(values["run-id"], "--run-id"),
            bindingHash: requireOption(
              values["binding-hash"],
              "--binding-hash",
            ),
          });
          io.stdout(formatProjection(projection, values.json));
        } finally {
          runtime.close();
        }
        return 0;
      }
      case "publish": {
        const { values } = parseArgs({
          args: commandArgs,
          allowPositionals: false,
          strict: true,
          options: {
            json: { type: "boolean", default: false },
            "output-root": { type: "string" },
            "run-id": { type: "string" },
            "runtime-home": { type: "string" },
          },
        });
        const runtime = ResearchAgentRuntime.open({
          runtimeHome: resolve(
            requireOption(values["runtime-home"], "--runtime-home"),
          ),
          outputRoot: resolve(
            requireOption(values["output-root"], "--output-root"),
          ),
          model: new ScriptedModel([]),
        });
        try {
          const projection = await runtime.publishLearningArtifact({
            runId: requireOption(values["run-id"], "--run-id"),
          });
          io.stdout(formatProjection(projection, values.json));
        } finally {
          runtime.close();
        }
        return 0;
      }
      case "reconcile": {
        const { values } = parseArgs({
          args: commandArgs,
          allowPositionals: false,
          strict: true,
          options: {
            json: { type: "boolean", default: false },
            "output-root": { type: "string" },
            "run-id": { type: "string" },
            "runtime-home": { type: "string" },
          },
        });
        const runtime = ResearchAgentRuntime.open({
          runtimeHome: resolve(
            requireOption(values["runtime-home"], "--runtime-home"),
          ),
          outputRoot: resolve(
            requireOption(values["output-root"], "--output-root"),
          ),
          model: new ScriptedModel([]),
        });
        try {
          const projection = await runtime.reconcilePublicationEffect({
            runId: requireOption(values["run-id"], "--run-id"),
          });
          io.stdout(formatProjection(projection, values.json));
        } finally {
          runtime.close();
        }
        return 0;
      }
      default:
        throw new CliUsageError("命令参数无效");
    }
  } catch (error) {
    io.stderr(formatCliError(error, jsonRequested));
    return 1;
  }
}

class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
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
    throw new CliUsageError(`缺少必填参数 ${name}`);
  }
  return value;
}

function requireMultipleOption(
  value: string[] | undefined,
  name: string,
): string[] {
  if (value === undefined || value.length === 0) {
    throw new CliUsageError(`缺少必填参数 ${name}`);
  }
  return value;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`${name} 必须是正整数`);
  }
  return parsed;
}

function formatCliError(error: unknown, json: boolean): string {
  const [code, message] = describeCliError(error);
  if (json) {
    return JSON.stringify({ error: { code, message } });
  }
  return message;
}

function describeCliError(error: unknown): readonly [string, string] {
  if (error instanceof CliUsageError) {
    return ["CLI_USAGE_ERROR", error.message];
  }
  if (isParseArgsError(error)) {
    return ["CLI_USAGE_ERROR", "命令参数无效"];
  }
  if (
    error instanceof InvalidPlanApprovalCommandError ||
    error instanceof StalePlanApprovalError ||
    error instanceof IllegalPlanApprovalStateError ||
    error instanceof PlanApprovalConflictError
  ) {
    return ["PLAN_APPROVAL_REJECTED", "计划审批未被接受"];
  }
  if (error instanceof RunBusyError) {
    return ["RUN_BUSY", "Research Run 正由另一个 mutating operation 推进"];
  }
  return ["CLI_COMMAND_FAILED", "命令执行失败"];
}

async function loadLiveModelPort() {
  const { createOpenAiCompatibleModelPortFromEnv } = await import(
    "./adapters/openai-compatible-model.js"
  );
  return createOpenAiCompatibleModelPortFromEnv();
}

function isParseArgsError(error: unknown): boolean {
  if (!(error instanceof TypeError) || !("code" in error)) {
    return false;
  }
  return (
    typeof error.code === "string" && error.code.startsWith("ERR_PARSE_ARGS_")
  );
}

const executedPath = process.argv[1];
if (
  executedPath !== undefined &&
  fileURLToPath(import.meta.url) === resolve(executedPath)
) {
  process.exitCode = await runCli(process.argv.slice(2));
}
