import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type {
  PersistedArtifact,
  PersistedSourceSnapshot,
} from "../domain/types.js";

export class ArtifactIntegrityError extends Error {
  public constructor() {
    super("私有内容寻址对象完整性校验失败");
    this.name = "ArtifactIntegrityError";
  }
}

/** 把不可变 payload 存入 Runtime Home 内的角色隔离内容寻址目录。 */
export class ContentAddressedArtifactStore {
  /** runtime 打开时已集中准备、供两个 store 共享的 canonical Runtime Home。 */
  readonly #runtimeHome: string;

  public constructor(runtimeHome: string) {
    this.#runtimeHome = runtimeHome;
  }

  public async putJson(
    value: unknown,
    mediaType: string,
    createdAt: string,
  ): Promise<PersistedArtifact> {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    const bytes = Buffer.from(content, "utf8");
    const sha256 = hashBytes(bytes);
    const runtimeHome = this.#runtimeHome;
    const prefixDirectory = await preparePrivateDirectoryChain(runtimeHome, [
      "artifacts",
      "sha256",
      sha256.slice(0, 2),
    ]);
    const absolutePath = join(prefixDirectory, `${sha256}.json`);
    await publishExactBytes(bytes, absolutePath);

    return {
      artifactId: `sha256:${sha256}`,
      sha256,
      mediaType,
      byteLength: bytes.byteLength,
      relativePath: relative(runtimeHome, absolutePath),
      createdAt,
    };
  }

  public async putSourceSnapshot(
    sourceBytes: Uint8Array,
    createdAt: string,
  ): Promise<PersistedSourceSnapshot> {
    try {
      // Source Snapshot 必须保存显式读取成功时得到的完整字节，不能保存摘录或
      // UTF-8 重编码结果；独立 identity 也避免与同 hash 的 JSON artifact 混淆角色。
      const bytes = Buffer.from(sourceBytes);
      const sha256 = hashBytes(bytes);
      const runtimeHome = this.#runtimeHome;
      const prefixDirectory = await preparePrivateDirectoryChain(runtimeHome, [
        "source-snapshots",
        "sha256",
        sha256.slice(0, 2),
      ]);
      const absolutePath = join(prefixDirectory, sha256);
      await publishExactBytes(bytes, absolutePath);

      return {
        snapshotId: `source-sha256:${sha256}`,
        sha256,
        mediaType: "text/plain; charset=utf-8",
        byteLength: bytes.byteLength,
        relativePath: relative(runtimeHome, absolutePath),
        createdAt,
      };
    } catch (error) {
      if (error instanceof ArtifactIntegrityError) {
        throw error;
      }
      throw new ArtifactIntegrityError();
    }
  }

}

async function preparePrivateDirectoryChain(
  canonicalParent: string,
  segments: readonly string[],
): Promise<string> {
  let parent = canonicalParent;
  for (const segment of segments) {
    const child = join(parent, segment);
    try {
      await mkdir(child, { mode: 0o700 });
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) {
        throw new ArtifactIntegrityError();
      }
    }
    const metadata = await lstat(child);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ArtifactIntegrityError();
    }
    await chmod(child, 0o700);
    const canonicalChild = await realpath(child);
    if (relative(parent, canonicalChild) !== segment) {
      throw new ArtifactIntegrityError();
    }
    parent = canonicalChild;
  }
  return parent;
}

async function publishExactBytes(
  bytes: Buffer,
  absolutePath: string,
): Promise<void> {
  const temporaryPath = join(
    resolve(absolutePath, ".."),
    `.snapshot-${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;

  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    const temporaryMetadata = await handle.stat({ bigint: true });
    if (
      !temporaryMetadata.isFile() ||
      temporaryMetadata.size !== BigInt(bytes.byteLength)
    ) {
      throw new ArtifactIntegrityError();
    }
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;

    try {
      // 同目录 hard-link 只在 final 不存在时原子发布；reader 看不到 temp 的半成品。
      await link(temporaryPath, absolutePath);
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) {
        throw new ArtifactIntegrityError();
      }
    }
    await verifyExistingBytes(absolutePath, bytes);
  } catch (error) {
    if (error instanceof ArtifactIntegrityError) {
      throw error;
    }
    throw new ArtifactIntegrityError();
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function verifyExistingBytes(
  absolutePath: string,
  expected: Buffer,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.size !== BigInt(expected.byteLength)) {
      throw new ArtifactIntegrityError();
    }
    const existing = await handle.readFile();
    if (
      !existing.equals(expected) ||
      hashBytes(existing) !== hashBytes(expected)
    ) {
      throw new ArtifactIntegrityError();
    }
    await handle.chmod(0o600);
  } catch (error) {
    if (error instanceof ArtifactIntegrityError) {
      throw error;
    }
    throw new ArtifactIntegrityError();
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
