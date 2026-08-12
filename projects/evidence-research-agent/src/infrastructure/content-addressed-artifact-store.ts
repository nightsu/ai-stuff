import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type {
  ArtifactReference,
  PersistedArtifact,
  PersistedSourceSnapshot,
  SourceSnapshotReference,
} from "../domain/types.js";

export class ArtifactIntegrityError extends Error {
  public constructor() {
    super("私有内容寻址对象完整性校验失败");
    this.name = "ArtifactIntegrityError";
  }
}

/** Source Snapshot 原子发布边界的可选生产中立协调回调。 */
export interface ArtifactStoreLifecycleHooks {
  /** snapshot prefix 已准备完成、创建同目录临时文件前运行。 */
  readonly afterSourceSnapshotDirectoryPreparation?: () =>
    | void
    | Promise<void>;
  /** Markdown draft prefix 已准备完成、创建同目录临时文件前运行。 */
  readonly beforeMarkdownArtifactWrite?: () => void | Promise<void>;
}

/** 一段 canonical 私有目录在准备时捕获的文件系统 identity。 */
interface PrivateDirectoryIdentity {
  /** 该目录准备时的 canonical 绝对路径。 */
  readonly canonicalPath: string;
  /** 目录设备号；只在当前基础设施调用内以内存 bigint 保存。 */
  readonly device: bigint;
  /** 目录 inode；只在当前基础设施调用内以内存 bigint 保存。 */
  readonly inode: bigint;
}

/** 已准备的最终目录及从 Runtime Home 到它的完整 identity chain。 */
interface PreparedPrivateDirectoryChain {
  /** chain 最末端、可用于构造临时与最终对象路径的 canonical 目录。 */
  readonly directory: string;
  /** 按父到子顺序捕获的 Runtime Home 与每个 namespace 段 identity。 */
  readonly identities: readonly PrivateDirectoryIdentity[];
}

/** 把不可变 payload 存入 Runtime Home 内的角色隔离内容寻址目录。 */
export class ContentAddressedArtifactStore {
  /** runtime 打开时已集中准备、供两个 store 共享的 canonical Runtime Home。 */
  readonly #runtimeHome: string;
  /** 默认不执行动作的 Source Snapshot 生命周期协调边界。 */
  readonly #hooks: ArtifactStoreLifecycleHooks;

  public constructor(
    runtimeHome: string,
    hooks: ArtifactStoreLifecycleHooks = {},
  ) {
    this.#runtimeHome = runtimeHome;
    this.#hooks = Object.freeze({ ...hooks });
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
    const prefixChain = await preparePrivateDirectoryChain(runtimeHome, [
      "artifacts",
      "sha256",
      sha256.slice(0, 2),
    ]);
    const absolutePath = join(prefixChain.directory, `${sha256}.json`);
    await publishExactBytes(bytes, absolutePath, prefixChain);

    return {
      artifactId: `sha256:${sha256}`,
      sha256,
      mediaType,
      byteLength: bytes.byteLength,
      relativePath: relative(runtimeHome, absolutePath),
      createdAt,
    };
  }

