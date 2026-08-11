import { createHash } from "node:crypto";

import type {
  ArtifactReference,
  PlanApprovalBinding,
  ReadSourceRequest,
  RunBudget,
  SourceSnapshotReference,
  SourceScope,
} from "./types.js";

/** 创建精确计划审批绑定所需的已规范化输入。 */
export interface CreatePlanApprovalBindingInput {
  /** 用户提交并经命令边界去除首尾空白后的技术问题。 */
  readonly question: string;
  /** 已持久化计划 artifact 精确字节内容的 SHA-256 摘要。 */
  readonly planHash: string;
  /** 创建 Run 时经 schema 校验并冻结记录的 Source Scope。 */
  readonly sourceScope: SourceScope;
  /** 创建 Run 时经 schema 校验且不受模型控制的 Run Budget。 */
  readonly runBudget: RunBudget;
}

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

const sha256Pattern = /^[a-f0-9]{64}$/;

/** 判断内容寻址 artifact identity 是否精确命名了同一个摘要。 */
export function artifactReferenceHasMatchingContentIdentity(
  reference: ArtifactReference,
): boolean {
  return reference.artifactId === `sha256:${reference.sha256}`;
}

/** 判断 Source Snapshot identity、摘要与私有 namespace 路径是否命名同一内容。 */
export function sourceSnapshotHasMatchingContentIdentity(
  reference: SourceSnapshotReference,
): boolean {
  return (
    reference.snapshotId === `source-sha256:${reference.sha256}` &&
    reference.relativePath ===
      `source-snapshots/sha256/${reference.sha256.slice(0, 2)}/${reference.sha256}`
  );
}

/** 对调用方精确结构化 `read_source` 请求计算 canonical JSON SHA-256。 */
export function hashReadSourceRequest(request: ReadSourceRequest): string {
  return hashCanonicalJson({
    rootIndex: request.rootIndex,
    relativePath: request.relativePath,
    startLine: request.startLine,
    endLine: request.endLine,
  });
}

/** 对摘录字符串的原始 UTF-8 编码计算小写十六进制 SHA-256。 */
export function hashUtf8Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 对递归 key 排序后的 JSON 值计算小写十六进制 SHA-256 摘要。 */
export function hashCanonicalJson(value: unknown): string {
  const canonicalJson = stringifyCanonicalJson(toCanonicalJsonValue(value));
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}

/** 把 question、精确计划、Source Scope 与预算版本聚合成审批边界。 */
export function createPlanApprovalBinding(
  input: CreatePlanApprovalBindingInput,
): PlanApprovalBinding {
  if (!sha256Pattern.test(input.planHash)) {
    throw new TypeError("planHash 必须是 64 位小写十六进制 SHA-256 摘要");
  }

  // 这里只哈希已经通过领域 schema 的非秘密值；模型提示词、凭据和运行环境
  // 不得混入审批凭据，以免泄漏或产生无法复现的授权边界。
  const components = {
    questionHash: hashCanonicalJson(input.question),
    planHash: input.planHash,
    sourceScopeHash: hashCanonicalJson(input.sourceScope),
    budgetVersion: input.runBudget.version,
    budgetHash: hashCanonicalJson(input.runBudget),
  };

  return {
    ...components,
    bindingHash: hashCanonicalJson(components),
  };
}

function toCanonicalJsonValue(value: unknown): CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON 不接受非有限数字");
    }
    return value;
  }

  if (Array.isArray(value)) {
    // 稀疏数组不是本项目的 JSON 领域输入；若让 map 跳过 hole，多个不同
    // JavaScript 值可能静默折叠到同一字节串。审批哈希宁可拒绝也不猜测。
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError("canonical JSON 不接受稀疏数组");
      }
    }
    return value.map((item) => toCanonicalJsonValue(item));
  }

  if (isPlainJsonObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, toCanonicalJsonValue(value[key])]),
    );
  }

  throw new TypeError("canonical JSON 只接受 JSON 标量、数组和普通对象");
}

function stringifyCanonicalJson(value: CanonicalJsonValue): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("canonical JSON 标量无法被序列化");
    }
    return serialized;
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyCanonicalJson(item)).join(",")}]`;
  }

  // 直接拼接已经排序的 entry，避免 JSON.stringify 把整数样式 key
  // 按数值顺序重新排列而破坏字典序 canonical form。
  const entries = Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stringifyCanonicalJson(value[key]!)}`,
    );
  return `{${entries.join(",")}}`;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}
