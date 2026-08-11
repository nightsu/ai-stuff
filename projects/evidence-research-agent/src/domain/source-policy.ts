import {
  extname,
  isAbsolute,
  matchesGlob,
  posix,
  win32,
} from "node:path";

import type {
  ReadSourceRequest,
  SourceAccessDenialCode,
  SourceScope,
} from "./types.js";

/** Harness 固定拥有的单次 `read_source` 最大 1-based inclusive 行窗。 */
export const MAX_SOURCE_LINE_WINDOW = 200;

const CREDENTIAL_CONFIG_NAME =
  /^(?:credentials?|tokens?|secrets?)\.(?:json|ya?ml|toml|ini|conf|cfg)$/;
const SERVICE_ACCOUNT_CONFIG_NAME =
  /^service[-_]account(?:[-_][a-z0-9]+)*\.(?:json|ya?ml|toml|ini|conf|cfg)$/;

/** 在任何文件系统访问前执行可确定重放的 request 级策略判定。 */
export function sourceRequestDenial(
  request: ReadSourceRequest,
  rootCount: number,
  remainingSourceBytes: number,
): SourceAccessDenialCode | undefined {
  if (
    !Number.isSafeInteger(request.rootIndex) ||
    request.rootIndex < 0 ||
    request.rootIndex >= rootCount
  ) {
    return "invalid_root";
  }
  if (
    !Number.isSafeInteger(request.startLine) ||
    !Number.isSafeInteger(request.endLine) ||
    request.startLine <= 0 ||
    request.endLine < request.startLine
  ) {
    return "invalid_line_range";
  }
  if (request.endLine - request.startLine + 1 > MAX_SOURCE_LINE_WINDOW) {
    return "line_range_too_large";
  }
  if (
    !Number.isSafeInteger(remainingSourceBytes) ||
    remainingSourceBytes < 0
  ) {
    return "source_budget_exceeded";
  }
  if (!hasSafeRelativePathShape(request.relativePath)) {
    return "invalid_path";
  }
  if (request.relativePath.split("/").includes("..")) {
    return "path_escape";
  }
  if (!isNormalizedSourceRelativePath(request.relativePath)) {
    return "invalid_path";
  }
  return undefined;
}

/** 判断成功 observation 的规范相对路径是否仍满足冻结 Source Scope 的纯策略。 */
export function sourcePathMatchesApprovedPolicy(
  normalizedRelativePath: string,
  scope: SourceScope,
): boolean {
  return (
    isNormalizedSourceRelativePath(normalizedRelativePath) &&
    !isExcludedSourcePath(normalizedRelativePath, scope.exclusions) &&
    !isSecretSourcePath(normalizedRelativePath) &&
    hasAllowedSourceExtension(normalizedRelativePath, scope.allowedExtensions)
  );
}

/** 判断相对路径是否已是唯一、无 traversal 的 POSIX 表示。 */
export function isNormalizedSourceRelativePath(value: unknown): value is string {
  return (
    hasSafeRelativePathShape(value) &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    posix.normalize(value) === value
  );
}

/** 用批准时的保守 glob 规则判断规范相对路径是否应被排除。 */
export function isExcludedSourcePath(
  normalizedRelativePath: string,
  exclusions: readonly string[],
): boolean {
  const comparablePath = normalizeExclusionValue(normalizedRelativePath);
  return exclusions.some((pattern) => {
    try {
      return matchesGlob(comparablePath, normalizeExclusionValue(pattern));
    } catch {
      // 无法解释批准的排除表达式时宁可拒绝，不能把解析失败变成扩权。
      return true;
    }
  });
}

/** 应用 Harness 内建、大小写不敏感的 secret basename denylist。 */
export function isSecretSourcePath(normalizedRelativePath: string): boolean {
  const lowerPath = normalizedRelativePath.toLowerCase();
  const segments = lowerPath.split("/");
  const fileName = segments.at(-1) ?? "";

  if (
    fileName.startsWith(".env") ||
    fileName.endsWith(".pem") ||
    fileName.endsWith(".key")
  ) {
    return true;
  }
  if (
    [
      ".npmrc",
      ".pypirc",
      ".netrc",
      ".dockercfg",
      ".git-credentials",
      ".yarnrc.yml",
      "application_default_credentials.json",
      "service-account-key.json",
      "service_account_key.json",
    ].includes(fileName)
  ) {
    return true;
  }
  if (
    lowerPath === ".docker/config.json" ||
    lowerPath.endsWith("/.docker/config.json") ||
    lowerPath === ".config/gh/hosts.yml" ||
    lowerPath.endsWith("/.config/gh/hosts.yml")
  ) {
    return true;
  }
  return (
    CREDENTIAL_CONFIG_NAME.test(fileName) ||
    SERVICE_ACCOUNT_CONFIG_NAME.test(fileName)
  );
}

/** 判断规范相对路径的扩展名是否精确属于批准的小写 allowlist。 */
export function hasAllowedSourceExtension(
  normalizedRelativePath: string,
  allowedExtensions: readonly string[],
): boolean {
  const extension = extname(normalizedRelativePath);
  return (
    extension.length > 0 &&
    extension === extension.toLowerCase() &&
    allowedExtensions.some(
      (allowed) => allowed === allowed.toLowerCase() && allowed === extension,
    )
  );
}

function hasSafeRelativePathShape(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !isAbsolute(value) &&
    !posix.isAbsolute(value) &&
    !win32.isAbsolute(value)
  );
}

function normalizeExclusionValue(value: string): string {
  return value.normalize("NFC").toLowerCase();
}