  /** 从已验证 registry 引用读取 JSON artifact；不会接受调用方任意相对路径。 */
  public async readJson(reference: ArtifactReference): Promise<unknown> {
    if (
      reference.mediaType !== "application/json" ||
      reference.relativePath !==
        `artifacts/sha256/${reference.sha256.slice(0, 2)}/${reference.sha256}.json`
    ) {
      throw new ArtifactIntegrityError();
    }
    const absolutePath = join(this.#runtimeHome, reference.relativePath);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        absolutePath,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile() || metadata.size !== BigInt(reference.byteLength)) {
        throw new ArtifactIntegrityError();
      }
      const bytes = await handle.readFile();
      if (hashBytes(bytes) !== reference.sha256) {
        throw new ArtifactIntegrityError();
      }
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      if (error instanceof ArtifactIntegrityError) {
        throw error;
      }
      throw new ArtifactIntegrityError();
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** 把经过 Evidence Gate 的精确 Markdown draft 写入通用私有 artifact namespace。 */
  public async putMarkdown(
    markdown: string,
    createdAt: string,
  ): Promise<PersistedArtifact> {
    const bytes = Buffer.from(markdown, "utf8");
    const sha256 = hashBytes(bytes);
    const runtimeHome = this.#runtimeHome;
    const prefixChain = await preparePrivateDirectoryChain(runtimeHome, [
      "artifacts",
      "sha256",
      sha256.slice(0, 2),
    ]);
    await this.#hooks.beforeMarkdownArtifactWrite?.();
    const absolutePath = join(prefixChain.directory, `${sha256}.md`);
    await publishExactBytes(bytes, absolutePath, prefixChain);

    return {
      artifactId: `sha256:${sha256}`,
      sha256,
      mediaType: "text/markdown; charset=utf-8",
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
      const prefixChain = await preparePrivateDirectoryChain(runtimeHome, [
        "source-snapshots",
        "sha256",
        sha256.slice(0, 2),
      ]);
      await this.#hooks.afterSourceSnapshotDirectoryPreparation?.();
      const absolutePath = join(prefixChain.directory, sha256);
      await publishExactBytes(bytes, absolutePath, prefixChain);

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

  /**
   * 从 Journal/registry 已验证引用读取完整 Source Snapshot bytes。调用方只能按
   * content identity 取回对象，不能提供任意 Runtime Home 相对路径。
   */
  public async readSourceSnapshot(
    reference: SourceSnapshotReference,
  ): Promise<Buffer> {
    if (
      reference.snapshotId !== `source-sha256:${reference.sha256}` ||
      reference.mediaType !== "text/plain; charset=utf-8" ||
      reference.relativePath !==
        `source-snapshots/sha256/${reference.sha256.slice(0, 2)}/${reference.sha256}`
    ) {
      throw new ArtifactIntegrityError();
    }
    const absolutePath = join(this.#runtimeHome, reference.relativePath);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        absolutePath,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile() || metadata.size !== BigInt(reference.byteLength)) {
        throw new ArtifactIntegrityError();
      }
      const bytes = await handle.readFile();
      if (hashBytes(bytes) !== reference.sha256) {
        throw new ArtifactIntegrityError();
      }
      return bytes;
    } catch (error) {
      if (error instanceof ArtifactIntegrityError) throw error;
      throw new ArtifactIntegrityError();
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

async function preparePrivateDirectoryChain(
  canonicalParent: string,
  segments: readonly string[],
): Promise<PreparedPrivateDirectoryChain> {
  let parent = canonicalParent;
  const identities: PrivateDirectoryIdentity[] = [
    await capturePrivateDirectoryIdentity(canonicalParent, false),
  ];
  for (const segment of segments) {
    const child = join(parent, segment);
    try {
      await mkdir(child, { mode: 0o700 });
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) {
        throw new ArtifactIntegrityError();
      }
    }
    const identity = await capturePrivateDirectoryIdentity(child, true);
    if (relative(parent, identity.canonicalPath) !== segment) {
      throw new ArtifactIntegrityError();
    }
    identities.push(identity);
    parent = identity.canonicalPath;
  }
  return { directory: parent, identities };
}

async function publishExactBytes(
  bytes: Buffer,
  absolutePath: string,
  directoryChain: PreparedPrivateDirectoryChain,
): Promise<void> {
  const temporaryPath = join(
    dirname(absolutePath),
    `.snapshot-${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;

  try {
    await assertPrivateDirectoryChain(directoryChain);
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

    await assertPrivateDirectoryChain(directoryChain);
    try {
      // 同目录 hard-link 只在 final 不存在时原子发布，确保 reader 永远看不到
      // 半成品；它解决 publication visibility，不等同于 openat 级原子 containment。
      await link(temporaryPath, absolutePath);
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) {
        throw new ArtifactIntegrityError();
      }
    }
    await assertPrivateDirectoryChain(directoryChain);
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

async function capturePrivateDirectoryIdentity(
  path: string,
  tightenMode: boolean,
): Promise<PrivateDirectoryIdentity> {
  let handle: FileHandle | undefined;
  try {
    const pathMetadata = await lstat(path, { bigint: true });
    if (!pathMetadata.isDirectory() || pathMetadata.isSymbolicLink()) {
      throw new ArtifactIntegrityError();
    }
    const canonicalPath = await realpath(path);
    const canonicalMetadata = await lstat(canonicalPath, { bigint: true });
    if (
      !canonicalMetadata.isDirectory() ||
      canonicalMetadata.isSymbolicLink() ||
      canonicalMetadata.dev !== pathMetadata.dev ||
      canonicalMetadata.ino !== pathMetadata.ino
    ) {
      throw new ArtifactIntegrityError();
    }

    handle = await open(
      canonicalPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const openedMetadata = await handle.stat({ bigint: true });
    if (
      !openedMetadata.isDirectory() ||
      openedMetadata.dev !== pathMetadata.dev ||
      openedMetadata.ino !== pathMetadata.ino
    ) {
      throw new ArtifactIntegrityError();
    }
    if (tightenMode) {
      await handle.chmod(0o700);
    }
    const finalMetadata = await handle.stat({ bigint: true });
    const finalPathMetadata = await lstat(path, { bigint: true });
    if (
      !finalMetadata.isDirectory() ||
      finalMetadata.dev !== pathMetadata.dev ||
      finalMetadata.ino !== pathMetadata.ino ||
      !finalPathMetadata.isDirectory() ||
      finalPathMetadata.isSymbolicLink() ||
      finalPathMetadata.dev !== pathMetadata.dev ||
      finalPathMetadata.ino !== pathMetadata.ino ||
      (await realpath(path)) !== canonicalPath
    ) {
      throw new ArtifactIntegrityError();
    }
    return {
      canonicalPath,
      device: pathMetadata.dev,
      inode: pathMetadata.ino,
    };
  } catch (error) {
    if (error instanceof ArtifactIntegrityError) {
      throw error;
    }
    throw new ArtifactIntegrityError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertPrivateDirectoryChain(
  chain: PreparedPrivateDirectoryChain,
): Promise<void> {
  // Runtime Home 已是 0700，namespace 每段也收紧到 0700；这建立 trusted
  // same-user 边界。Node path API 没有 portable openat，故临时文件 open/link
  // 前后复核 identity 会 fail closed 报告可观测替换，但不宣称敌对重命名原子隔离。
  for (const identity of chain.identities) {
    let handle: FileHandle | undefined;
    try {
      const pathMetadata = await lstat(identity.canonicalPath, {
        bigint: true,
      });
      if (
        !pathMetadata.isDirectory() ||
        pathMetadata.isSymbolicLink() ||
        pathMetadata.dev !== identity.device ||
        pathMetadata.ino !== identity.inode ||
        (await realpath(identity.canonicalPath)) !== identity.canonicalPath
      ) {
        throw new ArtifactIntegrityError();
      }
      handle = await open(
        identity.canonicalPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const openedMetadata = await handle.stat({ bigint: true });
      if (
        !openedMetadata.isDirectory() ||
        openedMetadata.dev !== identity.device ||
        openedMetadata.ino !== identity.inode
      ) {
        throw new ArtifactIntegrityError();
      }
    } catch (error) {
      if (error instanceof ArtifactIntegrityError) {
        throw error;
      }
      throw new ArtifactIntegrityError();
    } finally {
      await handle?.close().catch(() => undefined);
    }
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
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
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
