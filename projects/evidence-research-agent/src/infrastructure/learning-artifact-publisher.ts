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
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

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
  /** 把调用方绝对路径绑定为 canonical target path 与 parent device/inode。 */
  public async prepareTarget(targetPath: string): Promise<PublicationTarget> {
    try {
      if (!isAbsolute(targetPath) || extname(targetPath).toLowerCase() !== ".md") {
        throw new PublicationTargetPreparationError();
      }
      const resolvedPath = resolve(targetPath);
      const targetName = basename(resolvedPath);
      if (targetName === "." || targetName === "..") {
        throw new PublicationTargetPreparationError();
      }
      const parent = await captureDirectoryIdentity(dirname(resolvedPath));
      const targetCanonicalPath = join(parent.canonicalPath, targetName);
      await assertExistingTargetIsRegularOrMissing(targetCanonicalPath);
      return {
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
  public async publish(target: PublicationTarget, markdown: string): Promise<void> {
    const expected = Buffer.from(markdown, "utf8");
    let temporaryPath: string | undefined;
    let handle: FileHandle | undefined;
    try {
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
      await handle.writeFile(expected);
      await handle.sync();
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile() || metadata.size !== BigInt(expected.byteLength)) {
        throw new LearningArtifactPublishError();
      }
      await handle.chmod(0o600);
      await handle.close();
      handle = undefined;

      await assertPublicationTargetParent(target);
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
      opened.size !== BigInt(expected.byteLength) ||
      (await realpath(targetCanonicalPath)) !== targetCanonicalPath
    ) {
      throw new LearningArtifactPublishError();
    }
    const existing = await handle.readFile();
    if (
      !existing.equals(expected) ||
      hashBytes(existing) !== hashBytes(expected)
    ) {
      throw new LearningArtifactPublishError();
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
