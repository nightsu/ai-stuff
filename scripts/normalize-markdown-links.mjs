#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function collectFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(absolute)));
    else files.push(absolute);
  }

  return files;
}

const allFiles = await collectFiles(repoRoot);
const markdownFiles = allFiles.filter((file) => file.endsWith(".md"));
const byRepoPath = new Map();
const byBasename = new Map();

for (const file of allFiles) {
  const relative = path.relative(repoRoot, file).split(path.sep).join("/");
  const withoutExtension = relative.replace(/\.[^/.]+$/, "");
  byRepoPath.set(withoutExtension, file);

  const basename = path.basename(withoutExtension);
  const candidates = byBasename.get(basename) ?? [];
  candidates.push(file);
  byBasename.set(basename, candidates);
}

const unresolved = [];

for (const file of markdownFiles) {
  const original = await fs.readFile(file, "utf8");
  const currentDirectory = path.dirname(file);

  const updated = original.replace(/\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (full, rawTarget, heading = "", alias) => {
    const target = rawTarget.trim();
    const repoCandidate = byRepoPath.get(target);
    const localCandidatePath = path.resolve(currentDirectory, `${target}.md`);
    const localCandidate = allFiles.includes(localCandidatePath) ? localCandidatePath : undefined;
    const basenameCandidates = byBasename.get(path.basename(target)) ?? [];
    const targetFile = repoCandidate ?? localCandidate ?? (basenameCandidates.length === 1 ? basenameCandidates[0] : undefined);

    if (!targetFile) {
      unresolved.push(`${path.relative(repoRoot, file)}: ${full}`);
      return full;
    }

    let relative = path.relative(currentDirectory, targetFile).split(path.sep).join("/");
    if (!relative.startsWith(".")) relative = `./${relative}`;
    const label = (alias ?? `${target}${heading}`).trim();
    return `[${label}](<${relative}${heading}>)`;
  });

  if (updated !== original) await fs.writeFile(file, updated);
}

if (unresolved.length > 0) {
  console.error("Unresolved Obsidian links:");
  for (const item of unresolved) console.error(`- ${item}`);
  process.exitCode = 1;
}
