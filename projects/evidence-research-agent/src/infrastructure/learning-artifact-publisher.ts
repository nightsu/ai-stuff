import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import type { PublicationTarget } from "../domain/types.js";

/** 用户提交的 publication target 无法安全绑定到 canonical parent directory 时抛出。 */
export class PublicationTargetPreparationError extends Error {
  public constructor() {
    super("Learning Artifact 发布目标无效或不可用");
    this.name = "PublicationTargetPreparationError";
  }
}

/** 已批准 publication target 无法以正常 no-clobber 路径写入时抛出的安全错误。 */
export class LearningArtifactPublishError extends Error {
  public constructor() {
    super("Learning Artifact 无法安全发布");
    this.name = "LearningArtifactPublishError";
  }
}

/** Publisher 已安全确认 final target 是不同内容时携带的 no-clobber 结果。 */
export class PublicationTargetConflictError extends LearningArtifactPublishError {
  /** 可安全公开的现有 target SHA-256；未读取完整 bytes 时为 undefined。 */
  public readonly observedTargetHash: string | undefined;

  public constructor(observedTargetHash?: string) {
    super();
    this.name = "PublicationTargetConflictError";
    this.observedTargetHash = observedTargetHash;
  }
}

/** 创建 publisher 时冻结的、禁止把私有 Runtime Home 当成公开输出的边界。 */
export interface LearningArtifactPublisherOptions {
  /** 所有 Learning Artifact target 必须位于此 canonical Output Root 内。 */
  readonly outputRoot?: string;
  /** 私有 Runtime Home；若与 Output Root 重叠，任何 publication 都 fail closed。 */
  readonly runtimeHome?: string;
}

/** Publisher 内部可注入的确定性写入边界，仅用于恢复测试与故障演练。 */
export interface PublicationWriteLifecycleHooks {
  /** 同目录 temporary file 已创建、任何 approved bytes 尚未写入前运行。 */
  readonly beforeTemporaryWrite?: () => void | Promise<void>;
  /** temporary bytes、file metadata 与 file fsync 均验证完成后运行。 */
  readonly afterTemporaryWrite?: () => void | Promise<void>;
  /** final no-clobber link 尚未创建、durable temporary file 已就绪时运行。 */
  readonly beforeAtomicPublish?: () => void | Promise<void>;
  /** final name 可见且 parent directory 已 fsync 后运行。 */
  readonly afterAtomicPublish?: () => void | Promise<void>;
}

/** 对 approved target 的安全 reconciliation 观察结果。 */
export type PublicationTargetInspection =
  | {
      /** exact canonical target 当前不存在，原 effect 可用同一 identity 重试。 */
      readonly kind: "missing";
    }
  | {
      /** target 是 exact approved bytes，reconcile 可结算成功且不得重写。 */
      readonly kind: "matching";
    }
  | {
      /** target 是不同 regular-file bytes，effect 必须进入 no-clobber conflict。 */
      readonly kind: "conflict";
      /** 对现有 exact bytes 计算的 SHA-256，供安全审计而不暴露内容。 */
      readonly observedTargetHash: string;
    }
  | {
      /** 当前系统调用无法可靠判定 target outcome，必须保留 UNKNOWN。 */
      readonly kind: "unknown";
    };

/** 同目录原子 publication 前捕获的 canonical parent directory identity。 */
interface PublicationDirectoryIdentity {
  /** 准备时得到、后续每次写入前后都重新验证的 canonical parent directory。 */
  readonly canonicalPath: string;
  /** 目录设备号，在进程内使用 bigint 避免精度丢失。 */
  readonly device: bigint;
  /** 目录 inode，在进程内使用 bigint 避免精度丢失。 */
  readonly inode: bigint;
}

/** 向用户可见目标发布 Markdown 的窄基础设施边界。 */
export class LearningArtifactPublisher {
  /** 调用方声明的 Output Root；缺失时不允许提出可发布 target。 */
  readonly #outputRoot: string | undefined;
  /** 已由 Runtime 集中 canonicalize 的私有状态目录。 */
  readonly #runtimeHome: string | undefined;

  public constructor(options: LearningArtifactPublisherOptions = {}) {
    this.#outputRoot = options.outputRoot;
    this.#runtimeHome = options.runtimeHome;
  }

