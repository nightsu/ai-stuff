import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactIntegrityError,
  ContentAddressedArtifactStore,
} from "../../src/infrastructure/content-addressed-artifact-store.js";
import { preparePrivateRuntimeHome } from "../../src/infrastructure/private-runtime-home.js";

const temporaryDirectories: string[] = [];
const createdAt = "2026-08-12T08:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("private Source Snapshot store", () => {
  it("uses a dedicated identity and private directory and file modes", async () => {
    const runtimeHome = await createRuntimeHome();
    const bytes = Buffer.from("private source\n", "utf8");
    const store = new ContentAddressedArtifactStore(runtimeHome);

    const snapshot = await store.putSourceSnapshot(bytes, createdAt);

    expect(snapshot).toEqual({
      snapshotId: `source-sha256:${snapshot.sha256}`,
      sha256: snapshot.sha256,
      mediaType: "text/plain; charset=utf-8",
      byteLength: bytes.byteLength,
      relativePath: snapshot.relativePath,
      createdAt,
    });
    expect(snapshot).not.toHaveProperty("artifactId");
    await expect(modeOf(runtimeHome)).resolves.toBe(0o700);
    await expect(modeOf(join(runtimeHome, "source-snapshots"))).resolves.toBe(
      0o700,
    );
    await expect(
      modeOf(join(runtimeHome, "source-snapshots", "sha256")),
    ).resolves.toBe(0o700);
    await expect(
      modeOf(join(runtimeHome, snapshot.relativePath)),
    ).resolves.toBe(0o600);
  });

  it("rejects a symlinked snapshot namespace without writing outside Runtime Home", async () => {
    const runtimeHome = await createRuntimeHome();
    const outside = await createTemporaryDirectory("snapshot-outside-");
    await symlink(outside, join(runtimeHome, "source-snapshots"), "dir");
    const store = new ContentAddressedArtifactStore(runtimeHome);

    await expect(
      store.putSourceSnapshot(Buffer.from("private source\n"), createdAt),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("rejects a final symlink even when its target has identical bytes", async () => {
    const runtimeHome = await createRuntimeHome();
    const outside = await createTemporaryDirectory("snapshot-outside-");
    const bytes = Buffer.from("identical outside bytes\n", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const prefixDirectory = join(
      runtimeHome,
      "source-snapshots",
      "sha256",
      sha256.slice(0, 2),
    );
    await mkdir(prefixDirectory, { recursive: true });
    const outsideFile = join(outside, "outside.txt");
    await writeFile(outsideFile, bytes);
    await symlink(outsideFile, join(prefixDirectory, sha256));
    const store = new ContentAddressedArtifactStore(runtimeHome);

    await expect(store.putSourceSnapshot(bytes, createdAt)).rejects.toBeInstanceOf(
      ArtifactIntegrityError,
    );
    await expect(readFile(outsideFile)).resolves.toEqual(bytes);
  });

  it("publishes concurrent identical writes once and removes every temp file", async () => {
    const runtimeHome = await createRuntimeHome();
    const bytes = Buffer.from("concurrent exact bytes\n", "utf8");
    const store = new ContentAddressedArtifactStore(runtimeHome);

    const snapshots = await Promise.all(
      Array.from({ length: 12 }, () =>
        store.putSourceSnapshot(bytes, createdAt),
      ),
    );

    expect(new Set(snapshots.map((snapshot) => snapshot.snapshotId))).toEqual(
      new Set([snapshots[0]?.snapshotId]),
    );
    const first = snapshots[0];
    if (first === undefined) {
      throw new Error("测试要求至少一个 Source Snapshot");
    }
    await expect(readFile(join(runtimeHome, first.relativePath))).resolves.toEqual(
      bytes,
    );
    const prefixDirectory = join(runtimeHome, first.relativePath, "..");
    expect(await readdir(prefixDirectory)).toEqual([first.sha256]);
  });

  it("tightens an existing valid snapshot and its directories on reuse", async () => {
    const runtimeHome = await createRuntimeHome();
    const bytes = Buffer.from("reused exact bytes\n", "utf8");
    const store = new ContentAddressedArtifactStore(runtimeHome);
    const first = await store.putSourceSnapshot(bytes, createdAt);
    const absolutePath = join(runtimeHome, first.relativePath);
    const prefixDirectory = join(absolutePath, "..");
    await Promise.all([
      chmod(join(runtimeHome, "source-snapshots"), 0o755),
      chmod(prefixDirectory, 0o755),
      chmod(absolutePath, 0o644),
    ]);

    await store.putSourceSnapshot(bytes, createdAt);

    await expect(modeOf(runtimeHome)).resolves.toBe(0o700);
    await expect(modeOf(join(runtimeHome, "source-snapshots"))).resolves.toBe(
      0o700,
    );
    await expect(modeOf(prefixDirectory)).resolves.toBe(0o700);
    await expect(modeOf(absolutePath)).resolves.toBe(0o600);
  });

  it("normalizes a non-directory namespace failure to an integrity error", async () => {
    const runtimeHome = await createRuntimeHome();
    await writeFile(join(runtimeHome, "source-snapshots"), "not a directory");
    const store = new ContentAddressedArtifactStore(runtimeHome);

    await expect(
      store.putSourceSnapshot(Buffer.from("private source\n"), createdAt),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it(
    "rejects an existing FIFO snapshot object without blocking on open",
    async () => {
      const runtimeHome = await createRuntimeHome();
      const bytes = Buffer.from("fifo collision\n", "utf8");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const prefixDirectory = join(
        runtimeHome,
        "source-snapshots",
        "sha256",
        sha256.slice(0, 2),
      );
      await mkdir(prefixDirectory, { recursive: true });
      const fifoPath = join(prefixDirectory, sha256);
      execFileSync("mkfifo", [fifoPath]);
      const store = new ContentAddressedArtifactStore(runtimeHome);
      let unblockWriter: Promise<void> | undefined;
      const unblockTimer = setTimeout(() => {
        unblockWriter = open(
          fifoPath,
          constants.O_WRONLY | constants.O_NONBLOCK,
        )
          .then((handle) => handle.close())
          .catch(() => undefined);
      }, 300);
      const startedAt = performance.now();

      try {
        await expect(
          store.putSourceSnapshot(bytes, createdAt),
        ).rejects.toBeInstanceOf(ArtifactIntegrityError);
      } finally {
        clearTimeout(unblockTimer);
        await unblockWriter;
      }

      expect(performance.now() - startedAt).toBeLessThan(200);
    },
    2_000,
  );

  it("rejects a snapshot prefix replaced after preparation and cleans temp files", async () => {
    const runtimeHome = await createRuntimeHome();
    const outside = await createTemporaryDirectory("snapshot-outside-");
    const bytes = Buffer.from("prefix identity race\n", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const prefixDirectory = join(
      runtimeHome,
      "source-snapshots",
      "sha256",
      sha256.slice(0, 2),
    );
    const displacedPrefix = join(runtimeHome, "displaced-prefix");
    const store = new ContentAddressedArtifactStore(runtimeHome, {
      afterSourceSnapshotDirectoryPreparation: async () => {
        await rename(prefixDirectory, displacedPrefix);
        await symlink(outside, prefixDirectory, "dir");
      },
    });

    await expect(store.putSourceSnapshot(bytes, createdAt)).rejects.toBeInstanceOf(
      ArtifactIntegrityError,
    );
    await expect(readdir(outside)).resolves.toEqual([]);
    await expect(readdir(displacedPrefix)).resolves.toEqual([]);
  });
});

async function createRuntimeHome(): Promise<string> {
  return preparePrivateRuntimeHome(
    await createTemporaryDirectory("snapshot-runtime-"),
  );
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}
