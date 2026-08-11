import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import ts from "typescript";

/** 单个 TypeScript 源文本审计所需输入。 */
export interface TypeScriptAuditInput {
  /** 用于诊断定位的文件名，不要求文件真实存在。 */
  readonly fileName: string;
  /** 要解析并检查的完整 TypeScript 源文本。 */
  readonly sourceText: string;
}

/** 一个未满足逐字段 TSDoc 约束的可机器读取诊断。 */
export interface FieldDocIssue {
  /** 相对项目根或调用方提供的源文件名。 */
  readonly fileName: string;
  /** 缺少说明的属性签名名称。 */
  readonly fieldName: string;
  /** 属性签名所在的 1-based 行号。 */
  readonly line: number;
  /** 稳定问题代码，便于 CI 与负向 fixture 断言。 */
  readonly reason: "missing-field-tsdoc" | "insufficient-field-tsdoc";
}

export function auditTypeScriptFieldDocs(
  input: TypeScriptAuditInput,
): FieldDocIssue[] {
  const sourceFile = ts.createSourceFile(
    input.fileName,
    input.sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: FieldDocIssue[] = [];

  function visit(node: ts.Node): void {
    if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) {
      const docs = ts.getJSDocCommentsAndTags(node);
      const line =
        sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile))
          .line + 1;
      if (docs.length === 0) {
        issues.push({
          fileName: input.fileName,
          fieldName: node.name.getText(sourceFile),
          line,
          reason: "missing-field-tsdoc",
        });
      } else if (!docs.some((doc) => hasMeaningfulText(doc.getText(sourceFile)))) {
        issues.push({
          fileName: input.fileName,
          fieldName: node.name.getText(sourceFile),
          line,
          reason: "insufficient-field-tsdoc",
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return issues;
}

export async function auditProjectTypeScriptFieldDocs(
  projectRoot: string,
): Promise<FieldDocIssue[]> {
  const files = await collectTypeScriptFiles(projectRoot);
  const issueGroups = await Promise.all(
    files.map(async (fileName) =>
      auditTypeScriptFieldDocs({
        fileName: relative(projectRoot, fileName),
        sourceText: await readFile(fileName, "utf8"),
      }),
    ),
  );
  return issueGroups.flat();
}

function hasMeaningfulText(rawDoc: string): boolean {
  const content = rawDoc
    .replace(/^\/\*\*|\*\/$/g, "")
    .replace(/^\s*\*\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return content.length >= 8 && !/^TODO\b/i.test(content);
}

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === ".runtime"
    ) {
      continue;
    }
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(entryPath)));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(entryPath);
    }
  }

  return files;
}