  /** 把调用方绝对路径绑定为 canonical target path 与 parent device/inode。 */
  public async prepareTarget(targetPath: string): Promise<PublicationTarget> {
    try {
      if (
        this.#outputRoot === undefined ||
        !isAbsolute(targetPath) ||
        extname(targetPath).toLowerCase() !== ".md"
      ) {
        throw new PublicationTargetPreparationError();
      }
      const outputRoot = await captureDirectoryIdentity(this.#outputRoot);
      if (
        this.#runtimeHome !== undefined &&
        pathsOverlap(outputRoot.canonicalPath, this.#runtimeHome)
      ) {
        throw new PublicationTargetPreparationError();
      }
      const resolvedPath = resolve(targetPath);
      const targetName = basename(resolvedPath);
      if (targetName === "." || targetName === "..") {
        throw new PublicationTargetPreparationError();
      }
      const parent = await captureDirectoryIdentity(dirname(resolvedPath));
      const targetCanonicalPath = join(parent.canonicalPath, targetName);
      if (!isStrictDescendant(outputRoot.canonicalPath, targetCanonicalPath)) {
        throw new PublicationTargetPreparationError();
      }
      await assertExistingTargetIsRegularOrMissing(targetCanonicalPath);
      return {
        outputRootCanonicalPath: outputRoot.canonicalPath,
        outputRootDevice: outputRoot.device.toString(10),
        outputRootInode: outputRoot.inode.toString(10),
        targetCanonicalPath,
        parentDevice: parent.device.toString(10),
        parentInode: parent.inode.toString(10),
      };
    } catch (error) {
      if (error instanceof PublicationTargetPreparationError) {
        throw error;
      }
      throw new PublicationTargetPreparationError();
    }
  }

  /**
   * 把已经获得用户批准的 exact Markdown 写到 target。普通 `rename` 在 Node 中会
   * 覆盖存在文件，无法实现 no-clobber；这里以同目录 temporary file + `link` 原子
   * 创建 final name，再删除 temporary file，既不暴露半成品也不覆盖不同内容。
   */
  public async publish(
    target: PublicationTarget,
    markdown: string,
    hooks: PublicationWriteLifecycleHooks = {},
  ): Promise<void> {
    const expected = Buffer.from(markdown, "utf8");
    let temporaryPath: string | undefined;
    let handle: FileHandle | undefined;
    try {
      await this.#assertConfiguredOutputRoot(target);
      const parent = await assertPublicationTargetParent(target);
      await assertExistingTargetMatchesOrIsMissing(target.targetCanonicalPath, expected);
      temporaryPath = join(
        parent.canonicalPath,
        `.learning-artifact-${randomUUID()}.tmp`,
      );
      handle = await open(
        temporaryPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      await hooks.beforeTemporaryWrite?.();
      await handle.writeFile(expected);
      await handle.sync();
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile() || metadata.size !== BigInt(expected.byteLength)) {
        throw new LearningArtifactPublishError();
      }
      await handle.chmod(0o600);
      await handle.close();
      handle = undefined;
      await hooks.afterTemporaryWrite?.();

      await assertPublicationTargetParent(target);
      await hooks.beforeAtomicPublish?.();
      try {
        await link(temporaryPath, target.targetCanonicalPath);
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) {
          throw new LearningArtifactPublishError();
        }
        // 其他 writer 在我们 preflight 后先占用了 final name 时，只有精确相同
        // 字节才算幂等成功；不同内容绝不以 rename 覆盖，也不猜测对方的意图。
        await assertExistingTargetMatchesOrIsMissing(
          target.targetCanonicalPath,
          expected,
          false,
        );
      }
      await assertPublicationTargetParent(target);
      await syncDirectory(parent.canonicalPath);
      await hooks.afterAtomicPublish?.();
    } catch (error) {
      if (error instanceof LearningArtifactPublishError) {
        throw error;
      }
      throw new LearningArtifactPublishError();
    } finally {
      await handle?.close().catch(() => undefined);
      if (temporaryPath !== undefined) {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
  }

  /** 在不修改 target 的前提下，把 current bytes 与 exact approved Markdown 对账。 */
  public async inspectTarget(
    target: PublicationTarget,
    markdown: string,
  ): Promise<PublicationTargetInspection> {
    const expected = Buffer.from(markdown, "utf8");
    await this.#assertConfiguredOutputRoot(target);
    await assertPublicationTargetParent(target);
    let handle: FileHandle | undefined;
    try {
      const pathMetadata = await lstat(target.targetCanonicalPath, {
        bigint: true,
      });
      if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
        return { kind: "unknown" };
      }
      handle = await open(
        target.targetCanonicalPath,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      const opened = await handle.stat({ bigint: true });
      if (
        !opened.isFile() ||
        opened.dev !== pathMetadata.dev ||
        opened.ino !== pathMetadata.ino ||
        (await realpath(target.targetCanonicalPath)) !==
          target.targetCanonicalPath
      ) {
        return { kind: "unknown" };
      }
      const existing = await handle.readFile();
      if (existing.equals(expected)) return { kind: "matching" };
      return {
        kind: "conflict",
        observedTargetHash: hashBytes(existing),
      };
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return { kind: "missing" };
      return { kind: "unknown" };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** 恢复前重验 Output Root 与 parent identity，但把 final target 分类留给 inspection。 */
  public async validateTargetIdentity(target: PublicationTarget): Promise<void> {
    await this.#assertConfiguredOutputRoot(target);
    await assertPublicationTargetParent(target);
  }

  /** 重新打开 Runtime 时也必须使用批准时同一 Output Root，而不是相信 Journal target 自己。 */
  async #assertConfiguredOutputRoot(target: PublicationTarget): Promise<void> {
    if (this.#outputRoot === undefined) {
      throw new LearningArtifactPublishError();
    }
    const configured = await captureDirectoryIdentity(this.#outputRoot);
    if (
      (this.#runtimeHome !== undefined &&
        pathsOverlap(configured.canonicalPath, this.#runtimeHome)) ||
      configured.canonicalPath !== target.outputRootCanonicalPath ||
      configured.device.toString(10) !== target.outputRootDevice ||
      configured.inode.toString(10) !== target.outputRootInode
    ) {
      throw new LearningArtifactPublishError();
    }
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      directoryPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    await handle.sync();
  } catch {
    throw new LearningArtifactPublishError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function captureDirectoryIdentity(
  directoryPath: string,
): Promise<PublicationDirectoryIdentity> {
  let handle: FileHandle | undefined;
  try {
    const initial = await lstat(directoryPath, { bigint: true });
    if (!initial.isDirectory() || initial.isSymbolicLink()) {
      throw new PublicationTargetPreparationError();
    }
    const canonicalPath = await realpath(directoryPath);
    const canonical = await lstat(canonicalPath, { bigint: true });
    if (
      !canonical.isDirectory() ||
      canonical.isSymbolicLink() ||
      canonical.dev !== initial.dev ||
      canonical.ino !== initial.ino
    ) {
      throw new PublicationTargetPreparationError();
    }
    handle = await open(
      canonicalPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isDirectory() ||
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino
    ) {
      throw new PublicationTargetPreparationError();
    }
    return { canonicalPath, device: initial.dev, inode: initial.ino };
  } catch (error) {
    if (error instanceof PublicationTargetPreparationError) {
      throw error;
    }
    throw new PublicationTargetPreparationError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertPublicationTargetParent(
  target: PublicationTarget,
): Promise<PublicationDirectoryIdentity> {
  const outputRoot = await captureDirectoryIdentity(target.outputRootCanonicalPath);
  if (
    outputRoot.canonicalPath !== target.outputRootCanonicalPath ||
    outputRoot.device.toString(10) !== target.outputRootDevice ||
    outputRoot.inode.toString(10) !== target.outputRootInode ||
    !isStrictDescendant(outputRoot.canonicalPath, target.targetCanonicalPath)
  ) {
    throw new LearningArtifactPublishError();
  }
  const parent = await captureDirectoryIdentity(dirname(target.targetCanonicalPath));
  if (
    parent.canonicalPath !== dirname(target.targetCanonicalPath) ||
    parent.device.toString(10) !== target.parentDevice ||
    parent.inode.toString(10) !== target.parentInode
  ) {
    throw new LearningArtifactPublishError();
  }
  return parent;
}

/** 仅接受 child path，禁止 root 本身、兄弟目录与 `..` 逃逸路径。 */
function isStrictDescendant(rootPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(rootPath, candidatePath);
  return (
    pathFromRoot !== "" &&
    !pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    pathFromRoot !== ".." &&
    !isAbsolute(pathFromRoot)
  );
}

/** Runtime Home 与 Output Root 不能彼此包含，避免私有状态成为可发布目标。 */
function pathsOverlap(first: string, second: string): boolean {
  return (
    first === second ||
    isStrictDescendant(first, second) ||
    isStrictDescendant(second, first)
  );
}

async function assertExistingTargetIsRegularOrMissing(
  targetCanonicalPath: string,
): Promise<void> {
  try {
    const metadata = await lstat(targetCanonicalPath, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new PublicationTargetPreparationError();
    }
    if ((await realpath(targetCanonicalPath)) !== targetCanonicalPath) {
      throw new PublicationTargetPreparationError();
    }
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return;
    }
    if (error instanceof PublicationTargetPreparationError) {
      throw error;
    }
    throw new PublicationTargetPreparationError();
  }
}

async function assertExistingTargetMatchesOrIsMissing(
  targetCanonicalPath: string,
  expected: Buffer,
  allowMissing = true,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    const pathMetadata = await lstat(targetCanonicalPath, { bigint: true });
    if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
      throw new LearningArtifactPublishError();
    }
    handle = await open(
      targetCanonicalPath,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== pathMetadata.dev ||
      opened.ino !== pathMetadata.ino ||
      (await realpath(targetCanonicalPath)) !== targetCanonicalPath
    ) {
      throw new LearningArtifactPublishError();
    }
    if (opened.size !== BigInt(expected.byteLength)) {
      throw new PublicationTargetConflictError();
    }
    const existing = await handle.readFile();
    if (
      !existing.equals(expected) ||
      hashBytes(existing) !== hashBytes(expected)
    ) {
      throw new PublicationTargetConflictError(hashBytes(existing));
    }
  } catch (error) {
    if (allowMissing && isErrorCode(error, "ENOENT")) {
      return;
    }
    if (error instanceof LearningArtifactPublishError) {
      throw error;
    }
    throw new LearningArtifactPublishError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isErrorCode(
  error: unknown,
  code: NodeJS.ErrnoException["code"],
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
