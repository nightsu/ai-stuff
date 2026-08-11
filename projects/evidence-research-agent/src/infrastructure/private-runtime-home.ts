import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import {
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

/** Runtime Home 无法在任何 store 打开前被安全规范化时抛出的稳定错误。 */
export class PrivateRuntimeHomeError extends Error {
  public constructor() {
    super("私有 Runtime Home 无法安全准备");
    this.name = "PrivateRuntimeHomeError";
  }
}

/**
 * 在 SQLite 与 Artifact Store 获得路径前，集中准备私有 Runtime Home。
 *
 * 已存在的 caller final path 必须是实际目录而非 symlink；缺失链从最近的
 * existing ancestor 的 realpath 开始逐段创建和复核，因此不会误拒绝 macOS
 * `/var`、`/tmp` 这类系统级父 symlink。Node 没有可贯穿 SQLite path open 的
 * portable dirfd/openat 边界；这里缩短并 fail closed 检测可观测 parent race，
 * 但不承诺抵抗同用户 hostile writer 在最后复核后的原子重命名。
 */
export function preparePrivateRuntimeHome(runtimeHome: string): string {
  const requestedPath = resolve(runtimeHome);

  try {
    const finalMetadata = tryLstat(requestedPath);
    if (finalMetadata !== undefined) {
      if (!finalMetadata.isDirectory() || finalMetadata.isSymbolicLink()) {
        throw new PrivateRuntimeHomeError();
      }
      return verifyAndTightenDirectory(requestedPath, finalMetadata);
    }

    const { canonicalParent, missingSegments } = findCreationBoundary(
      requestedPath,
    );
    let parent = canonicalParent;
    for (const segment of missingSegments) {
      const child = join(parent, segment);
      try {
        mkdirSync(child, { mode: 0o700 });
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) {
          throw error;
        }
      }
      const childMetadata = lstatSync(child, { bigint: true });
      if (!childMetadata.isDirectory() || childMetadata.isSymbolicLink()) {
        throw new PrivateRuntimeHomeError();
      }
      const canonicalChild = verifyAndTightenDirectory(child, childMetadata);
      if (!isDirectChild(parent, canonicalChild, segment)) {
        throw new PrivateRuntimeHomeError();
      }
      parent = canonicalChild;
    }
    return parent;
  } catch (error) {
    if (error instanceof PrivateRuntimeHomeError) {
      throw error;
    }
    throw new PrivateRuntimeHomeError();
  }
}

interface CreationBoundary {
  /** 最近 existing ancestor 经过 realpath 与 identity 复核后的目录。 */
  readonly canonicalParent: string;
  /** 从该 ancestor 到请求 final Runtime Home 的有序缺失路径段。 */
  readonly missingSegments: readonly string[];
}

function findCreationBoundary(requestedPath: string): CreationBoundary {
  const missingSegments: string[] = [];
  let candidate = requestedPath;

  for (;;) {
    const metadata = tryLstat(candidate);
    if (metadata !== undefined) {
      const canonicalParent = verifyExistingAncestor(candidate);
      return { canonicalParent, missingSegments };
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new PrivateRuntimeHomeError();
    }
    missingSegments.unshift(basename(candidate));
    candidate = parent;
  }
}

function verifyExistingAncestor(path: string): string {
  const canonicalPath = realpathSync(path);
  const followedMetadata = statSync(path, { bigint: true });
  const canonicalMetadata = lstatSync(canonicalPath, { bigint: true });
  if (
    !followedMetadata.isDirectory() ||
    !canonicalMetadata.isDirectory() ||
    canonicalMetadata.isSymbolicLink() ||
    !sameIdentity(followedMetadata, canonicalMetadata) ||
    realpathSync(path) !== canonicalPath
  ) {
    throw new PrivateRuntimeHomeError();
  }
  return canonicalPath;
}

function verifyAndTightenDirectory(
  path: string,
  pathMetadata: BigIntStats,
): string {
  const canonicalPath = realpathSync(path);
  const canonicalMetadata = lstatSync(canonicalPath, { bigint: true });
  if (
    !canonicalMetadata.isDirectory() ||
    canonicalMetadata.isSymbolicLink() ||
    !sameIdentity(pathMetadata, canonicalMetadata)
  ) {
    throw new PrivateRuntimeHomeError();
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      canonicalPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const openedMetadata = fstatSync(descriptor, { bigint: true });
    if (
      !openedMetadata.isDirectory() ||
      !sameIdentity(pathMetadata, openedMetadata)
    ) {
      throw new PrivateRuntimeHomeError();
    }
    fchmodSync(descriptor, 0o700);
    const tightenedMetadata = fstatSync(descriptor, { bigint: true });
    if (
      !tightenedMetadata.isDirectory() ||
      !sameIdentity(pathMetadata, tightenedMetadata)
    ) {
      throw new PrivateRuntimeHomeError();
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }

  const finalMetadata = lstatSync(path, { bigint: true });
  if (
    !finalMetadata.isDirectory() ||
    finalMetadata.isSymbolicLink() ||
    !sameIdentity(pathMetadata, finalMetadata) ||
    realpathSync(path) !== canonicalPath
  ) {
    throw new PrivateRuntimeHomeError();
  }
  return canonicalPath;
}

function tryLstat(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENOTDIR")) {
      return undefined;
    }
    throw error;
  }
}

function isDirectChild(
  canonicalParent: string,
  canonicalChild: string,
  segment: string,
): boolean {
  const childRelative = relative(canonicalParent, canonicalChild);
  return (
    !isAbsolute(childRelative) &&
    childRelative === segment &&
    !segment.includes("/") &&
    !segment.includes("\\")
  );
}

function sameIdentity(
  left: Pick<BigIntStats, "dev" | "ino">,
  right: Pick<BigIntStats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isErrorCode(
  error: unknown,
  code: NodeJS.ErrnoException["code"],
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
