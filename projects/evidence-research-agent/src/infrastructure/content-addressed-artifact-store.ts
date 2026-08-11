import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type { PersistedArtifact } from "../domain/types.js";

export class ArtifactIntegrityError extends Error {}

/** 把不可变 JSON payload 存入 Runtime Home 内的内容寻址目录。 */
export class ContentAddressedArtifactStore {
  /** artifact 私有路径与相对引用共同使用的规范 Runtime Home。 */
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
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const absolutePath = join(
      this.#runtimeHome,
      "artifacts",
      "sha256",
      sha256.slice(0, 2),
      `${sha256}.json`,
    );
    return this.#putExactBytes(bytes, absolutePath, mediaType, createdAt);
  }

  public async putSourceSnapshot(
    sourceBytes: Uint8Array,
    createdAt: string,
  ): Promise<PersistedArtifact> {
    // Source Snapshot 必须保存显式读取成功时得到的完整字节，不能保存摘录或
    // UTF-8 重新编码结果；否则同一 Evidence range 无法回到当时检查的精确版本。
    const bytes = Buffer.from(sourceBytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const absolutePath = join(
      this.#runtimeHome,
      "source-snapshots",
      "sha256",
      sha256.slice(0, 2),
      sha256,
    );
    return this.#putExactBytes(
      bytes,
      absolutePath,
      "text/plain; charset=utf-8",
      createdAt,
    );
  }

  async #putExactBytes(
    bytes: Buffer,
    absolutePath: string,
    mediaType: string,
    createdAt: string,
  ): Promise<PersistedArtifact> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await mkdir(dirname(absolutePath), { recursive: true });

    try {
      await writeFile(absolutePath, bytes, { flag: "wx" });
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      // 同一摘要应当永远映射到同一字节串；若磁盘内容不同，不能把损坏文件
      // 当成一次成功的幂等写入。
      const existing = await readFile(absolutePath);
      if (!existing.equals(bytes)) {
        throw new ArtifactIntegrityError(`artifact 内容与摘要冲突：${sha256}`);
      }
    }

    return {
      artifactId: `sha256:${sha256}`,
      sha256,
      mediaType,
      byteLength: bytes.byteLength,
      relativePath: relative(this.#runtimeHome, absolutePath),
      createdAt,
    };
  }
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
