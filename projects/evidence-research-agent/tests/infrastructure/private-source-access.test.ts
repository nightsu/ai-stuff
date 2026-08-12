import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SourceScope } from "../../src/domain/types.js";
import {
  ArtifactIntegrityError,
  ContentAddressedArtifactStore,
} from "../../src/infrastructure/content-addressed-artifact-store.js";
import { preparePrivateRuntimeHome } from "../../src/infrastructure/private-runtime-home.js";
import {
  MAX_SOURCE_LINE_WINDOW,
  PrivateSourceAccess,
  canonicalizeSourceScope,
} from "../../src/infrastructure/private-source-access.js";
import type { ReadSourceRequest } from "../../src/infrastructure/private-source-access.js";

const temporaryDirectories: string[] = [];
const createdAt = "2026-08-12T08:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("PrivateSourceAccess", () => {
  it("captures an inclusive UTF-8 excerpt but snapshots the exact complete file", async () => {
    const fixture = await createFixture();
    const original = Buffer.from(
      "heading\n第一行🙂\nthird line\r\nfourth line\nfifth line\n",
      "utf8",
    );
    await writeFile(join(fixture.approvedRoot, "notes.md"), original);

    const request: ReadSourceRequest = {
      rootIndex: 0,
      relativePath: "notes.md",
      startLine: 2,
      endLine: 3,
    };
    const preflight = await fixture.access.preflight(request, 2_000);
    expect(preflight).toEqual({
      status: "approved",
      rootIndex: 0,
      relativePath: "notes.md",
      startLine: 2,
      endLine: 3,
      byteLength: original.byteLength,
    });
    await expect(snapshotFiles(fixture.runtimeHome)).resolves.toEqual([]);

    const captured = await fixture.access.capture(request, 2_000);
    expect(captured).toMatchObject({
      status: "captured",
      rootIndex: 0,
      relativePath: "notes.md",
      startLine: 2,
      endLine: 3,
      excerpt: "第一行🙂\nthird line",
      totalLines: 5,
      byteLength: original.byteLength,
    });
    if (captured.status !== "captured") {
      throw new Error("测试要求读取通过 Source Scope");
    }
    expect(captured.fullBytes).toEqual(original);
    // Byte capture 仍没有 Artifact Store 权限；只有下面的显式调用才可落盘。
    await expect(snapshotFiles(fixture.runtimeHome)).resolves.toEqual([]);

    const snapshot = await fixture.artifacts.putSourceSnapshot(
      captured.fullBytes,
      createdAt,
    );
    expect(snapshot).toMatchObject({
      snapshotId: `source-sha256:${snapshot.sha256}`,
      mediaType: "text/plain; charset=utf-8",
      byteLength: original.byteLength,
      createdAt,
    });
    expect(snapshot.relativePath).toMatch(
      /^source-snapshots\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/,
    );
    await expect(
      readFile(join(fixture.runtimeHome, snapshot.relativePath)),
    ).resolves.toEqual(original);
  });

  it("reuses identical source bytes and gives changed bytes a new identity", async () => {
    const fixture = await createFixture();
    const firstBytes = Buffer.from("same exact bytes\n", "utf8");
    const changedBytes = Buffer.from("changed exact bytes\n", "utf8");

    const first = await fixture.artifacts.putSourceSnapshot(
      firstBytes,
      createdAt,
    );
    const identical = await fixture.artifacts.putSourceSnapshot(
      Buffer.from(firstBytes),
      "2026-08-12T09:00:00.000Z",
    );
    const changed = await fixture.artifacts.putSourceSnapshot(
      changedBytes,
      createdAt,
    );

    expect(identical.sha256).toBe(first.sha256);
    expect(identical.relativePath).toBe(first.relativePath);
    expect(changed.sha256).not.toBe(first.sha256);
    expect(changed.relativePath).not.toBe(first.relativePath);
    await expect(
      readFile(join(fixture.runtimeHome, first.relativePath)),
    ).resolves.toEqual(firstBytes);
    await expect(
      readFile(join(fixture.runtimeHome, changed.relativePath)),
    ).resolves.toEqual(changedBytes);

    await writeFile(
      join(fixture.runtimeHome, first.relativePath),
      "corrupted snapshot",
      "utf8",
    );
    await expect(
      fixture.artifacts.putSourceSnapshot(firstBytes, createdAt),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it("leaves an existing snapshot namespace unchanged after a denial", async () => {
    const fixture = await createFixture();
    const seedBytes = Buffer.from("already captured\n", "utf8");
    const existing = await fixture.artifacts.putSourceSnapshot(
      seedBytes,
      createdAt,
    );
    const before = await snapshotFiles(fixture.runtimeHome);

    await expect(
      fixture.access.capture(
        {
          rootIndex: 0,
          relativePath: ".env",
          startLine: 1,
          endLine: 1,
        },
        2_000,
      ),
    ).resolves.toEqual({ status: "denied", code: "secret_path" });

    await expect(snapshotFiles(fixture.runtimeHome)).resolves.toEqual(before);
    await expect(
      readFile(join(fixture.runtimeHome, existing.relativePath)),
    ).resolves.toEqual(seedBytes);
  });

  it.each([
    ".envrc.md",
    ".environment.md",
    ".env-local.md",
    "config/.envrc.md",
    "config/.environment.md",
    "config/.env-local.md",
    "config/.ENVRC.md",
  ])(
    "denies the complete case-normalized .env* basename pattern for %s",
    async (relativePath) => {
      const fixture = await createFixture();
      await writeFile(
        join(fixture.approvedRoot, relativePath),
        "TOKEN=secret\n",
        "utf8",
      );
      const before = await snapshotFiles(fixture.runtimeHome);

      await expect(
        fixture.access.capture(
          {
            rootIndex: 0,
            relativePath,
            startLine: 1,
            endLine: 1,
          },
          2_000,
        ),
      ).resolves.toEqual({ status: "denied", code: "secret_path" });
      await expect(snapshotFiles(fixture.runtimeHome)).resolves.toEqual(before);
    },
  );

  it("allows environment.md without the leading secret dot", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.approvedRoot, "environment.md"),
      "ordinary environment documentation\n",
      "utf8",
    );

    const captured = await fixture.access.capture(
      {
        rootIndex: 0,
        relativePath: "environment.md",
        startLine: 1,
        endLine: 1,
      },
      2_000,
    );

    expect(captured).toMatchObject({
      status: "captured",
      relativePath: "environment.md",
      excerpt: "ordinary environment documentation",
    });
    await expect(snapshotFiles(fixture.runtimeHome)).resolves.toEqual([]);
  });

  it.each([
    {
      name: "absolute path",
      path: (fixture: Fixture) => join(fixture.outsideRoot, "outside.md"),
      expected: { status: "denied", code: "invalid_path" },
    },
    {
      name: "parent traversal",
      path: () => "../outside/outside.md",
      expected: { status: "denied", code: "path_escape" },
    },
    {
      name: "normalizing traversal",
      path: () => "nested/../notes.md",
      expected: { status: "denied", code: "path_escape" },
    },
    {
      name: "symlink escape",
      path: () => "linked-outside.md",
      expected: { status: "denied", code: "symlink_path" },
    },
    {
      name: "excluded directory",
      path: () => "excluded/hidden.md",
      expected: { status: "denied", code: "excluded_path" },
    },
    {
      name: "excluded canonical target through an in-root symlink",
      path: () => "hidden-alias.md",
      expected: { status: "denied", code: "symlink_path" },
    },
    {
      name: "dotenv secret",
      path: () => ".env",
      expected: { status: "denied", code: "secret_path" },
    },
    {
      name: "private key before allowed extension",
      path: () => "private.pem",
      expected: { status: "denied", code: "secret_path" },
    },
    {
      name: "credential config",
      path: () => "config/credentials.json",
      expected: { status: "denied", code: "secret_path" },
    },
    {
      name: "uppercase extension",
      path: () => "UPPER.MD",
      expected: { status: "denied", code: "extension_not_allowed" },
    },
    {
      name: "unapproved extension",
      path: () => "plain.txt",
      expected: { status: "denied", code: "extension_not_allowed" },
    },
    {
      name: "invalid UTF-8",
      path: () => "invalid.bin",
      expected: { status: "denied", code: "binary_file" },
    },
    {
      name: "NUL-containing binary",
      path: () => "nul.bin",
      expected: { status: "denied", code: "binary_file" },
    },
    {
      name: "oversized file",
      path: () => "oversized.md",
      expected: { status: "denied", code: "file_too_large" },
    },
    {
      name: "directory rather than regular file",
      path: () => "directory.md",
      expected: { status: "failed", code: "source_not_file" },
    },
    {
      name: "missing file",
      path: () => "missing.md",
      expected: { status: "failed", code: "source_not_found" },
    },
  ])("fails closed for $name without adding a snapshot", async ({ path, expected }) => {
    const fixture = await createFixture();
    const before = await snapshotFiles(fixture.runtimeHome);

    const result = await fixture.access.capture(
      {
        rootIndex: 0,
        relativePath: path(fixture),
        startLine: 1,
        endLine: 2,
      },
      2_000,
    );

    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain(fixture.baseDirectory);
    await expect(snapshotFiles(fixture.runtimeHome)).resolves.toEqual(before);
  });

  it.each([
    {
      name: "unknown root index",
      request: { rootIndex: 2, startLine: 1, endLine: 1 },
      remainingBytes: 2_000,
      expected: { status: "denied", code: "invalid_root" },
    },
    {
      name: "non-integer root index",
      request: { rootIndex: 0.5, startLine: 1, endLine: 1 },
      remainingBytes: 2_000,
      expected: { status: "denied", code: "invalid_root" },
    },
    {
      name: "zero-based line",
      request: { rootIndex: 0, startLine: 0, endLine: 1 },
      remainingBytes: 2_000,
      expected: { status: "denied", code: "invalid_line_range" },
    },
    {
      name: "reversed line range",
      request: { rootIndex: 0, startLine: 2, endLine: 1 },
      remainingBytes: 2_000,
      expected: { status: "denied", code: "invalid_line_range" },
    },
    {
      name: "line range larger than the Harness window",
      request: {
        rootIndex: 0,
        startLine: 1,
        endLine: MAX_SOURCE_LINE_WINDOW + 1,
      },
      remainingBytes: 2_000,
      expected: { status: "denied", code: "line_range_too_large" },
    },
    {
      name: "remaining source-byte budget",
      request: { rootIndex: 0, startLine: 1, endLine: 1 },
      remainingBytes: 4,
      expected: { status: "denied", code: "source_budget_exceeded" },
    },
  ])("enforces $name without silently rewriting the request", async ({
    request,
    remainingBytes,
    expected,
  }) => {
    const fixture = await createFixture();
    const result = await fixture.access.capture(
      { relativePath: "notes.md", ...request },
      remainingBytes,
    );

    expect(result).toEqual(expected);
    await expect(snapshotFiles(fixture.runtimeHome)).resolves.toEqual([]);
  });

  it("returns a stable failure when the selected approved root is unavailable", async () => {
    const fixture = await createFixture();
    const unavailable = new PrivateSourceAccess({
      ...fixture.scope,
      roots: [
        {
          canonicalPath: join(fixture.baseDirectory, "does-not-exist"),
          device: "0",
          inode: "0",
        },
      ],
    });

    const result = await unavailable.capture(
      {
        rootIndex: 0,
        relativePath: "notes.md",
        startLine: 1,
        endLine: 1,
      },
      2_000,
    );

    expect(result).toEqual({ status: "failed", code: "root_changed" });
    expect(JSON.stringify(result)).not.toContain(fixture.baseDirectory);
    await expect(snapshotFiles(fixture.runtimeHome)).resolves.toEqual([]);
  });

  it("selects only the requested approved root and returns its normalized index", async () => {
    const fixture = await createFixture();
    const secondRoot = join(fixture.baseDirectory, "approved-second");
    await mkdir(secondRoot);
    await writeFile(join(secondRoot, "second.md"), "second root\n", "utf8");
    const access = new PrivateSourceAccess(
      await canonicalizeSourceScope({
        ...fixture.scope,
        roots: [fixture.approvedRoot, secondRoot],
      }),
    );

    const result = await access.capture(
      {
        rootIndex: 1,
        relativePath: "./nested/../second.md",
        startLine: 1,
        endLine: 1,
      },
      2_000,
    );

    expect(result).toEqual({ status: "denied", code: "path_escape" });

    const approved = await access.capture(
      {
        rootIndex: 1,
        relativePath: "second.md",
        startLine: 1,
        endLine: 1,
      },
      2_000,
    );
    expect(approved).toMatchObject({
      status: "captured",
      rootIndex: 1,
      relativePath: "second.md",
      excerpt: "second root",
    });
  });

  it("does not let later caller mutation expand the approved Source Scope", async () => {
    const fixture = await createFixture();
    const roots = [fixture.scope.roots[0]!];
    const allowedExtensions = [".md"];
    const access = new PrivateSourceAccess({
      ...fixture.scope,
      roots,
      allowedExtensions,
    });

    const outsideScope = await canonicalizeSourceScope({
      ...fixture.scope,
      roots: [fixture.outsideRoot],
    });
    roots.push(outsideScope.roots[0]!);
    allowedExtensions.push(".txt");

    await expect(
      access.capture(
        {
          rootIndex: 1,
          relativePath: "outside.md",
          startLine: 1,
          endLine: 1,
        },
        2_000,
      ),
    ).resolves.toEqual({ status: "denied", code: "invalid_root" });
    await expect(
      access.capture(
        {
          rootIndex: 0,
          relativePath: "plain.txt",
          startLine: 1,
          endLine: 1,
        },
        2_000,
      ),
    ).resolves.toEqual({
      status: "denied",
      code: "extension_not_allowed",
    });
  });

  it("enforces maxTotalBytes even when the caller passes a larger remaining budget", async () => {
    const fixture = await createFixture();
    const access = new PrivateSourceAccess({
      ...fixture.scope,
      maxTotalBytes: 4,
    });

    await expect(
      access.capture(
        {
          rootIndex: 0,
          relativePath: "notes.md",
          startLine: 1,
          endLine: 1,
        },
        2_000,
      ),
    ).resolves.toEqual({
      status: "denied",
      code: "source_budget_exceeded",
    });
  });

  it.each([
    ["start after EOF", "notes.md", 2, 2],
    ["end after EOF", "notes.md", 1, 2],
    ["empty file has no first line", "empty.md", 1, 1],
  ])("denies an out-of-bounds line range for %s", async (_name, path, startLine, endLine) => {
    const fixture = await createFixture();
    await writeFile(join(fixture.approvedRoot, "empty.md"), Buffer.alloc(0));

    await expect(
      fixture.access.capture(
        { rootIndex: 0, relativePath: path, startLine, endLine },
        2_000,
      ),
    ).resolves.toEqual({
      status: "denied",
      code: "line_range_out_of_bounds",
    });
  });

  it.each([
    "application_default_credentials.json",
    "nested/application_default_credentials.json",
    ".docker/config.json",
    "nested/.docker/config.json",
    ".config/gh/hosts.yml",
    "nested/.config/gh/hosts.yml",
    ".yarnrc.yml",
    "nested/.yarnrc.yml",
    "service-account.json",
    "nested/service_account.json",
    "service-account-prod.json",
    "nested/service_account_prod.json",
    "service-account-key.json",
    "nested/service-account-key.json",
    "service_account_key.yml",
    "nested/service-account-prod-key.yaml",
    "nested/SERVICE_ACCOUNT_PROD_KEY.JSON",
  ])("denies the credential configuration matrix for %s", async (relativePath) => {
    const fixture = await createFixture();
    const absolutePath = join(fixture.approvedRoot, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "credential material\n", "utf8");

    await expect(
      fixture.access.capture(
        { rootIndex: 0, relativePath, startLine: 1, endLine: 1 },
        2_000,
      ),
    ).resolves.toEqual({ status: "denied", code: "secret_path" });
    await expect(snapshotFiles(fixture.runtimeHome)).resolves.toEqual([]);
  });

  it.each([
    "tokens.md",
    "secrets.md",
    "service-account.md",
    "nested/tokens.md",
    "nested/secrets.md",
    "nested/service_account.md",
  ])(
    "allows an ordinary teaching document named %s",
    async (relativePath) => {
      const fixture = await createFixture();
      const absolutePath = join(fixture.approvedRoot, relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, "teaching notes\n", "utf8");

      await expect(
        fixture.access.capture(
          { rootIndex: 0, relativePath, startLine: 1, endLine: 1 },
          2_000,
        ),
      ).resolves.toMatchObject({
        status: "captured",
        excerpt: "teaching notes",
      });
    },
  );

  it.each([
    {
      name: "case-equivalent path",
      directory: "CaseDocs",
      exclusion: "casedocs/**",
    },
    {
      name: "NFD path and NFC pattern",
      directory: "Cafe\u0301",
      exclusion: "caf\u00e9/**",
    },
  ])("conservatively excludes a $name", async ({ directory, exclusion }) => {
    const fixture = await createFixture();
    const relativePath = `${directory}/hidden.md`;
    await mkdir(join(fixture.approvedRoot, directory));
    await writeFile(
      join(fixture.approvedRoot, relativePath),
      "excluded teaching note\n",
      "utf8",
    );
    const access = new PrivateSourceAccess({
      ...fixture.scope,
      exclusions: [exclusion],
    });

    await expect(
      access.capture(
        { rootIndex: 0, relativePath, startLine: 1, endLine: 1 },
        2_000,
      ),
    ).resolves.toEqual({ status: "denied", code: "excluded_path" });
    await expect(snapshotFiles(fixture.runtimeHome)).resolves.toEqual([]);
  });

  it("rejects a root retarget between preflight and handle open", async () => {
    const fixture = await createFixture();
    const retiredRoot = join(fixture.baseDirectory, "retired-approved");
    const attackerRoot = join(fixture.baseDirectory, "attacker-approved");
    const access = new PrivateSourceAccess(fixture.scope, {
      afterPreflight: async () => {
        await rename(fixture.approvedRoot, retiredRoot);
        await mkdir(attackerRoot);
        await writeFile(join(attackerRoot, "notes.md"), "attacker\n", "utf8");
        await symlink(attackerRoot, fixture.approvedRoot, "dir");
      },
    });

    const result = await access.capture(
      { rootIndex: 0, relativePath: "notes.md", startLine: 1, endLine: 1 },
      2_000,
    );

    expect(result).toEqual({ status: "failed", code: "root_changed" });
    expect(JSON.stringify(result)).not.toContain(attackerRoot);
  });

  it("rejects a parent directory changed to a symlink after preflight", async () => {
    const fixture = await createFixture();
    const parent = join(fixture.approvedRoot, "parent");
    const retiredParent = join(fixture.approvedRoot, "parent-retired");
    await mkdir(parent);
    await writeFile(join(parent, "notes.md"), "approved parent\n", "utf8");
    await writeFile(join(fixture.outsideRoot, "notes.md"), "attacker parent\n");
    const access = new PrivateSourceAccess(fixture.scope, {
      afterPreflight: async () => {
        await rename(parent, retiredParent);
        await symlink(fixture.outsideRoot, parent, "dir");
      },
    });

    const result = await access.capture(
      {
        rootIndex: 0,
        relativePath: "parent/notes.md",
        startLine: 1,
        endLine: 1,
      },
      2_000,
    );

    expect(result).toEqual({
      status: "failed",
      code: "path_changed_during_read",
    });
  });

  it("rejects a file truncated after bytes are read from its handle", async () => {
    const fixture = await createFixture();
    const access = new PrivateSourceAccess(fixture.scope, {
      afterRead: async () => {
        await truncate(join(fixture.approvedRoot, "notes.md"), 1);
      },
    });

    const result = await access.capture(
      { rootIndex: 0, relativePath: "notes.md", startLine: 1, endLine: 1 },
      2_000,
    );

    expect(result).toEqual({
      status: "failed",
      code: "source_changed_during_read",
    });
  });
});

