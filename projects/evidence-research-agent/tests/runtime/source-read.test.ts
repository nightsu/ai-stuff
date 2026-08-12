import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import {
  ResearchAgentRuntime,
  ScriptedModel,
  formatRunTrace,
  hashCanonicalJson,
} from "../../src/index.js";
import type {
  ReadSourceCommand,
  IdGenerator,
  ResearchRunEvent,
  RunBudget,
  RunProjection,
  SourceReadObservation,
} from "../../src/index.js";
import {
  IllegalRunEventError,
  reduceRunEvents,
} from "../../src/domain/reducer.js";
import { parseResearchRunEvent } from "../../src/domain/schemas.js";
import { ContentAddressedArtifactStore } from "../../src/infrastructure/content-addressed-artifact-store.js";
import { SqliteRunStore } from "../../src/infrastructure/sqlite-run-store.js";

const temporaryDirectories: string[] = [];
const DEFAULT_SOURCE_BYTES = Buffer.from(
  "first line\nsecond line\n第三行🙂\nfourth line\nfifth line\n",
  "utf8",
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("ResearchAgentRuntime source reads", () => {
  it("requires both source-read identity methods on the injected ID port", () => {
    expectTypeOf<
      Pick<IdGenerator, "nextToolCallId" | "nextObservationId">
    >().toEqualTypeOf<{
      nextToolCallId(): string;
      nextObservationId(): string;
    }>();
  });

  it("persists one successful read, snapshot, and safe trace across live-file loss", async () => {
    const fixture = await createApprovedRun();
    const request = {
      rootIndex: 0,
      relativePath: "fixture.md",
      startLine: 2,
      endLine: 4,
    } as const;
    const restarted = openReadingRuntime(fixture.runtimeHome);

    const updated = await restarted.readSource({
      runId: fixture.runId,
      request,
    });
    const observation = onlySuccessfulObservation(updated);
    const trace = await restarted.traceRun({ runId: fixture.runId });
    const filteredTrace = await restarted.traceRun({
      runId: fixture.runId,
      toolCallId: observation.toolCallId,
    });
    const sourceTrace = trace.events.at(-1);

    expect(updated.lastEventSequence).toBe(5);
    expect(updated.state.type).toBe("researching");
    expect(updated.state).toMatchObject({
      sourceBytesRead: fixture.sourceBytes.byteLength,
      sourceReadObservations: [observation],
    });
    expect(observation).toMatchObject({
      toolName: "read_source",
      status: "succeeded",
      requestHash: hashCanonicalJson(request),
      rootIndex: 0,
      relativePath: "fixture.md",
      startLine: 2,
      endLine: 4,
      totalLines: 5,
      excerpt: "second line\n第三行🙂\nfourth line",
      excerptHash: sha256Utf8("second line\n第三行🙂\nfourth line"),
      byteLength: fixture.sourceBytes.byteLength,
      sourceSnapshot: {
        snapshotId: `source-sha256:${sha256Bytes(fixture.sourceBytes)}`,
        sha256: sha256Bytes(fixture.sourceBytes),
        mediaType: "text/plain; charset=utf-8",
        byteLength: fixture.sourceBytes.byteLength,
      },
    });
    expect(observation.observationId).toMatch(/^observation-/);
    expect(observation.toolCallId).toMatch(/^tool-call-/);
    expect(observation.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(observation.sourceSnapshot.relativePath).toMatch(
      /^source-snapshots\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/,
    );
    expect(sourceTrace).toMatchObject({
      sequence: 5,
      type: "source_read_observed",
      stateAfter: "researching",
      toolCallId: observation.toolCallId,
      observationStatus: "succeeded",
      sourceSnapshotId: observation.sourceSnapshot.snapshotId,
    });
    expect(filteredTrace.events).toEqual([
      expect.objectContaining({
        type: "source_read_observed",
        toolCallId: observation.toolCallId,
      }),
    ]);
    expect(await readFile(join(fixture.runtimeHome, observation.sourceSnapshot.relativePath))).toEqual(
      fixture.sourceBytes,
    );
    expect(countSourceSnapshots(fixture.runtimeHome)).toBe(1);
    expect(countArtifacts(fixture.runtimeHome)).toBe(1);
    expect(readSourceSnapshotRow(fixture.runtimeHome)).toMatchObject({
      snapshot_id: observation.sourceSnapshot.snapshotId,
      sha256: observation.sourceSnapshot.sha256,
      media_type: observation.sourceSnapshot.mediaType,
      byte_length: observation.sourceSnapshot.byteLength,
      relative_path: observation.sourceSnapshot.relativePath,
    });
    const humanTrace = formatRunTrace(trace, "human");
    expect(humanTrace).toContain(observation.toolCallId);
    expect(humanTrace).toContain(observation.sourceSnapshot.snapshotId);
    expect(humanTrace).not.toContain(observation.excerpt);
    expect(humanTrace).not.toContain(fixture.sourceRoot);
    restarted.close();

    await writeFile(join(fixture.sourceRoot, "fixture.md"), "mutated live bytes\n");
    await rm(join(fixture.sourceRoot, "fixture.md"));
    const recovered = openReadingRuntime(fixture.runtimeHome);
    try {
      await expect(recovered.inspectRun({ runId: fixture.runId })).resolves.toEqual(
        updated,
      );
      await expect(
        recovered.rebuildRunProjection({ runId: fixture.runId }),
      ).resolves.toEqual(updated);
      await expect(recovered.traceRun({ runId: fixture.runId })).resolves.toEqual(
        trace,
      );
      await expect(
        readFile(join(fixture.runtimeHome, observation.sourceSnapshot.relativePath)),
      ).resolves.toEqual(fixture.sourceBytes);
    } finally {
      recovered.close();
    }
  });

  it("deduplicates identical bytes across paths and Runs while changed bytes get a new snapshot", async () => {
    const workspace = await createWorkspace();
    const identicalBytes = Buffer.from("same source bytes\nsecond line\n", "utf8");
    const changedBytes = Buffer.from("changed source bytes\nsecond line\n", "utf8");
    await Promise.all([
      writeFile(join(workspace.sourceRoot, "first.md"), identicalBytes),
      writeFile(join(workspace.sourceRoot, "second.md"), identicalBytes),
    ]);
    const firstRun = await createApprovedRun({ workspace });
    const secondRun = await createApprovedRun({ workspace });
    const runtime = openReadingRuntime(workspace.runtimeHome);

    try {
      const first = onlySuccessfulObservation(
        await runtime.readSource({
          runId: firstRun.runId,
          request: readWholeRequest("first.md", 2),
        }),
      );
      const second = onlySuccessfulObservation(
        await runtime.readSource({
          runId: secondRun.runId,
          request: readWholeRequest("second.md", 2),
        }),
      );

      expect(second.sourceSnapshot).toEqual(first.sourceSnapshot);
      expect(second.relativePath).not.toBe(first.relativePath);
      expect(countSourceSnapshots(workspace.runtimeHome)).toBe(1);

      await writeFile(join(workspace.sourceRoot, "first.md"), changedBytes);
      const changed = lastSuccessfulObservation(
        await runtime.readSource({
          runId: firstRun.runId,
          request: readWholeRequest("first.md", 2),
        }),
      );
      expect(changed.sourceSnapshot.snapshotId).not.toBe(
        first.sourceSnapshot.snapshotId,
      );
      expect(countSourceSnapshots(workspace.runtimeHome)).toBe(2);
      await expect(
        readFile(join(workspace.runtimeHome, first.sourceSnapshot.relativePath)),
      ).resolves.toEqual(identicalBytes);
      await expect(
        readFile(join(workspace.runtimeHome, changed.sourceSnapshot.relativePath)),
      ).resolves.toEqual(changedBytes);
    } finally {
      runtime.close();
    }
  });

  it("never persists success when request spelling differs from the canonical relative path", async () => {
    const workspace = await createWorkspace();
    await writeFile(join(workspace.sourceRoot, "Actual.md"), "canonical case\n");
    const fixture = await createApprovedRun({ workspace });
    const runtime = openReadingRuntime(workspace.runtimeHome);

    try {
      const updated = await runtime.readSource({
        runId: fixture.runId,
        request: readWholeRequest("actual.md", 1),
      });
      expect(lastObservation(updated).status).not.toBe("succeeded");
      expect(countSourceSnapshots(workspace.runtimeHome)).toBe(0);
    } finally {
      runtime.close();
    }
  });

  it("uses the shared exclusion-first path policy in capture and replay", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace.sourceRoot, "blocked"));
    await writeFile(
      join(workspace.sourceRoot, "blocked", "secret.pem"),
      "private key bytes\n",
    );
    const fixture = await createApprovedRun({
      workspace,
      exclusions: ["blocked/**"],
      allowedExtensions: [".md"],
    });
    const runtime = openReadingRuntime(workspace.runtimeHome);

    try {
      await runtime.readSource({
        runId: fixture.runId,
        request: readWholeRequest("fixture.md", 1),
      });
      const denied = await runtime.readSource({
        runId: fixture.runId,
        request: readWholeRequest("blocked/secret.pem", 1),
      });
      expect(lastObservation(denied)).toMatchObject({
        status: "denied",
        code: "excluded_path",
      });
    } finally {
      runtime.close();
    }

    const events = readResearchRunEvents(workspace.runtimeHome, fixture.runId);
    const succeeded = sourceReadEventOf(events);
    if (succeeded.payload.observation.status !== "succeeded") {
      throw new Error("测试要求先持久化一个成功 observation");
    }
    const excludedRequest = readWholeRequest("blocked/secret.pem", 1);
    const tampered = {
      ...succeeded,
      payload: {
        observation: {
          ...succeeded.payload.observation,
          relativePath: excludedRequest.relativePath,
          requestHash: hashCanonicalJson(excludedRequest),
        },
      },
    } as ResearchRunEvent;
    expect(() => reduceRunEvents([...events.slice(0, 4), tampered])).toThrow(
      IllegalRunEventError,
    );
  });

  it("keeps the first registry createdAt after two Runs prepare before sequential registration", async () => {
    const workspace = await createWorkspace();
    const firstRun = await createApprovedRun({ workspace });
    const secondRun = await createApprovedRun({ workspace });
    const canonicalRuntimeHome = await realpath(workspace.runtimeHome);
    const artifacts = new ContentAddressedArtifactStore(canonicalRuntimeHome);
    const firstCreatedAt = "2026-08-12T08:10:00.000Z";
    const secondCreatedAt = "2026-08-12T08:11:00.000Z";
    const firstCandidate = await artifacts.putSourceSnapshot(
      DEFAULT_SOURCE_BYTES,
      firstCreatedAt,
    );
    const secondCandidate = await artifacts.putSourceSnapshot(
      DEFAULT_SOURCE_BYTES,
      secondCreatedAt,
    );
    const firstStore = new SqliteRunStore(canonicalRuntimeHome);
    const secondStore = new SqliteRunStore(canonicalRuntimeHome);
    const preparedFirst = firstStore.prepareSourceSnapshotRegistration(firstCandidate);
    const preparedSecond = secondStore.prepareSourceSnapshotRegistration(secondCandidate);
    const request = readWholeRequest("fixture.md", 1);

    try {
      // 两个 store 都先得到“尚未登记”的 stale prepare 结果，再按确定顺序提交；
      // 这只验证 registry first-writer 语义，不声称模拟了 worker/process 并行。
      firstStore.appendEvents(
        firstRun.runId,
        4,
        [
          successfulSourceEvent(
            firstRun.runId,
            request,
            preparedFirst,
            firstCreatedAt,
            "first",
          ),
        ],
        [],
        [preparedFirst],
      );
      expect(() =>
        secondStore.appendEvents(
          secondRun.runId,
          4,
          [
            successfulSourceEvent(
              secondRun.runId,
              request,
              preparedSecond,
              secondCreatedAt,
              "second",
            ),
          ],
          [],
          [preparedSecond],
        ),
      ).not.toThrow();
      expect(readSourceSnapshotRow(workspace.runtimeHome).created_at).toBe(
        firstCreatedAt,
      );
    } finally {
      firstStore.close();
      secondStore.close();
    }
  });

  it("persists every policy denial and stable filesystem failure without raw request details", async () => {
    const workspace = await createWorkspace();
    const outsidePath = join(workspace.baseDirectory, "outside-secret.md");
    await Promise.all([
      mkdir(join(workspace.sourceRoot, "excluded")),
      mkdir(join(workspace.sourceRoot, "directory.md")),
    ]);
    await Promise.all([
      writeFile(join(workspace.sourceRoot, "short.md"), "one line\n"),
      writeFile(join(workspace.sourceRoot, "excluded", "hidden.md"), "hidden\n"),
      writeFile(join(workspace.sourceRoot, ".env"), "TOKEN=secret\n"),
      writeFile(join(workspace.sourceRoot, "plain.txt"), "plain\n"),
      writeFile(join(workspace.sourceRoot, "invalid.md"), Buffer.from([0xc3, 0x28])),
      writeFile(join(workspace.sourceRoot, "binary.md"), Buffer.from("text\0tail")),
      writeFile(join(workspace.sourceRoot, "oversized.md"), Buffer.alloc(65, 0x61)),
      writeFile(join(workspace.sourceRoot, "unreadable.md"), "private bytes\n"),
      writeFile(outsidePath, "outside\n"),
    ]);
    await symlink(outsidePath, join(workspace.sourceRoot, "linked.md"));
    const fixture = await createApprovedRun({
      workspace,
      maxFileBytes: 64,
      exclusions: ["excluded/**"],
      allowedExtensions: [".md"],
    });
    const runtime = openReadingRuntime(workspace.runtimeHome);
    const cases = [
      ["invalid_root", { rootIndex: 4, relativePath: "short.md", startLine: 1, endLine: 1 }],
      ["invalid_path", { rootIndex: 0, relativePath: outsidePath, startLine: 1, endLine: 1 }],
      ["invalid_line_range", { rootIndex: 0, relativePath: "short.md", startLine: 0, endLine: 1 }],
      ["line_range_out_of_bounds", { rootIndex: 0, relativePath: "short.md", startLine: 2, endLine: 2 }],
      ["path_escape", { rootIndex: 0, relativePath: "../outside-secret.md", startLine: 1, endLine: 1 }],
      ["symlink_path", { rootIndex: 0, relativePath: "linked.md", startLine: 1, endLine: 1 }],
      ["excluded_path", { rootIndex: 0, relativePath: "excluded/hidden.md", startLine: 1, endLine: 1 }],
      ["secret_path", { rootIndex: 0, relativePath: ".env", startLine: 1, endLine: 1 }],
      ["extension_not_allowed", { rootIndex: 0, relativePath: "plain.txt", startLine: 1, endLine: 1 }],
      ["binary_file", { rootIndex: 0, relativePath: "invalid.md", startLine: 1, endLine: 1 }],
      ["binary_file", { rootIndex: 0, relativePath: "binary.md", startLine: 1, endLine: 1 }],
      ["file_too_large", { rootIndex: 0, relativePath: "oversized.md", startLine: 1, endLine: 1 }],
      ["line_range_too_large", { rootIndex: 0, relativePath: "short.md", startLine: 1, endLine: 201 }],
      ["source_not_file", { rootIndex: 0, relativePath: "directory.md", startLine: 1, endLine: 1 }],
      ["source_not_found", { rootIndex: 0, relativePath: "missing.md", startLine: 1, endLine: 1 }],
    ] as const;

    try {
      let expectedSequence = 4;
      for (const [code, request] of cases) {
        const originalRequest = structuredClone(request);
        const updated = await runtime.readSource({ runId: fixture.runId, request });
        expectedSequence += 1;
        const observation = lastObservation(updated);

        expect(updated.lastEventSequence, code).toBe(expectedSequence);
        expect(updated.sourceScope).toEqual(fixture.sourceScope);
        expect(request).toEqual(originalRequest);
        expect(observation).toEqual({
          observationId: observation.observationId,
          toolCallId: observation.toolCallId,
          toolName: "read_source",
          requestHash: hashCanonicalJson(request),
          observedAt: observation.observedAt,
          status: code.startsWith("source_") ? "failed" : "denied",
          code,
        });
        expect(JSON.stringify(observation)).not.toContain(request.relativePath);
        expect(researchingStateOf(updated).sourceBytesRead).toBe(0);
        expect(countSourceSnapshots(workspace.runtimeHome)).toBe(0);
      }

      await chmod(join(workspace.sourceRoot, "unreadable.md"), 0o000);
      const ioRequest = readWholeRequest("unreadable.md", 1);
      const ioFailed = await runtime.readSource({
        runId: fixture.runId,
        request: ioRequest,
      });
      expect(lastObservation(ioFailed)).toMatchObject({
        status: "failed",
        code: "source_io_error",
        requestHash: hashCanonicalJson(ioRequest),
      });
      expect(JSON.stringify(lastObservation(ioFailed))).not.toContain(
        workspace.sourceRoot,
      );
      expect(countSourceSnapshots(workspace.runtimeHome)).toBe(0);
      expect(await snapshotFiles(workspace.runtimeHome)).toEqual([]);
    } finally {
      await chmod(join(workspace.sourceRoot, "unreadable.md"), 0o600);
      runtime.close();
    }
  });

  it.each([
    ["Run Budget", 100, 10],
    ["Source Scope", 10, 100],
  ])(
    "uses the smaller remaining %s byte limit and records the second call as denied",
    async (_name, maxTotalBytes, maxSourceBytes) => {
      const workspace = await createWorkspace();
      const bytes = Buffer.from("one\ntwo\n", "utf8");
      await writeFile(join(workspace.sourceRoot, "budget.md"), bytes);
      const fixture = await createApprovedRun({
        workspace,
        maxTotalBytes,
        maxSourceBytes,
      });
      const runtime = openReadingRuntime(workspace.runtimeHome);

      try {
        const request = readWholeRequest("budget.md", 2);
        const first = await runtime.readSource({ runId: fixture.runId, request });
        const second = await runtime.readSource({ runId: fixture.runId, request });

        expect(researchingStateOf(first).sourceBytesRead).toBe(bytes.byteLength);
        expect(researchingStateOf(second).sourceBytesRead).toBe(bytes.byteLength);
        expect(researchingStateOf(second).sourceReadObservations.map(({ status }) => status)).toEqual([
          "succeeded",
          "denied",
        ]);
        expect(lastObservation(second)).toMatchObject({
          status: "denied",
          code: "source_budget_exceeded",
        });
        expect(countSourceSnapshots(workspace.runtimeHome)).toBe(1);
      } finally {
        runtime.close();
      }
    },
  );

  it.each([
    { name: "outer extra authority", mutate: (command: object) => ({ ...command, actor: "model" }) },
    { name: "caller tool identity", mutate: (command: object) => ({ ...command, toolCallId: "caller-owned" }) },
    { name: "request extra snapshot", mutate: (command: ReadSourceCommand) => ({ ...command, request: { ...command.request, snapshot: "caller-owned" } }) },
    { name: "missing line", mutate: (command: ReadSourceCommand) => ({ ...command, request: { rootIndex: 0, relativePath: command.request.relativePath, startLine: 1 } }) },
    { name: "wrong path type", mutate: (command: ReadSourceCommand) => ({ ...command, request: { ...command.request, relativePath: 42 } }) },
  ])("rejects malformed $name without reading or persisting", async ({ mutate }) => {
    const fixture = await createApprovedRun();
    const runtime = openReadingRuntime(fixture.runtimeHome);
    const command: ReadSourceCommand = {
      runId: fixture.runId,
      request: readWholeRequest("fixture.md", 1),
    };

    try {
      await expect(
        runtime.readSource(mutate(command) as ReadSourceCommand),
      ).rejects.toMatchObject({ name: "InvalidSourceReadCommandError" });
      expect(countSourceReadEvents(fixture.runtimeHome, fixture.runId)).toBe(0);
      expect(countSourceSnapshots(fixture.runtimeHome)).toBe(0);
    } finally {
      runtime.close();
    }
  });

  it("generates controlled source-read identities and time only after the command is authorized", async () => {
    const workspace = await createWorkspace();
    await writeFile(join(workspace.sourceRoot, ".env"), "TOKEN=secret\n");
    const fixture = await createApprovedRun({ workspace });
    const boundaries = createReadBoundaries("controlled", [
      "2026-08-12T11:00:00.000Z",
      "2026-08-12T11:01:00.000Z",
    ]);
    const runtime = ResearchAgentRuntime.open({
      runtimeHome: workspace.runtimeHome,
      model: new ScriptedModel([]),
      clock: boundaries.clock,
      ids: boundaries.ids,
    });

    try {
      const succeeded = await runtime.readSource({
        runId: fixture.runId,
        request: readWholeRequest("fixture.md", 1),
      });
      const denied = await runtime.readSource({
        runId: fixture.runId,
        request: readWholeRequest(".env", 1),
      });
      const trace = await runtime.traceRun({ runId: fixture.runId });
      const sourceEvents = trace.events.filter(
        ({ type }) => type === "source_read_observed",
      );

      expect(onlySuccessfulObservation(succeeded)).toMatchObject({
        observationId: "observation-controlled-1",
        toolCallId: "tool-call-controlled-1",
        observedAt: "2026-08-12T11:00:00.000Z",
      });
      expect(lastObservation(denied)).toEqual({
        observationId: "observation-controlled-2",
        toolCallId: "tool-call-controlled-2",
        toolName: "read_source",
        requestHash: hashCanonicalJson(readWholeRequest(".env", 1)),
        observedAt: "2026-08-12T11:01:00.000Z",
        status: "denied",
        code: "secret_path",
      });
      expect(sourceEvents.map(({ eventId }) => eventId)).toEqual([
        "event-controlled-1",
        "event-controlled-2",
      ]);
      expect(boundaries.calls()).toEqual({
        clock: 2,
        event: 2,
        observation: 2,
        toolCall: 2,
      });
    } finally {
      runtime.close();
    }
  });

  it("does not consume source-read identities or time for malformed or non-researching commands", async () => {
    const workspace = await createWorkspace();
    const approved = await createApprovedRun({ workspace });
    const waiting = await createWaitingRun(workspace);
    const boundaries = createReadBoundaries("unused", [
      "2026-08-12T11:10:00.000Z",
    ]);
    const runtime = ResearchAgentRuntime.open({
      runtimeHome: workspace.runtimeHome,
      model: new ScriptedModel([]),
      clock: boundaries.clock,
      ids: boundaries.ids,
    });

    try {
      await expect(
        runtime.readSource({
          runId: approved.runId,
          request: {
            ...readWholeRequest("fixture.md", 1),
            callerOwnedStatus: "succeeded",
          },
        } as unknown as ReadSourceCommand),
      ).rejects.toMatchObject({ name: "InvalidSourceReadCommandError" });
      await expect(
        runtime.readSource({
          runId: waiting.runId,
          request: readWholeRequest("fixture.md", 1),
        }),
      ).rejects.toMatchObject({ name: "IllegalSourceReadStateError" });
      expect(boundaries.calls()).toEqual({
        clock: 0,
        event: 0,
        observation: 0,
        toolCall: 0,
      });
    } finally {
      runtime.close();
    }
  });

  it("uses named safe errors for missing and non-researching Runs", async () => {
    const workspace = await createWorkspace();
    const waiting = await createWaitingRun(workspace);
    const runtime = openReadingRuntime(workspace.runtimeHome);
    const secretPath = "secret-do-not-echo.md";

    try {
      const nonResearching = runtime.readSource({
        runId: waiting.runId,
        request: readWholeRequest(secretPath, 1),
      });
      await expect(nonResearching).rejects.toMatchObject({
        name: "IllegalSourceReadStateError",
      });
      await expect(nonResearching).rejects.not.toThrow(secretPath);

      const missing = runtime.readSource({
        runId: "missing-run-secret",
        request: readWholeRequest(secretPath, 1),
      });
      await expect(missing).rejects.toMatchObject({
        name: "SourceReadRunNotFoundError",
      });
      await expect(missing).rejects.not.toThrow(secretPath);
      await expect(missing).rejects.not.toThrow("missing-run-secret");
      expect(countSourceSnapshots(workspace.runtimeHome)).toBe(0);
    } finally {
      runtime.close();
    }
  });

  it("sanitizes corrupted Journal diagnostics at the readSource boundary", async () => {
    const fixture = await createApprovedRun();
    const secretPayload = "secret-corrupt-payload";
    corruptJournalEvent(fixture.runtimeHome, fixture.runId, secretPayload);
    const runtime = openReadingRuntime(fixture.runtimeHome);

    try {
      const reading = runtime.readSource({
        runId: fixture.runId,
        request: readWholeRequest("fixture.md", 1),
      });
      await expect(reading).rejects.toMatchObject({
        name: "SourceReadPersistenceError",
      });
      await expect(reading).rejects.not.toThrow(secretPayload);
      await expect(reading).rejects.not.toThrow(fixture.sourceRoot);
      expect(countSourceSnapshots(fixture.runtimeHome)).toBe(0);
    } finally {
      runtime.close();
    }
  });

  it("reports run_busy without claiming two concurrent source reads were persisted", async () => {
    const fixture = await createApprovedRun();
    const firstBoundaries = createReadBoundaries("first-attempt", [
      "2026-08-12T11:20:00.000Z",
    ]);
    const secondBoundaries = createReadBoundaries("second-attempt", [
      "2026-08-12T11:20:01.000Z",
    ]);
    const first = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      model: new ScriptedModel([]),
      clock: firstBoundaries.clock,
      ids: firstBoundaries.ids,
    });
    const second = ResearchAgentRuntime.open({
      runtimeHome: fixture.runtimeHome,
      model: new ScriptedModel([]),
      clock: secondBoundaries.clock,
      ids: secondBoundaries.ids,
    });
    const command = {
      runId: fixture.runId,
      request: readWholeRequest("fixture.md", 1),
    } as const;

    try {
      const outcomes = await Promise.allSettled([
        first.readSource(command),
        second.readSource(command),
      ]);
      expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find(({ status }) => status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: { name: "RunBusyError" },
      });
      expect(countSourceReadEvents(fixture.runtimeHome, fixture.runId)).toBe(1);
      const persisted = await first.inspectRun({ runId: fixture.runId });
      expect(researchingStateOf(persisted).sourceReadObservations).toHaveLength(1);
      expect(researchingStateOf(persisted).sourceBytesRead).toBe(
        fixture.sourceBytes.byteLength,
      );
      // lease 在外部文件 I/O 前完成竞争；输家不读取 live source，也不消费
      // Journal event / observation / tool-call identity。
      expect([firstBoundaries.calls(), secondBoundaries.calls()]).toContainEqual({
        clock: 0,
        event: 0,
        observation: 0,
        toolCall: 0,
      });
      expect([firstBoundaries.calls(), secondBoundaries.calls()]).toContainEqual({
        clock: 1,
        event: 1,
        observation: 1,
        toolCall: 1,
      });
    } finally {
      first.close();
      second.close();
    }
  });
});

