import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  extname,
  isAbsolute,
  matchesGlob,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

import type { SourceScope } from "../domain/types.js";

/** Harness 固定拥有的单次 `read_source` 最大 1-based inclusive 行窗。 */
export const MAX_SOURCE_LINE_WINDOW = 200;

/** 一次结构化私有源读取请求。 */
export interface ReadSourceRequest {
  /** 只选择已批准 `SourceScope.roots` 的零基索引，不接受调用方路径替代。 */
  readonly rootIndex: number;
  /** 相对于所选批准根的 POSIX 文件路径。 */
  readonly relativePath: string;
  /** 请求摘录的首行，使用 1-based inclusive 语义。 */
  readonly startLine: number;
  /** 请求摘录的末行，使用 1-based inclusive 语义。 */
  readonly endLine: number;
}

/** Source Scope 策略拒绝读取时公开的稳定代码。 */
export type SourceAccessDenialCode =
  | "invalid_root"
  | "invalid_path"
  | "invalid_line_range"
  | "path_escape"
  | "symlink_escape"
  | "excluded_path"
  | "secret_path"
  | "extension_not_allowed"
  | "binary_file"
  | "file_too_large"
  | "source_budget_exceeded"
  | "line_range_too_large";

/** 预期文件系统失败被归一化后公开的稳定代码。 */
export type SourceAccessFailureCode =
  | "root_unavailable"
  | "source_not_found"
  | "source_not_file"
  | "source_io_error";

/** 请求因批准策略不允许而没有读取任何源字节。 */
export interface SourceAccessDenied {
  /** 判别字段，表示调用被策略拒绝。 */
  readonly status: "denied";
  /** 不包含路径、输入或 OS 错误的稳定策略代码。 */
  readonly code: SourceAccessDenialCode;
}

/** 请求因归一化文件系统失败而没有返回源字节。 */
export interface SourceAccessFailed {
  /** 判别字段，表示批准策略外的文件系统失败。 */
  readonly status: "failed";
  /** 不包含绝对路径或原始 OS 消息的稳定失败代码。 */
  readonly code: SourceAccessFailureCode;
}

/** 不具备读取或 snapshot 能力的预检通过结果。 */
export interface SourceAccessApproved {
  /** 判别字段，表示当前路径元数据已通过策略预检。 */
  readonly status: "approved";
  /** 实际选中的批准 Source Scope 根索引。 */
  readonly rootIndex: number;
  /** realpath 后相对于批准根的规范 POSIX 路径。 */
  readonly relativePath: string;
  /** 原样保留的请求首行，使用 1-based inclusive 语义。 */
  readonly startLine: number;
  /** 原样保留的请求末行，使用 1-based inclusive 语义。 */
  readonly endLine: number;
}

/** 预检只返回安全的批准元数据或稳定的非成功结果。 */
export type SourceAccessPreflightResult =
  | SourceAccessApproved
  | SourceAccessDenied
  | SourceAccessFailed;

/** 成功读取并验证、但尚未持久化为 Source Snapshot 的完整结果。 */
export interface SourceAccessCaptured {
  /** 判别字段，表示完整源字节已从同一个文件 handle 读取。 */
  readonly status: "captured";
  /** 实际选中的批准 Source Scope 根索引。 */
  readonly rootIndex: number;
  /** realpath 后相对于批准根的规范 POSIX 路径。 */
  readonly relativePath: string;
  /** 原样保留的请求首行，使用 1-based inclusive 语义。 */
  readonly startLine: number;
  /** 原样保留的请求末行，使用 1-based inclusive 语义。 */
  readonly endLine: number;
  /** 从已验证 UTF-8 全文派生、以 LF 连接的实际摘录文本。 */
  readonly excerpt: string;
  /** 已验证 UTF-8 全文包含的实际逻辑行数。 */
  readonly totalLines: number;
  /** 仅在基础设施边界内交给显式 snapshot 写入的完整精确字节。 */
  readonly fullBytes: Buffer;
  /** 完整源文件的精确字节数，而不是摘录的字节数。 */
  readonly byteLength: number;
}

/** 私有源读取的完整判别联合。 */
export type SourceAccessResult =
  | SourceAccessCaptured
  | SourceAccessDenied
  | SourceAccessFailed;

/** 只在组件内部携带 canonical 路径的预检能力。 */
interface ReadySource {
  /** 内部判别字段；该值不得越过 PrivateSourceAccess 的公开方法。 */
  readonly status: "ready";
  /** 仅用于紧随其后的 handle open，绝不能持久化或返回给调用方。 */
  readonly canonicalPath: string;
  /** 对外可安全返回、且不含绝对路径的预检结果。 */
  readonly approved: SourceAccessApproved;
}

/** 内部预检同时容纳受控 canonical capability 与安全失败结果。 */
type EvaluatedSource = ReadySource | SourceAccessDenied | SourceAccessFailed;

const READ_CHUNK_BYTES = 64 * 1024;

/** 在私有基础设施边界内执行 Source Scope 预检与精确字节读取。 */
export class PrivateSourceAccess {
  /** 创建组件时复制冻结、且已经应用层验证过的 Source Scope。 */
  readonly #scope: SourceScope;

