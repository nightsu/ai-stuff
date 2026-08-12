/** 与 renderer 唯一合法 citation 形状一致的、需要拒绝的预渲染 token。 */
const renderedCitationPattern = /【\s*evidence\s*:/iu;

/** 判断调用方或模型文本是否冒充 renderer 生成的结构化 Evidence citation。 */
export function hasPreRenderedCitationToken(value: string): boolean {
  return renderedCitationPattern.test(value);
}

/** 非结构化文本试图插入 renderer 专属 citation token 时抛出的领域错误。 */
export class PreRenderedCitationTokenError extends Error {
  public constructor() {
    super("Learning Artifact 文本不能包含预渲染 Evidence citation");
    this.name = "PreRenderedCitationTokenError";
  }
}

/**
 * 保证可见的 `【Evidence: …】` 只由 renderer 从 Gate 选中的 Evidence Record 生成。
 * 这个运行时断言同时保护 schema 绕过的直接 reducer replay，不能只依赖 ModelPort 解析。
 */
export function assertNoPreRenderedCitationToken(
  values: readonly string[],
): void {
  if (values.some((value) => hasPreRenderedCitationToken(value))) {
    throw new PreRenderedCitationTokenError();
  }
}