interface Fixture {
  /** 当前测试创建的唯一临时父目录。 */
  readonly baseDirectory: string;
  /** Source Scope 批准的第一个本地根目录。 */
  readonly approvedRoot: string;
  /** 用于构造 traversal 与 symlink escape 的未批准目录。 */
  readonly outsideRoot: string;
  /** 私有 Source Snapshot namespace 所属 Runtime Home。 */
  readonly runtimeHome: string;
  /** 测试绑定给 PrivateSourceAccess 的 Source Scope。 */
  readonly scope: SourceScope;
  /** 只拥有读取与策略判定能力的组件。 */
  readonly access: PrivateSourceAccess;
  /** 测试中仅由显式成功分支调用的 Artifact Store。 */
  readonly artifacts: ContentAddressedArtifactStore;
}

async function createFixture(): Promise<Fixture> {
  const baseDirectory = await mkdtemp(join(tmpdir(), "private-source-access-"));
  temporaryDirectories.push(baseDirectory);
  const approvedRoot = join(baseDirectory, "approved");
  const outsideRoot = join(baseDirectory, "outside");
  const requestedRuntimeHome = join(baseDirectory, "runtime");
  await Promise.all([
    mkdir(join(approvedRoot, "config"), { recursive: true }),
    mkdir(join(approvedRoot, "excluded"), { recursive: true }),
    mkdir(join(approvedRoot, "directory.md"), { recursive: true }),
    mkdir(outsideRoot, { recursive: true }),
    mkdir(requestedRuntimeHome, { recursive: true }),
  ]);

  await Promise.all([
    writeFile(join(approvedRoot, "notes.md"), "notes budget\n", "utf8"),
    writeFile(join(approvedRoot, "excluded", "hidden.md"), "hidden\n", "utf8"),
    writeFile(join(approvedRoot, ".env"), "TOKEN=secret\n", "utf8"),
    writeFile(join(approvedRoot, "private.pem"), "private key\n", "utf8"),
    writeFile(
      join(approvedRoot, "config", "credentials.json"),
      '{"token":"secret"}\n',
      "utf8",
    ),
    writeFile(join(approvedRoot, "UPPER.MD"), "uppercase\n", "utf8"),
    writeFile(join(approvedRoot, "plain.txt"), "plain\n", "utf8"),
    writeFile(join(approvedRoot, "invalid.bin"), Buffer.from([0xc3, 0x28])),
    writeFile(join(approvedRoot, "nul.bin"), Buffer.from("text\0tail", "utf8")),
    writeFile(join(approvedRoot, "oversized.md"), Buffer.alloc(257, 0x61)),
    writeFile(join(outsideRoot, "outside.md"), "outside\n", "utf8"),
  ]);
  await Promise.all([
    symlink(join(outsideRoot, "outside.md"), join(approvedRoot, "linked-outside.md")),
    symlink(
      join(approvedRoot, "excluded", "hidden.md"),
      join(approvedRoot, "hidden-alias.md"),
    ),
  ]);

  const scope: SourceScope = await canonicalizeSourceScope({
    roots: [approvedRoot],
    exclusions: ["excluded/**"],
    allowedExtensions: [".md", ".bin", ".json", ".pem", ".yml"],
    maxFileBytes: 256,
    maxTotalBytes: 2_000,
  });
  const runtimeHome = preparePrivateRuntimeHome(requestedRuntimeHome);
  return {
    baseDirectory,
    approvedRoot,
    outsideRoot,
    runtimeHome,
    scope,
    access: new PrivateSourceAccess(scope),
    artifacts: new ContentAddressedArtifactStore(runtimeHome),
  };
}

async function snapshotFiles(runtimeHome: string): Promise<string[]> {
  const namespace = join(runtimeHome, "source-snapshots");
  try {
    if (!(await lstat(namespace)).isDirectory()) {
      return [];
    }
    return (await readdir(namespace, { recursive: true }))
      .map(String)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

function isErrorCode(
  error: unknown,
  code: NodeJS.ErrnoException["code"],
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