describe("SqliteRunStore Source Snapshot coupling", () => {
  it("rolls back a succeeded observation when its referenced snapshot is absent", async () => {
    const fixture = await createApprovedRun();
    const canonicalRuntimeHome = await realpath(fixture.runtimeHome);
    const artifacts = new ContentAddressedArtifactStore(canonicalRuntimeHome);
    const snapshot = await artifacts.putSourceSnapshot(
      fixture.sourceBytes,
      "2026-08-12T10:00:00.000Z",
    );
    const store = new SqliteRunStore(canonicalRuntimeHome);

    try {
      expect(() =>
        store.appendEvents(
          fixture.runId,
          4,
          [
            successfulSourceEvent(
              fixture.runId,
              readWholeRequest("fixture.md", 1),
              snapshot,
              "2026-08-12T10:00:00.000Z",
              "missing-registry",
            ),
          ],
        ),
      ).toThrowError(
        expect.objectContaining({
          name: "SourceSnapshotEventInvariantError",
        }),
      );
      expect(store.readProjection(fixture.runId).lastEventSequence).toBe(4);
      expect(countSourceReadEvents(fixture.runtimeHome, fixture.runId)).toBe(0);
      expect(countSourceSnapshots(fixture.runtimeHome)).toBe(0);
    } finally {
      store.close();
    }
  });

  it.each(["denied", "failed"] as const)(
    "rolls back an unrelated snapshot supplied with a %s observation",
    async (status) => {
      const fixture = await createApprovedRun();
      const canonicalRuntimeHome = await realpath(fixture.runtimeHome);
      const artifacts = new ContentAddressedArtifactStore(canonicalRuntimeHome);
      const snapshot = await artifacts.putSourceSnapshot(
        fixture.sourceBytes,
        "2026-08-12T10:01:00.000Z",
      );
      const store = new SqliteRunStore(canonicalRuntimeHome);

      try {
        expect(() =>
          store.appendEvents(
            fixture.runId,
            4,
            [
              nonSuccessfulSourceEvent(
                fixture.runId,
                status,
                "2026-08-12T10:01:00.000Z",
              ),
            ],
            [],
            [snapshot],
          ),
        ).toThrowError(
          expect.objectContaining({
            name: "SourceSnapshotEventInvariantError",
          }),
        );
        expect(store.readProjection(fixture.runId).lastEventSequence).toBe(4);
        expect(countSourceReadEvents(fixture.runtimeHome, fixture.runId)).toBe(0);
        expect(countSourceSnapshots(fixture.runtimeHome)).toBe(0);
      } finally {
        store.close();
      }
    },
  );

  it("rejects a provided snapshot that no succeeded event in the batch references", async () => {
    const workspace = await createWorkspace();
    const firstRun = await createApprovedRun({ workspace });
    const secondRun = await createApprovedRun({ workspace });
    const canonicalRuntimeHome = await realpath(workspace.runtimeHome);
    const artifacts = new ContentAddressedArtifactStore(canonicalRuntimeHome);
    const firstSnapshot = await artifacts.putSourceSnapshot(
      firstRun.sourceBytes,
      "2026-08-12T10:02:00.000Z",
    );
    const unrelatedSnapshot = await artifacts.putSourceSnapshot(
      Buffer.from("unrelated source bytes\n", "utf8"),
      "2026-08-12T10:03:00.000Z",
    );
    const store = new SqliteRunStore(canonicalRuntimeHome);

    try {
      store.appendEvents(
        firstRun.runId,
        4,
        [
          successfulSourceEvent(
            firstRun.runId,
            readWholeRequest("fixture.md", 1),
            firstSnapshot,
            "2026-08-12T10:02:00.000Z",
            "registered-first",
          ),
        ],
        [],
        [firstSnapshot],
      );

      expect(() =>
        store.appendEvents(
          secondRun.runId,
          4,
          [
            successfulSourceEvent(
              secondRun.runId,
              readWholeRequest("fixture.md", 1),
              firstSnapshot,
              "2026-08-12T10:03:00.000Z",
              "unreferenced-provided",
            ),
          ],
          [],
          [unrelatedSnapshot],
        ),
      ).toThrowError(
        expect.objectContaining({
          name: "SourceSnapshotEventInvariantError",
        }),
      );
      expect(countSourceReadEvents(workspace.runtimeHome, secondRun.runId)).toBe(0);
      expect(countSourceSnapshots(workspace.runtimeHome)).toBe(1);
    } finally {
      store.close();
    }
  });

  it("rejects mismatched succeeded references and provided registry metadata", async () => {
    const fixture = await createApprovedRun();
    const canonicalRuntimeHome = await realpath(fixture.runtimeHome);
    const artifacts = new ContentAddressedArtifactStore(canonicalRuntimeHome);
    const referencedSnapshot = await artifacts.putSourceSnapshot(
      fixture.sourceBytes,
      "2026-08-12T10:04:00.000Z",
    );
    const mismatchedSnapshot = await artifacts.putSourceSnapshot(
      Buffer.from("different source bytes\n", "utf8"),
      "2026-08-12T10:04:00.000Z",
    );
    const store = new SqliteRunStore(canonicalRuntimeHome);

    try {
      expect(() =>
        store.appendEvents(
          fixture.runId,
          4,
          [
            successfulSourceEvent(
              fixture.runId,
              readWholeRequest("fixture.md", 1),
              referencedSnapshot,
              "2026-08-12T10:04:00.000Z",
              "mismatched",
            ),
          ],
          [],
          [mismatchedSnapshot],
        ),
      ).toThrowError(
        expect.objectContaining({
          name: "SourceSnapshotEventInvariantError",
        }),
      );
      expect(countSourceReadEvents(fixture.runtimeHome, fixture.runId)).toBe(0);
      expect(countSourceSnapshots(fixture.runtimeHome)).toBe(0);
    } finally {
      store.close();
    }
  });

  it("atomically registers matching metadata and later reuses the exact registry row", async () => {
    const workspace = await createWorkspace();
    const firstRun = await createApprovedRun({ workspace });
    const secondRun = await createApprovedRun({ workspace });
    const canonicalRuntimeHome = await realpath(workspace.runtimeHome);
    const artifacts = new ContentAddressedArtifactStore(canonicalRuntimeHome);
    const snapshot = await artifacts.putSourceSnapshot(
      firstRun.sourceBytes,
      "2026-08-12T10:05:00.000Z",
    );
    const store = new SqliteRunStore(canonicalRuntimeHome);

    try {
      const firstProjection = store.appendEvents(
        firstRun.runId,
        4,
        [
          successfulSourceEvent(
            firstRun.runId,
            readWholeRequest("fixture.md", 1),
            snapshot,
            "2026-08-12T10:05:00.000Z",
            "atomic-register",
          ),
        ],
        [],
        [snapshot],
      );
      expect(firstProjection.lastEventSequence).toBe(5);
      expect(countSourceSnapshots(workspace.runtimeHome)).toBe(1);

      const secondProjection = store.appendEvents(
        secondRun.runId,
        4,
        [
          successfulSourceEvent(
            secondRun.runId,
            readWholeRequest("fixture.md", 1),
            snapshot,
            "2026-08-12T10:06:00.000Z",
            "reuse-existing",
          ),
        ],
      );
      expect(secondProjection.lastEventSequence).toBe(5);
      expect(countSourceSnapshots(workspace.runtimeHome)).toBe(1);
    } finally {
      store.close();
    }
  });

  it("rejects a succeeded reference that mismatches an existing registry row", async () => {
    const workspace = await createWorkspace();
    const firstRun = await createApprovedRun({ workspace });
    const secondRun = await createApprovedRun({ workspace });
    const canonicalRuntimeHome = await realpath(workspace.runtimeHome);
    const artifacts = new ContentAddressedArtifactStore(canonicalRuntimeHome);
    const snapshot = await artifacts.putSourceSnapshot(
      firstRun.sourceBytes,
      "2026-08-12T10:07:00.000Z",
    );
    const store = new SqliteRunStore(canonicalRuntimeHome);

    try {
      store.appendEvents(
        firstRun.runId,
        4,
        [
          successfulSourceEvent(
            firstRun.runId,
            readWholeRequest("fixture.md", 1),
            snapshot,
            "2026-08-12T10:07:00.000Z",
            "existing-registry",
          ),
        ],
        [],
        [snapshot],
      );
      const mismatchedReference = {
        ...snapshot,
        byteLength: snapshot.byteLength + 1,
      };

      expect(() =>
        store.appendEvents(
          secondRun.runId,
          4,
          [
            successfulSourceEvent(
              secondRun.runId,
              readWholeRequest("fixture.md", 1),
              mismatchedReference,
              "2026-08-12T10:08:00.000Z",
              "existing-mismatch",
            ),
          ],
        ),
      ).toThrowError(
        expect.objectContaining({
          name: "SourceSnapshotEventInvariantError",
        }),
      );
      expect(countSourceReadEvents(workspace.runtimeHome, secondRun.runId)).toBe(0);
      expect(countSourceSnapshots(workspace.runtimeHome)).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("source_read_observed schema and reducer boundary", () => {
  it("rejects extra nested snapshot metadata during direct reducer replay", async () => {
    const fixture = await createApprovedRun();
    const runtime = openReadingRuntime(fixture.runtimeHome);
    await runtime.readSource({
      runId: fixture.runId,
      request: readWholeRequest("fixture.md", 1),
    });
    runtime.close();
    const events = readResearchRunEvents(fixture.runtimeHome, fixture.runId);
    const sourceEvent = sourceReadEventOf(events);
    if (sourceEvent.payload.observation.status !== "succeeded") {
      throw new Error("测试要求 succeeded source_read_observed");
    }
    const tampered = {
      ...sourceEvent,
      payload: {
        observation: {
          ...sourceEvent.payload.observation,
          sourceSnapshot: {
            ...sourceEvent.payload.observation.sourceSnapshot,
            createdAt: "2026-08-12T08:00:00.000Z",
          },
        },
      },
    } as ResearchRunEvent;

    expect(() => reduceRunEvents([...events.slice(0, 4), tampered])).toThrow(
      IllegalRunEventError,
    );
  });

  it.each(["denied", "failed"] as const)(
    "rejects a non-stable %s code during direct reducer replay",
    async (status) => {
      const fixture = await createApprovedRun();
      const runtime = openReadingRuntime(fixture.runtimeHome);
      await runtime.readSource({
        runId: fixture.runId,
        request: readWholeRequest("fixture.md", 1),
      });
      runtime.close();
      const events = readResearchRunEvents(fixture.runtimeHome, fixture.runId);
      const sourceEvent = sourceReadEventOf(events);
      const observation = sourceEvent.payload.observation;
      const tamperedObservation = {
        observationId: observation.observationId,
        toolCallId: observation.toolCallId,
        toolName: observation.toolName,
        requestHash: observation.requestHash,
        observedAt: observation.observedAt,
        status,
        code: "unstable_internal_detail",
      } as unknown as SourceReadObservation;
      const tampered = {
        ...sourceEvent,
        payload: { observation: tamperedObservation },
      } as ResearchRunEvent;

      expect(() => reduceRunEvents([...events.slice(0, 4), tampered])).toThrow(
        IllegalRunEventError,
      );
    },
  );

  it("keeps denied and failed event payloads strict at the schema boundary", async () => {
    const fixture = await createApprovedRun();
    const runtime = openReadingRuntime(fixture.runtimeHome);
    await runtime.readSource({
      runId: fixture.runId,
      request: readWholeRequest("missing.md", 1),
    });
    runtime.close();
    const failedEvent = sourceReadEventOf(
      readResearchRunEvents(fixture.runtimeHome, fixture.runId),
    );

    expect(() =>
      parseResearchRunEvent({
        ...failedEvent,
        payload: {
          observation: {
            ...failedEvent.payload.observation,
            excerpt: "must not persist",
          },
        },
      }),
    ).toThrow();
  });

  it("rejects direct tampering of event time, request, excerpt, snapshot, path, range, and bytes", async () => {
    const fixture = await createApprovedRun();
    const runtime = openReadingRuntime(fixture.runtimeHome);
    await runtime.readSource({
      runId: fixture.runId,
      request: readWholeRequest("fixture.md", 1),
    });
    runtime.close();
    const events = readResearchRunEvents(fixture.runtimeHome, fixture.runId);
    const sourceEvent = sourceReadEventOf(events);
    if (sourceEvent.payload.observation.status !== "succeeded") {
      throw new Error("测试要求 succeeded source_read_observed");
    }
    const observation = sourceEvent.payload.observation;
    const tamperCases = [
      [
        "event time",
        {
          ...observation,
          observedAt: new Date(
            Date.parse(sourceEvent.occurredAt) + 1,
          ).toISOString(),
        },
      ],
      ["request hash", { ...observation, requestHash: "0".repeat(64) }],
      ["excerpt hash", { ...observation, excerptHash: "0".repeat(64) }],
      [
        "snapshot hash",
        {
          ...observation,
          sourceSnapshot: { ...observation.sourceSnapshot, sha256: "0".repeat(64) },
        },
      ],
      [
        "normalized path",
        {
          ...observation,
          relativePath: "./fixture.md",
          requestHash: hashCanonicalJson({
            rootIndex: observation.rootIndex,
            relativePath: "./fixture.md",
            startLine: observation.startLine,
            endLine: observation.endLine,
          }),
        },
      ],
      [
        "range",
        {
          ...observation,
          endLine: observation.totalLines + 1,
          requestHash: hashCanonicalJson({
            rootIndex: observation.rootIndex,
            relativePath: observation.relativePath,
            startLine: observation.startLine,
            endLine: observation.totalLines + 1,
          }),
        },
      ],
      ["byte length", { ...observation, byteLength: observation.byteLength + 1 }],
    ] as const;

    for (const [name, tamperedObservation] of tamperCases) {
      const tampered = {
        ...sourceEvent,
        payload: { observation: tamperedObservation },
      } as ResearchRunEvent;
      expect(
        () => reduceRunEvents([...events.slice(0, 4), tampered]),
        name,
      ).toThrow(IllegalRunEventError);
    }
  });

  it.each(["observationId", "toolCallId"] as const)(
    "rejects a duplicate %s during direct replay",
    async (duplicateField) => {
      const fixture = await createApprovedRun();
      const runtime = openReadingRuntime(fixture.runtimeHome);
      await runtime.readSource({
        runId: fixture.runId,
        request: readWholeRequest("fixture.md", 1),
      });
      runtime.close();
      const events = readResearchRunEvents(fixture.runtimeHome, fixture.runId);
      const first = sourceReadEventOf(events);
      const secondObservedAt = "2026-08-12T09:00:00.000Z";
      const secondObservation = {
        ...first.payload.observation,
        observationId:
          duplicateField === "observationId"
            ? first.payload.observation.observationId
            : "observation-second",
        toolCallId:
          duplicateField === "toolCallId"
            ? first.payload.observation.toolCallId
            : "tool-call-second",
        observedAt: secondObservedAt,
      };
      const duplicateEvent = {
        ...first,
        eventId: "event-source-second",
        sequence: 6,
        occurredAt: secondObservedAt,
        payload: { observation: secondObservation },
      } as ResearchRunEvent;

      expect(() => reduceRunEvents([...events, duplicateEvent])).toThrow(
        IllegalRunEventError,
      );
    },
  );

  it.each([
    ["Source Scope", { maxTotalBytes: DEFAULT_SOURCE_BYTES.byteLength, maxSourceBytes: 8_192 }],
    ["Run Budget", { maxTotalBytes: 8_192, maxSourceBytes: DEFAULT_SOURCE_BYTES.byteLength }],
  ] as const)(
    "rejects direct cumulative bytes beyond the smaller %s limit",
    async (_name, limits) => {
      const fixture = await createApprovedRun(limits);
      const runtime = openReadingRuntime(fixture.runtimeHome);
      await runtime.readSource({
        runId: fixture.runId,
        request: readWholeRequest("fixture.md", 1),
      });
      runtime.close();
      const events = readResearchRunEvents(fixture.runtimeHome, fixture.runId);
      const first = sourceReadEventOf(events);
      const secondObservedAt = "2026-08-12T09:00:00.000Z";
      const duplicateEvent = {
        ...first,
        eventId: "event-source-budget-overflow",
        sequence: 6,
        occurredAt: secondObservedAt,
        payload: {
          observation: {
            ...first.payload.observation,
            observationId: "observation-budget-overflow",
            toolCallId: "tool-call-budget-overflow",
            observedAt: secondObservedAt,
          },
        },
      } as ResearchRunEvent;

      expect(() => reduceRunEvents([...events, duplicateEvent])).toThrow(
        /批准累计字节限制/,
      );
    },
  );
});

interface TestWorkspace {
  /** 当前测试唯一的临时父目录。 */
  readonly baseDirectory: string;
  /** 私有 SQLite 与 Artifact Store 所在的 Runtime Home。 */
  readonly runtimeHome: string;
  /** Source Scope 审批使用的真实本地根目录。 */
  readonly sourceRoot: string;
}

interface CreateApprovedRunOptions {
  /** 可复用的工作区，用于同一 Runtime Home 创建多个 Run。 */
  readonly workspace?: TestWorkspace;
  /** 覆盖 Source Scope 的单文件上限。 */
  readonly maxFileBytes?: number;
  /** 覆盖 Source Scope 的累计字节上限。 */
  readonly maxTotalBytes?: number;
  /** 覆盖 Run Budget 的累计源字节上限。 */
  readonly maxSourceBytes?: number;
  /** 覆盖 Source Scope 的排除模式。 */
  readonly exclusions?: readonly string[];
  /** 覆盖 Source Scope 的扩展名 allowlist。 */
  readonly allowedExtensions?: readonly string[];
}

interface ApprovedRunFixture extends TestWorkspace {
  /** 已持久化计划审批的 Research Run identity。 */
  readonly runId: string;
  /** fixture.md 的完整原始 UTF-8 字节。 */
  readonly sourceBytes: Buffer;
  /** Run 创建后冻结记录的 canonical Source Scope。 */
  readonly sourceScope: RunProjection["sourceScope"];
}

interface WaitingRunFixture {
  /** 尚未批准、用于非法状态测试的 Research Run identity。 */
  readonly runId: string;
}

interface SourceSnapshotRow {
  /** SQLite 独立 registry 中的 Source Snapshot identity。 */
  readonly snapshot_id: string;
  /** 完整源字节的 SHA-256 摘要。 */
  readonly sha256: string;
  /** registry 中冻结记录的 UTF-8 media type。 */
  readonly media_type: string;
  /** registry 中冻结记录的完整源字节数。 */
  readonly byte_length: number;
  /** registry 中相对 Runtime Home 的私有路径。 */
  readonly relative_path: string;
  /** Source Snapshot 首次登记的 ISO 时间。 */
  readonly created_at: string;
}

interface JournalEventRow {
  /** Journal 中事件的稳定 identity。 */
  readonly event_id: string;
  /** Journal 中从 1 开始的连续序号。 */
  readonly sequence: number;
  /** Journal 中的语义事件类型。 */
  readonly type: string;
  /** Journal 中的 ISO 8601 UTC 事件时间。 */
  readonly occurred_at: string;
  /** Journal 中已消毒事件载荷的 JSON 文本。 */
  readonly payload_json: string;
}

async function createWorkspace(): Promise<TestWorkspace> {
  const baseDirectory = await mkdtemp(join(tmpdir(), "source-read-runtime-"));
  temporaryDirectories.push(baseDirectory);
  const runtimeHome = join(baseDirectory, "runtime");
  const sourceRoot = join(baseDirectory, "sources");
  await mkdir(sourceRoot, { recursive: true });
  return { baseDirectory, runtimeHome, sourceRoot };
}

async function createApprovedRun(
  options: CreateApprovedRunOptions = {},
): Promise<ApprovedRunFixture> {
  const workspace = options.workspace ?? (await createWorkspace());
  const sourceBytes = DEFAULT_SOURCE_BYTES;
  const fixturePath = join(workspace.sourceRoot, "fixture.md");
  try {
    await readFile(fixturePath);
  } catch {
    await writeFile(fixturePath, sourceBytes);
  }
  const waiting = await createWaitingRun(workspace, options);
  const runtime = openReadingRuntime(workspace.runtimeHome);
  try {
    const projection = await runtime.inspectRun({ runId: waiting.runId });
    if (projection.state.type !== "waiting_plan_approval") {
      throw new Error("测试要求 Run 等待计划审批");
    }
    const approved = await runtime.approvePlan({
      runId: waiting.runId,
      bindingHash: projection.state.approvalBinding.bindingHash,
    });
    return {
      ...workspace,
      runId: approved.runId,
      sourceBytes,
      sourceScope: approved.sourceScope,
    };
  } finally {
    runtime.close();
  }
}

async function createWaitingRun(
  workspace: TestWorkspace,
  options: CreateApprovedRunOptions = {},
): Promise<WaitingRunFixture> {
  const runtime = ResearchAgentRuntime.open({
    runtimeHome: workspace.runtimeHome,
    model: new ScriptedModel([
      {
        title: "读取批准来源",
        objectives: ["冻结显式读取的精确字节"],
        steps: [{ id: "step-001", description: "读取 fixture.md" }],
      },
    ]),
  });
  try {
    const waiting = await runtime.createRun({
      question: "如何持久化来源读取事实？",
      sourceScope: {
        roots: [workspace.sourceRoot],
        exclusions: options.exclusions ?? ["excluded/**"],
        allowedExtensions: options.allowedExtensions ?? [".md"],
        maxFileBytes: options.maxFileBytes ?? 4_096,
        maxTotalBytes: options.maxTotalBytes ?? 8_192,
      },
      runBudget: runBudget(options.maxSourceBytes ?? 8_192),
    });
    return { runId: waiting.runId };
  } finally {
    runtime.close();
  }
}

function runBudget(maxSourceBytes: number): RunBudget {
  return {
    version: "budget-v1",
    maxModelTurns: 8,
    maxToolCalls: 24,
    maxDistinctSources: 12,
    maxSourceBytes,
    maxWallTimeMs: 300_000,
  };
}

function openReadingRuntime(runtimeHome: string): ResearchAgentRuntime {
  return ResearchAgentRuntime.open({
    runtimeHome,
    model: new ScriptedModel([]),
  });
}

function readWholeRequest(relativePath: string, endLine: number) {
  return { rootIndex: 0, relativePath, startLine: 1, endLine } as const;
}

function researchingStateOf(projection: RunProjection) {
  if (projection.state.type !== "researching") {
    throw new Error("测试要求 researching Projection");
  }
  return projection.state;
}

function onlySuccessfulObservation(projection: RunProjection) {
  const observations = researchingStateOf(projection).sourceReadObservations;
  expect(observations).toHaveLength(1);
  const observation = observations[0];
  if (observation?.status !== "succeeded") {
    throw new Error("测试要求唯一 observation 为 succeeded");
  }
  return observation;
}

function lastSuccessfulObservation(projection: RunProjection) {
  const observation = lastObservation(projection);
  if (observation.status !== "succeeded") {
    throw new Error("测试要求最后一个 observation 为 succeeded");
  }
  return observation;
}

function lastObservation(projection: RunProjection) {
  const observation = researchingStateOf(projection).sourceReadObservations.at(-1);
  if (observation === undefined) {
    throw new Error("测试要求至少一个 Source Read Observation");
  }
  return observation;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Utf8(text: string): string {
  return sha256Bytes(Buffer.from(text, "utf8"));
}

function countSourceSnapshots(runtimeHome: string): number {
  return readCount(runtimeHome, "source_snapshots");
}

function countArtifacts(runtimeHome: string): number {
  return readCount(runtimeHome, "artifacts");
}

function readCount(runtimeHome: string, table: "source_snapshots" | "artifacts"): number {
  const database = new Database(join(runtimeHome, "runtime.sqlite"), { readonly: true });
  try {
    return (
      database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        /** 请求 registry 当前持久化的行数。 */
        readonly count: number;
      }
    ).count;
  } finally {
    database.close();
  }
}

function countSourceReadEvents(runtimeHome: string, runId: string): number {
  const database = new Database(join(runtimeHome, "runtime.sqlite"), { readonly: true });
  try {
    return (
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'source_read_observed'",
        )
        .get(runId) as {
        /** 当前 Run 已持久化的 source_read_observed 事件数。 */
        readonly count: number;
      }
    ).count;
  } finally {
    database.close();
  }
}

function readSourceSnapshotRow(runtimeHome: string): SourceSnapshotRow {
  const database = new Database(join(runtimeHome, "runtime.sqlite"), { readonly: true });
  try {
    const row = database.prepare("SELECT * FROM source_snapshots").get() as
      | SourceSnapshotRow
      | undefined;
    if (row === undefined) {
      throw new Error("测试要求 Source Snapshot registry 存在一行");
    }
    return row;
  } finally {
    database.close();
  }
}

async function snapshotFiles(runtimeHome: string): Promise<string[]> {
  try {
    return (await readdir(join(runtimeHome, "source-snapshots"), { recursive: true }))
      .map(String)
      .sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function readResearchRunEvents(
  runtimeHome: string,
  runId: string,
): ResearchRunEvent[] {
  const database = new Database(join(runtimeHome, "runtime.sqlite"), {
    readonly: true,
  });
  try {
    const rows = database
      .prepare(
        `SELECT event_id, sequence, type, occurred_at, payload_json
           FROM run_events
          WHERE run_id = ?
          ORDER BY sequence`,
      )
      .all(runId) as JournalEventRow[];
    return rows.map((row) =>
      parseResearchRunEvent({
        eventId: row.event_id,
        runId,
        sequence: row.sequence,
        type: row.type,
        occurredAt: row.occurred_at,
        payload: JSON.parse(row.payload_json),
      }),
    );
  } finally {
    database.close();
  }
}

function sourceReadEventOf(events: readonly ResearchRunEvent[]) {
  const event = events.find(({ type }) => type === "source_read_observed");
  if (event?.type !== "source_read_observed") {
    throw new Error("测试要求 source_read_observed 事件");
  }
  return event;
}

function successfulSourceEvent(
  runId: string,
  request: ReturnType<typeof readWholeRequest>,
  snapshot: Awaited<ReturnType<ContentAddressedArtifactStore["putSourceSnapshot"]>>,
  observedAt: string,
  identitySuffix: string,
): ResearchRunEvent {
  const { createdAt: _createdAt, ...sourceSnapshot } = snapshot;
  return {
    eventId: `event-source-${identitySuffix}`,
    runId,
    sequence: 5,
    type: "source_read_observed",
    occurredAt: observedAt,
    payload: {
      observation: {
        observationId: `observation-${identitySuffix}`,
        toolCallId: `tool-call-${identitySuffix}`,
        toolName: "read_source",
        requestHash: hashCanonicalJson(request),
        observedAt,
        status: "succeeded",
        rootIndex: request.rootIndex,
        relativePath: request.relativePath,
        startLine: request.startLine,
        endLine: request.endLine,
        totalLines: 5,
        excerpt: "first line",
        excerptHash: sha256Utf8("first line"),
        sourceSnapshot,
        byteLength: snapshot.byteLength,
      },
    },
  };
}

function nonSuccessfulSourceEvent(
  runId: string,
  status: "denied" | "failed",
  observedAt: string,
): ResearchRunEvent {
  const common = {
    observationId: `observation-${status}`,
    toolCallId: `tool-call-${status}`,
    toolName: "read_source" as const,
    requestHash: "a".repeat(64),
    observedAt,
  };
  const observation =
    status === "denied"
      ? {
          ...common,
          status: "denied" as const,
          code: "invalid_path" as const,
        }
      : {
          ...common,
          status: "failed" as const,
          code: "source_not_found" as const,
        };
  return {
    eventId: `event-source-${status}`,
    runId,
    sequence: 5,
    type: "source_read_observed",
    occurredAt: observedAt,
    payload: {
      observation,
    },
  };
}

function createReadBoundaries(
  suffix: string,
  timestamps: readonly string[],
) {
  let clockCalls = 0;
  let eventCalls = 0;
  let observationCalls = 0;
  let toolCallCalls = 0;
  const ids: IdGenerator = {
    nextRunId: () => {
      throw new Error("readSource 不得生成 Run ID");
    },
    nextApprovalId: () => {
      throw new Error("readSource 不得生成 Approval ID");
    },
    nextEventId: () => {
      eventCalls += 1;
      return `event-${suffix}-${eventCalls}`;
    },
    nextObservationId: () => {
      observationCalls += 1;
      return `observation-${suffix}-${observationCalls}`;
    },
    nextToolCallId: () => {
      toolCallCalls += 1;
      return `tool-call-${suffix}-${toolCallCalls}`;
    },
  };
  return {
    clock: {
      now: () => {
        const value = timestamps[clockCalls];
        clockCalls += 1;
        if (value === undefined) {
          throw new Error("readSource 消费了额外 clock 值");
        }
        return value;
      },
    },
    ids,
    calls: () => ({
      clock: clockCalls,
      event: eventCalls,
      observation: observationCalls,
      toolCall: toolCallCalls,
    }),
  };
}

function corruptJournalEvent(
  runtimeHome: string,
  runId: string,
  secretPayload: string,
): void {
  const database = new Database(join(runtimeHome, "runtime.sqlite"));
  try {
    database.exec("DROP TRIGGER run_events_are_append_only_on_update");
    database
      .prepare(
        "UPDATE run_events SET payload_json = ? WHERE run_id = ? AND sequence = 3",
      )
      .run(JSON.stringify({ secretPayload }), runId);
  } finally {
    database.close();
  }
}
