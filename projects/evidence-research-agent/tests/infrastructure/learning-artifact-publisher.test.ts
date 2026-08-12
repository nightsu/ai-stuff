import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LearningArtifactPublishError,
  LearningArtifactPublisher,
  PublicationTargetPreparationError,
} from "../../src/infrastructure/learning-artifact-publisher.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("LearningArtifactPublisher", () => {
  it("publishes exact Markdown once and treats an identical existing target as idempotent", async () => {
    const outputDirectory = await createTemporaryDirectory("publisher-output-");
    const targetPath = join(outputDirectory, "learning.md");
    const publisher = new LearningArtifactPublisher({ outputRoot: outputDirectory });
    const target = await publisher.prepareTarget(targetPath);
    const markdown = "# Learned\n\nEvidence-backed.\n";

    await publisher.publish(target, markdown);
    await publisher.publish(target, markdown);

    await expect(readFile(target.targetCanonicalPath, "utf8")).resolves.toBe(
      markdown,
    );
  });

  it("never overwrites different existing content and does not follow a final symlink", async () => {
    const outputDirectory = await createTemporaryDirectory("publisher-output-");
    const outsideDirectory = await createTemporaryDirectory("publisher-outside-");
    const targetPath = join(outputDirectory, "learning.md");
    const outsidePath = join(outsideDirectory, "outside.md");
    const publisher = new LearningArtifactPublisher({ outputRoot: outputDirectory });
    await writeFile(targetPath, "# Existing\n", "utf8");
    const existingTarget = await publisher.prepareTarget(targetPath);

    await expect(
      publisher.publish(existingTarget, "# Replacement\n"),
    ).rejects.toBeInstanceOf(LearningArtifactPublishError);
    await expect(readFile(targetPath, "utf8")).resolves.toBe("# Existing\n");

    await rm(targetPath);
    await writeFile(outsidePath, "outside bytes\n", "utf8");
    await symlink(outsidePath, targetPath);
    await expect(publisher.prepareTarget(targetPath)).rejects.toBeInstanceOf(
      PublicationTargetPreparationError,
    );
    await expect(readFile(outsidePath, "utf8")).resolves.toBe("outside bytes\n");
  });

  it("rejects publication when the approved parent directory identity was replaced", async () => {
    const root = await createTemporaryDirectory("publisher-root-");
    const outputDirectory = join(root, "output");
    const movedDirectory = join(root, "output-before-replace");
    await mkdir(outputDirectory);
    const publisher = new LearningArtifactPublisher({ outputRoot: outputDirectory });
    const target = await publisher.prepareTarget(join(outputDirectory, "learning.md"));

    await rename(outputDirectory, movedDirectory);
    await mkdir(outputDirectory);
    await expect(
      publisher.publish(target, "# Never published\n"),
    ).rejects.toBeInstanceOf(LearningArtifactPublishError);
    await expect(
      readFile(join(outputDirectory, "learning.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
