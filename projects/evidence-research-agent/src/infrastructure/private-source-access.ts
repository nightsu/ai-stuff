import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  sourcePathPolicyDenial,
  sourceRequestDenial,
} from "../domain/source-policy.js";
import type {
  ReadSourceRequest,
  RequestedSourceScope,
  SourceAccessDenialCode,
  SourceAccessFailureCode,
  SourceRootIdentity,
  SourceScope,
} from "../domain/types.js";

export { MAX_SOURCE_LINE_WINDOW } from "../domain/source-policy.js";
export type { ReadSourceRequest } from "../domain/types.js";

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
  /** 预检时 candidate 设备号，用于发现 handle open 前的路径替换。 */
  readonly candidateDevice: bigint;
  /** 预检时 candidate inode，用于发现 handle open 前的路径替换。 */
  readonly candidateInode: bigint;
  /** 对外可安全返回、且不含绝对路径的预检结果。 */
  readonly approved: SourceAccessApproved;
}

/** 内部预检同时容纳受控 canonical capability 与安全失败结果。 */
type EvaluatedSource = ReadySource | SourceAccessDenied | SourceAccessFailed;

const READ_CHUNK_BYTES = 64 * 1024;
/** capture 生命周期中的可选异步边界，不接收私有路径或源字节。 */
export interface SourceAccessLifecycleHooks {
  /** 完整预检通过后、打开 candidate handle 前运行的可选协调回调。 */
  readonly afterPreflight?: () => void | Promise<void>;
  /** 完整字节读出后、最终版本与路径复核前运行的可选协调回调。 */
  readonly afterRead?: () => void | Promise<void>;
}

/** 请求的 Source Root 无法安全绑定为 canonical identity。 */
export class SourceScopeCanonicalizationError extends Error {
  public constructor() {
    super("Source Scope root canonicalization failed");
    this.name = "SourceScopeCanonicalizationError";
  }
}

/** 在写入 Run Journal 前把 caller roots 转换为不可伪造的文件系统 identities。 */
export async function canonicalizeSourceScope(
  requested: RequestedSourceScope,
): Promise<SourceScope> {
  const roots: SourceRootIdentity[] = [];

  for (const requestedRoot of requested.roots) {
    try {
      const requestedMetadata = await lstat(requestedRoot, { bigint: true });
      if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()) {
        throw new SourceScopeCanonicalizationError();
      }
      const canonicalPath = await realpath(requestedRoot);
      const [canonicalLinkMetadata, canonicalMetadata] = await Promise.all([
        lstat(canonicalPath, { bigint: true }),
        stat(canonicalPath, { bigint: true }),
      ]);
      if (
        !canonicalLinkMetadata.isDirectory() ||
        canonicalLinkMetadata.isSymbolicLink() ||
        !canonicalMetadata.isDirectory() ||
        !sameFileIdentity(requestedMetadata, canonicalLinkMetadata) ||
        !sameFileIdentity(requestedMetadata, canonicalMetadata)
      ) {
        throw new SourceScopeCanonicalizationError();
      }

      const identity = {
        canonicalPath,
        device: canonicalMetadata.dev.toString(10),
        inode: canonicalMetadata.ino.toString(10),
      };
      if (roots.some((approved) => rootsOverlap(approved, identity))) {
        // 重复或嵌套 root 会让同一路径具有多个 rootIndex 解释；审批边界拒绝，
        // 而不是静默去重或替调用方改变索引。
        throw new SourceScopeCanonicalizationError();
      }
      roots.push(identity);
    } catch {
      throw new SourceScopeCanonicalizationError();
    }
  }

  return {
    roots,
    exclusions: [...requested.exclusions],
    allowedExtensions: [...requested.allowedExtensions],
    maxFileBytes: requested.maxFileBytes,
    maxTotalBytes: requested.maxTotalBytes,
  };
}

/** 在私有基础设施边界内执行 Source Scope 预检与精确字节读取。 */
export class PrivateSourceAccess {
  /** 创建组件时复制冻结、且已经应用层验证过的 Source Scope。 */
  readonly #scope: SourceScope;
  /** 默认不执行任何动作的 capture 生命周期协调边界。 */
  readonly #hooks: SourceAccessLifecycleHooks;

