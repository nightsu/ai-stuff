#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function collectMarkdown(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectMarkdown(absolute)));
    else if (entry.name.endsWith(".md")) files.push(absolute);
  }
  return files;
}

const missing = [];
const markdownFiles = await collectMarkdown(repoRoot);
const linkPattern = /!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

for (const file of markdownFiles) {
  const content = await fs.readFile(file, "utf8");
  for (const match of content.matchAll(linkPattern)) {
    let destination = match[1];
    if (destination.startsWith("<") && destination.endsWith(">")) destination = destination.slice(1, -1);
    if (/^(https?:|mailto:|data:|#)/i.test(destination)) continue;

    const pathPart = destination.split("#", 1)[0].split("?", 1)[0];
    if (!pathPart) continue;

    let decoded;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      missing.push(`${path.relative(repoRoot, file)}: invalid URL encoding in ${destination}`);
      continue;
    }

    const target = path.resolve(path.dirname(file), decoded);
    try {
      await fs.access(target);
    } catch {
      missing.push(`${path.relative(repoRoot, file)}: ${destination}`);
    }
  }
}

if (missing.length > 0) {
  console.error("Broken local Markdown links:");
  for (const item of missing) console.error(`- ${item}`);
  process.exit(1);
}

console.log("Local Markdown links passed.");
