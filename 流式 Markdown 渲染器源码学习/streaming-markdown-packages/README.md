# 流式 Markdown 渲染器源码课程

这是一套从普通 Markdown 编译器逐步走向流式解析、稳定节点复用和产品级降级策略的源码课程。学习目标不是记住六个包的 API，而是能够独立判断一次更新究竟复用了 parser state、token、AST、React node 还是 DOM。

## 从这里开始

先阅读[学习路线与章节目录](00-learning-guide.md)。核心路径是：

```text
Marked
  → react-markdown
  → streaming-markdown
  → Ant Design X Markdown
  → Streamdown
  → markstream-react
  → 架构比较
  → 浏览器兼容与降级
  → 核心综合实践
```

顺序背后的原则：

1. 先理解一次完整 Markdown 编译发生了什么；
2. 再理解 AST 怎样进入 React；
3. 然后学习真正跨 chunk 保存状态的 parser；
4. 对照三种 React 工程折中：尾部识别、块级复用、三层复用；
5. 最后实现并验证自己的流式 renderer。

## 正文章节

### 第一部分：建立非流式基线

1. [Marked：lexer、token 与 renderer](01-marked.md)
2. [react-markdown：mdast、hast 与 React](02-react-markdown.md)

### 第二部分：理解真正的增量解析

3. [streaming-markdown：跨 chunk 状态机与 append DOM](03-streaming-markdown.md)

### 第三部分：React 产品中的三种折中

4. [Ant Design X Markdown：增量尾部识别与全文输出](04-ant-design-x-markdown.md)
5. [Streamdown：全文修复、词法分块与块级复用](05-streamdown.md)
6. [markstream-react：parser、结构节点与 React 三层复用](06-markstream-react.md)

### 第四部分：整合与实践

7. [架构比较：五种渲染模型与选型边界](07-comparison.md)
8. [低版本浏览器与 iOS：能力检测和 final-only 降级](08-legacy-browser-compatibility.md)
9. [核心综合实践：实现最小流式 Markdown Renderer](09-capstone-streaming-renderer.md)

## 每章怎样学习

每章都应完成四件事：

- 画出本次更新经过的 parser、AST、React 或 DOM 路径；
- 分清累计全文输入与新增 chunk 输入；
- 推演一次未闭语法、非前缀改写或 final 切换；
- 完成练习，并用 chunk-invariance、final equivalence 和节点 identity 验收。

练习使用[固定 fixture 与最小骨架](EXERCISE-FIXTURES.md)；完成后再查看[答案要点与常见错误](SOLUTIONS.md)，用于校准 trace、计数和失效条件。

## 研究附录

[源码证据附录](../streaming-markdown-renderers-research.md)保留固定提交、社区快照、测试证据和 benchmark 审计。它用于查证，不参与第一次阅读顺序。

## 证据边界

- 源码链接固定到调研提交；
- 等价伪代码用于解释控制流，不是逐字上游代码；
- 复杂度结论来自源码路径，不能代替真实消息长度、插件和设备上的 profiling；
- 外部库的测试通过不能证明你的传输、React 提交和浏览器降级路径正确。