  public constructor(scope: SourceScope) {
    this.#scope = Object.freeze({
      roots: Object.freeze([...scope.roots]),
      exclusions: Object.freeze([...scope.exclusions]),
      allowedExtensions: Object.freeze([...scope.allowedExtensions]),
      maxFileBytes: scope.maxFileBytes,
      maxTotalBytes: scope.maxTotalBytes,
    });
  }

  public async preflight(
    request: ReadSourceRequest,
    remainingSourceBytes: number,
  ): Promise<SourceAccessPreflightResult> {
    const evaluated = await this.#evaluate(request, remainingSourceBytes);
    return evaluated.status === "ready" ? evaluated.approved : evaluated;
  }

  public async capture(
    request: ReadSourceRequest,
    remainingSourceBytes: number,
  ): Promise<SourceAccessResult> {
    // capture 重新执行完整预检，而不信任较早的 discovery/preflight 结果；两次
    // realpath 之间仍可能发生 TOCTOU，因此真正的类型、大小和全部读取都绑定在
    // 随后打开的同一个 handle 上。Node 的 realpath 与 open 无法组成原子操作，
    // 所以这里缩短竞争窗口并在 handle 上 fail closed，而不声称消除了竞态。
    const evaluated = await this.#evaluate(request, remainingSourceBytes);
    if (evaluated.status !== "ready") {
      return evaluated;
    }

    let handle: FileHandle;
    try {
      // O_NOFOLLOW 关闭最终路径段在 realpath 后被换成 symlink 的常见竞态；父目录
      // 仍受平台文件系统 TOCTOU 限制，因此后续只信任同一 handle 的 fstat/read。
      handle = await open(
        evaluated.canonicalPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      return mapCandidateFailure(error);
    }

    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        return failed("source_not_file");
      }
      const preReadLimit = limitForSize(
        metadata.size,
        this.#scope.maxFileBytes,
        remainingSourceBytes,
      );
      if (preReadLimit !== undefined) {
        return preReadLimit;
      }

      const maximumBytes = Math.min(
        this.#scope.maxFileBytes,
        remainingSourceBytes,
      );
      const fullBytes = await readAtMost(handle, maximumBytes);
      const postReadLimit = limitForSize(
        fullBytes.byteLength,
        this.#scope.maxFileBytes,
        remainingSourceBytes,
      );
      if (postReadLimit !== undefined) {
        return postReadLimit;
      }

      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(fullBytes);
      } catch {
        return denied("binary_file");
      }
      if (text.includes("\0")) {
        return denied("binary_file");
      }

      const lines = splitLogicalLines(text);
      return {
        status: "captured",
        rootIndex: evaluated.approved.rootIndex,
        relativePath: evaluated.approved.relativePath,
        startLine: evaluated.approved.startLine,
        endLine: evaluated.approved.endLine,
        excerpt: lines
          .slice(
            evaluated.approved.startLine - 1,
            evaluated.approved.endLine,
          )
          .join("\n"),
        totalLines: lines.length,
        // Source Snapshot 的不变量是冻结成功检查时看到的完整文件字节，而不是
        // 摘录或重新编码文本；后续内容 identity 因而不受换行与 Unicode 重编码影响。
        fullBytes,
        byteLength: fullBytes.byteLength,
      };
    } catch {
      return failed("source_io_error");
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async #evaluate(
    request: ReadSourceRequest,
    remainingSourceBytes: number,
  ): Promise<EvaluatedSource> {
    if (
      !Number.isSafeInteger(request.rootIndex) ||
      request.rootIndex < 0 ||
      request.rootIndex >= this.#scope.roots.length
    ) {
      return denied("invalid_root");
    }
    if (
      !Number.isSafeInteger(request.startLine) ||
      !Number.isSafeInteger(request.endLine) ||
      request.startLine <= 0 ||
      request.endLine < request.startLine
    ) {
      return denied("invalid_line_range");
    }
    if (
      request.endLine - request.startLine + 1 >
      MAX_SOURCE_LINE_WINDOW
    ) {
      return denied("line_range_too_large");
    }
    if (
      !Number.isSafeInteger(remainingSourceBytes) ||
      remainingSourceBytes < 0
    ) {
      return denied("source_budget_exceeded");
    }
    if (!isValidRelativeRequestPath(request.relativePath)) {
      return denied("invalid_path");
    }
    if (request.relativePath.split("/").includes("..")) {
      return denied("path_escape");
    }

    const approvedRoot = this.#scope.roots[request.rootIndex];
    if (approvedRoot === undefined) {
      return denied("invalid_root");
    }

    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(approvedRoot);
      if (!(await stat(canonicalRoot)).isDirectory()) {
        return failed("root_unavailable");
      }
    } catch {
      return failed("root_unavailable");
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(resolve(canonicalRoot, request.relativePath));
    } catch (error) {
      return mapCandidateFailure(error);
    }

    // `path.relative` 按路径段判断边界，避免 `/approved` 对 `/approved-copy`
    // 的字符串前缀误授权；首段 `..` 或绝对结果都表示 realpath 已逃出批准根。
    const rootRelative = relative(canonicalRoot, canonicalPath);
    const relativeParts = rootRelative.split(sep);
    if (isAbsolute(rootRelative) || relativeParts[0] === "..") {
      return denied("symlink_escape");
    }
    const normalizedRelativePath = toPosixPath(rootRelative);

    if (isExcluded(normalizedRelativePath, this.#scope.exclusions)) {
      return denied("excluded_path");
    }
    // Secret denylist 必须早于扩展名 allowlist；否则把 `.pem` 加入允许列表会
    // 意外授权私钥，`.env` 也可能因特殊扩展名语义得到不一致结论。
    if (isSecretPath(normalizedRelativePath)) {
      return denied("secret_path");
    }
    if (!hasAllowedExtension(normalizedRelativePath, this.#scope.allowedExtensions)) {
      return denied("extension_not_allowed");
    }

    let metadata;
    try {
      metadata = await stat(canonicalPath);
    } catch (error) {
      return mapCandidateFailure(error);
    }
    if (!metadata.isFile()) {
      return failed("source_not_file");
    }
    const sizeLimit = limitForSize(
      metadata.size,
      this.#scope.maxFileBytes,
      remainingSourceBytes,
    );
    if (sizeLimit !== undefined) {
      return sizeLimit;
    }

    return {
      status: "ready",
      canonicalPath,
      approved: {
        status: "approved",
        rootIndex: request.rootIndex,
        relativePath: normalizedRelativePath,
        startLine: request.startLine,
        endLine: request.endLine,
      },
    };
  }
}

function isValidRelativeRequestPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !isAbsolute(value) &&
    !posix.isAbsolute(value) &&
    !win32.isAbsolute(value)
  );
}

function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

function isExcluded(
  normalizedRelativePath: string,
  exclusions: readonly string[],
): boolean {
  return exclusions.some((pattern) => {
    try {
      return matchesGlob(normalizedRelativePath, pattern);
    } catch {
      // 未能解释批准 Scope 中的排除表达式时宁可拒绝，不能将解析失败当作扩权。
      return true;
    }
  });
}

function isSecretPath(normalizedRelativePath: string): boolean {
  // Secret basename 统一折叠为小写后 fail closed，避免大小写不同绕过 `.env*`。
  const lowerPath = normalizedRelativePath.toLowerCase();
  const segments = lowerPath.split("/");
  const fileName = segments.at(-1) ?? "";

  if (
    fileName.startsWith(".env") ||
    fileName.endsWith(".pem") ||
    fileName.endsWith(".key")
  ) {
    return true;
  }
  if (
    [".npmrc", ".pypirc", ".netrc", ".dockercfg", ".git-credentials"].includes(
      fileName,
    )
  ) {
    return true;
  }
  return /^(?:credentials?|tokens?|secrets?|service[-_]account)(?:\.[^/]*)?$/.test(
    fileName,
  );
}

function hasAllowedExtension(
  normalizedRelativePath: string,
  allowedExtensions: readonly string[],
): boolean {
  const extension = extname(normalizedRelativePath);
  // 大小写策略显式 fail closed：源文件扩展名和批准列表项都必须已经是小写，
  // 不通过大小写折叠暗中扩大已批准的 Source Scope。
  return (
    extension.length > 0 &&
    extension === extension.toLowerCase() &&
    allowedExtensions.some(
      (allowed) =>
        allowed === allowed.toLowerCase() && allowed === extension,
    )
  );
}

function limitForSize(
  byteLength: number,
  maxFileBytes: number,
  remainingSourceBytes: number,
): SourceAccessDenied | undefined {
  if (byteLength > maxFileBytes) {
    return denied("file_too_large");
  }
  if (byteLength > remainingSourceBytes) {
    return denied("source_budget_exceeded");
  }
  return undefined;
}

async function readAtMost(
  handle: FileHandle,
  maximumBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteLength = 0;

  while (byteLength <= maximumBytes) {
    const remainingWithSentinel = maximumBytes + 1 - byteLength;
    const chunk = Buffer.allocUnsafe(
      Math.min(READ_CHUNK_BYTES, remainingWithSentinel),
    );
    const { bytesRead } = await handle.read(
      chunk,
      0,
      chunk.byteLength,
      byteLength,
    );
    if (bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, bytesRead));
    byteLength += bytesRead;
  }

  return Buffer.concat(chunks, byteLength);
}

function splitLogicalLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split(/\r\n|\n|\r/);
  if (/\r\n$|[\n\r]$/.test(text)) {
    lines.pop();
  }
  return lines;
}

function denied(code: SourceAccessDenialCode): SourceAccessDenied {
  return { status: "denied", code };
}

function failed(code: SourceAccessFailureCode): SourceAccessFailed {
  return { status: "failed", code };
}

function mapCandidateFailure(error: unknown): SourceAccessFailed {
  if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENOTDIR")) {
    return failed("source_not_found");
  }
  return failed("source_io_error");
}

function isErrorCode(
  error: unknown,
  code: NodeJS.ErrnoException["code"],
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
