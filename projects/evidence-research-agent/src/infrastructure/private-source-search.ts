import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  SOURCE_DISCOVERY_SECRET_GLOBS,
  sourcePathPolicyDenial,
} from "../domain/source-policy.js";
import type { SourceScope, SourceSearchMatch } from "../domain/types.js";
import type { SourceSearchPort } from "../application/ports.js";
import {
  PrivateSourceAccess,
  sourceRootIdentityStillMatches,
} from "./private-source-access.js";

const execFileAsync = promisify(execFile);

/** `search_sources` 的 Harness-owned 结构化参数。 */
export interface SearchSourcesRequest {
  /** 传给固定参数 `rg` 的非空 literal query。 */
  readonly query: string;
  /** 全部批准 roots 合计返回的最大命中数。 */
  readonly maxResults: number;
}

/** 使用固定参数 `rg` 搜索批准本地文本，搜索命中本身不会创建 Source Snapshot。 */
export async function searchApprovedSources(
  scope: SourceScope,
  request: SearchSourcesRequest,
): Promise<readonly SourceSearchMatch[]> {
  const matches: SourceSearchMatch[] = [];
  const access = new PrivateSourceAccess(scope);
  for (const [rootIndex, root] of scope.roots.entries()) {
    if (matches.length >= request.maxResults) break;
    // `cwd` 本身就是搜索能力边界；必须在启动子进程前复核批准 identity，不能等
    // 命中后才发现同路径 root 已被替换并让 rg 扫描未经批准的目录。
    if (!(await sourceRootIdentityStillMatches(root))) {
      throw new Error("approved Source Root identity changed");
    }
    try {
      const { stdout } = await execFileAsync(
        "rg",
        [
          "--line-number",
          "--no-heading",
          "--color",
          "never",
          "--fixed-strings",
          "--hidden",
          "--no-ignore",
          "--max-filesize",
          String(scope.maxFileBytes),
          ...scope.allowedExtensions.flatMap((extension) => [
            "--glob",
            `*${extension}`,
          ]),
          ...scope.exclusions.flatMap((pattern) => ["--glob", `!${pattern}`]),
          ...SOURCE_DISCOVERY_SECRET_GLOBS.flatMap((pattern) => ["--glob", `!${pattern}`]),
          "--",
          request.query,
          ".",
        ],
        {
          cwd: root.canonicalPath,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        },
      );
      for (const line of stdout.split("\n")) {
        if (line === "" || matches.length >= request.maxResults) continue;
        const parsed = /^(?:\.\/)?(.+?):(\d+):(.*)$/.exec(line);
        if (parsed === null) continue;
        const relativePath = parsed[1];
        const lineNumber = Number(parsed[2]);
        const lineText = parsed[3];
        if (
          relativePath === undefined ||
          lineText === undefined ||
          !Number.isSafeInteger(lineNumber) ||
          sourcePathPolicyDenial(relativePath, scope) !== undefined
        ) {
          continue;
        }
        const preflight = await access.preflight(
          {
            rootIndex,
            relativePath,
            startLine: lineNumber,
            endLine: lineNumber,
          },
          Math.min(scope.maxFileBytes, scope.maxTotalBytes),
        );
        if (preflight.status !== "approved") continue;
        matches.push({
          rootIndex,
          relativePath,
          lineNumber,
          lineText: lineText.slice(0, 500),
        });
      }
    } catch (error) {
      if (!isRgNoMatches(error)) throw error;
    }
  }
  return matches;
}

/** 生产默认的固定参数 `rg` Source Search Port。 */
export class RgSourceSearch implements SourceSearchPort {
  public search(
    scope: SourceScope,
    request: SearchSourcesRequest,
  ): Promise<readonly SourceSearchMatch[]> {
    return searchApprovedSources(scope, request);
  }
}

function isRgNoMatches(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 1
  );
}