  public constructor(
    scope: SourceScope,
    hooks: SourceAccessLifecycleHooks = {},
  ) {
    this.#scope = Object.freeze({
      roots: Object.freeze(
        scope.roots.map((root) => Object.freeze({ ...root })),
      ),
      exclusions: Object.freeze([...scope.exclusions]),
      allowedExtensions: Object.freeze([...scope.allowedExtensions]),
      maxFileBytes: scope.maxFileBytes,
      maxTotalBytes: scope.maxTotalBytes,
    });
    this.#hooks = Object.freeze({ ...hooks });
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
    // capture 重新执行完整预检，而不信任较早的 discovery/preflight 结果。
    // Node 标准路径 API 没有 portable openat/openat2，不能对 hostile writer 提供
    // 原子路径隔离；逐段拒绝 symlink、同一 handle 前后 fstat 与事后 realpath/
    // identity 复核只会 fail closed 地发现稳定可观测变化，不声称消除了父目录竞态。
    const evaluated = await this.#evaluate(request, remainingSourceBytes);
    if (evaluated.status !== "ready") {
      return evaluated;
    }
    try {
      await this.#hooks.afterPreflight?.();
    } catch {
      return failed("source_io_error");
    }
    const rootAfterPreflight = this.#scope.roots[request.rootIndex];
    if (
      rootAfterPreflight === undefined ||
      !(await rootIdentityStillMatches(rootAfterPreflight))
    ) {
      return failed("root_changed");
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
      const beforeRead = await handle.stat({ bigint: true });
      if (!beforeRead.isFile()) {
        return failed("source_not_file");
      }
      if (
        beforeRead.dev !== evaluated.candidateDevice ||
        beforeRead.ino !== evaluated.candidateInode
      ) {
        return failed("path_changed_during_read");
      }
      const preReadLimit = limitForSize(
        beforeRead.size,
        this.#scope.maxFileBytes,
        this.#scope.maxTotalBytes,
        remainingSourceBytes,
      );
      if (preReadLimit !== undefined) {
        return preReadLimit;
      }

      const maximumBytes = Math.min(
        this.#scope.maxFileBytes,
        this.#scope.maxTotalBytes,
        remainingSourceBytes,
      );
      const fullBytes = await readAtMost(handle, maximumBytes);
      await this.#hooks.afterRead?.();
      const afterRead = await handle.stat({ bigint: true });
      if (
        BigInt(fullBytes.byteLength) !== beforeRead.size ||
        !sameFileVersion(beforeRead, afterRead)
      ) {
        return failed("source_changed_during_read");
      }
      const postReadLimit = limitForSize(
        fullBytes.byteLength,
        this.#scope.maxFileBytes,
        this.#scope.maxTotalBytes,
        remainingSourceBytes,
      );
      if (postReadLimit !== undefined) {
        return postReadLimit;
      }
      const approvedRoot = this.#scope.roots[request.rootIndex];
      if (
        approvedRoot === undefined ||
        !(await rootIdentityStillMatches(approvedRoot))
      ) {
        return failed("root_changed");
      }
      if (
        !(await capturedPathStillMatches(
          approvedRoot,
          request.relativePath,
          evaluated,
          beforeRead,
        ))
      ) {
        return failed("path_changed_during_read");
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
      if (
        evaluated.approved.startLine > lines.length ||
        evaluated.approved.endLine > lines.length
      ) {
        return denied("line_range_out_of_bounds");
      }
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
    const requestDenial = sourceRequestDenial(
      request,
      this.#scope.roots.length,
      remainingSourceBytes,
    );
    if (requestDenial !== undefined) {
      return denied(requestDenial);
    }

    const approvedRoot = this.#scope.roots[request.rootIndex];
    if (approvedRoot === undefined) {
      return denied("invalid_root");
    }

    if (!(await rootIdentityStillMatches(approvedRoot))) {
      return failed("root_changed");
    }
    const canonicalRoot = approvedRoot.canonicalPath;

    const segmentCheck = await checkPathSegments(
      canonicalRoot,
      request.relativePath,
    );
    if (segmentCheck === "symlink") {
      return denied("symlink_path");
    }
    if (segmentCheck === "not_found") {
      return failed("source_not_found");
    }
    if (segmentCheck === "io_error") {
      return failed("source_io_error");
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
    if (normalizedRelativePath !== request.relativePath) {
      // requestHash 绑定调用方精确结构化参数，而成功 observation 只持久化这条
      // canonical 相对路径。若大小写或 Unicode 拼写被文件系统改写，两者将无法
      // 由 Journal 独立重算为同一请求，因此这里必须记录安全 denial 而非成功。
      return denied("invalid_path");
    }

    const pathDenial = sourcePathPolicyDenial(
      normalizedRelativePath,
      this.#scope,
    );
    if (pathDenial !== undefined) {
      return denied(pathDenial);
    }

    let metadata;
    try {
      metadata = await stat(canonicalPath, { bigint: true });
    } catch (error) {
      return mapCandidateFailure(error);
    }
    if (!metadata.isFile()) {
      return failed("source_not_file");
    }
    const sizeLimit = limitForSize(
      metadata.size,
      this.#scope.maxFileBytes,
      this.#scope.maxTotalBytes,
      remainingSourceBytes,
    );
    if (sizeLimit !== undefined) {
      return sizeLimit;
    }

    return {
      status: "ready",
      canonicalPath,
      candidateDevice: metadata.dev,
      candidateInode: metadata.ino,
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

async function checkPathSegments(
  canonicalRoot: string,
  relativePath: string,
): Promise<"safe" | "symlink" | "not_found" | "io_error"> {
  const segments = relativePath
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  let currentPath = canonicalRoot;

  for (const [index, segment] of segments.entries()) {
    currentPath = resolve(currentPath, segment);
    try {
      const metadata = await lstat(currentPath, { bigint: true });
      if (metadata.isSymbolicLink()) {
        return "symlink";
      }
      if (index < segments.length - 1 && !metadata.isDirectory()) {
        return "not_found";
      }
    } catch (error) {
      if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENOTDIR")) {
        return "not_found";
      }
      return "io_error";
    }
  }
  return "safe";
}

async function capturedPathStillMatches(
  approvedRoot: SourceRootIdentity,
  requestedRelativePath: string,
  evaluated: ReadySource,
  handleMetadata: BigIntStats,
): Promise<boolean> {
  if (
    (await checkPathSegments(
      approvedRoot.canonicalPath,
      requestedRelativePath,
    )) !== "safe"
  ) {
    return false;
  }

  try {
    const currentPath = await realpath(
      resolve(approvedRoot.canonicalPath, requestedRelativePath),
    );
    const rootRelative = relative(approvedRoot.canonicalPath, currentPath);
    if (
      isAbsolute(rootRelative) ||
      rootRelative.split(sep)[0] === ".." ||
      toPosixPath(rootRelative) !== evaluated.approved.relativePath
    ) {
      return false;
    }
    const pathMetadata = await lstat(currentPath, { bigint: true });
    return (
      pathMetadata.isFile() &&
      !pathMetadata.isSymbolicLink() &&
      pathMetadata.dev === handleMetadata.dev &&
      pathMetadata.ino === handleMetadata.ino
    );
  } catch {
    return false;
  }
}

async function rootIdentityStillMatches(
  approved: SourceRootIdentity,
): Promise<boolean> {
  try {
    const linkMetadata = await lstat(approved.canonicalPath, { bigint: true });
    if (!linkMetadata.isDirectory() || linkMetadata.isSymbolicLink()) {
      return false;
    }
    const [currentRealpath, metadata] = await Promise.all([
      realpath(approved.canonicalPath),
      stat(approved.canonicalPath, { bigint: true }),
    ]);
    return (
      currentRealpath === approved.canonicalPath &&
      metadata.isDirectory() &&
      sameApprovedIdentity(linkMetadata, approved) &&
      sameApprovedIdentity(metadata, approved)
    );
  } catch {
    return false;
  }
}

function rootsOverlap(
  left: SourceRootIdentity,
  right: SourceRootIdentity,
): boolean {
  if (left.device === right.device && left.inode === right.inode) {
    return true;
  }
  return (
    isStrictlyContainedPath(left.canonicalPath, right.canonicalPath) ||
    isStrictlyContainedPath(right.canonicalPath, left.canonicalPath)
  );
}

function isStrictlyContainedPath(parent: string, candidate: string): boolean {
  const rootRelative = relative(parent, candidate);
  return (
    rootRelative.length > 0 &&
    !isAbsolute(rootRelative) &&
    rootRelative.split(sep)[0] !== ".."
  );
}

function sameFileIdentity(
  left: Pick<BigIntStats, "dev" | "ino">,
  right: Pick<BigIntStats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameApprovedIdentity(
  metadata: Pick<BigIntStats, "dev" | "ino">,
  approved: SourceRootIdentity,
): boolean {
  return (
    metadata.dev.toString(10) === approved.device &&
    metadata.ino.toString(10) === approved.inode
  );
}

function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

function limitForSize(
  byteLength: number | bigint,
  maxFileBytes: number,
  maxTotalBytes: number,
  remainingSourceBytes: number,
): SourceAccessDenied | undefined {
  const size = typeof byteLength === "bigint" ? byteLength : BigInt(byteLength);
  if (size > BigInt(maxFileBytes)) {
    return denied("file_too_large");
  }
  if (
    size > BigInt(maxTotalBytes) ||
    size > BigInt(remainingSourceBytes)
  ) {
    return denied("source_budget_exceeded");
  }
  return undefined;
}

function sameFileVersion(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
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
