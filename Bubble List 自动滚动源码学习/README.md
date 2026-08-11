# Bubble List 自动滚动源码课程

这是一套从浏览器几何和自然锚定逐步走向显式跟随状态、事件仲裁与可验证控制器的源码课程。legacy synthetic-scroll 与虚拟列表测量作为两条进阶支线，不再阻塞普通聊天 UI 的主线学习。

## 从这里开始

先阅读[学习路线与章节目录](00-learning-guide.md)。主线是：

```text
Ant Design X：column-reverse 与自然锚定
  → use-stick-to-bottom：following / escape 状态机
  → assistant-ui：程序化意图与事件仲裁
  → 推荐的两轴控制器
  → 浏览器竞态测试实验
```

完成第 3 章后，可按需要插入两条支线：

- 浏览器事件不可观测：react-scroll-to-bottom；
- 超长会话：React Virtuoso。

## 正文章节

1. [Ant Design X：自然锚定、sentinel 与 resize 补偿](01-ant-design-x.md)
2. [use-stick-to-bottom：显式跟随与用户逃逸](02-use-stick-to-bottom.md)
3. [assistant-ui：pending bottom intent 与事件仲裁](03-assistant-ui.md)
4. [核心设计：两轴状态模型与推荐控制器](04-controller-model.md)
5. [综合实践：自动滚动竞态测试实验](05-scroll-race-testing-lab.md)

## 进阶支线

- [进阶 A：react-scroll-to-bottom 与 synthetic scroll](advanced-a-react-scroll-to-bottom.md)
- [进阶 B：React Virtuoso 与虚拟测量](advanced-b-react-virtuoso.md)

## 每章怎样学习

每章都围绕同一组问题：

- `isAtBottom` 与 `isFollowing` 是否分离？
- 程序化滚动意图怎样建立、完成和取消？
- 用户手势、内容 resize 和浏览器 synthetic scroll 怎样区分？
- 新消息、流式 token、图片加载、prepend 和虚拟测量分别触发什么？
- 哪些时间窗口是启发式，怎样用真实浏览器测试？

完成练习后再查看[答案要点与状态 Trace](SOLUTIONS.md)，核对规范状态术语和必测不变量。

## 源码证据入口

需要回查实现细节时，从对应章节中的固定 commit 链接进入源码：

- [Ant Design X 源码路径与测试](01-ant-design-x.md)
- [use-stick-to-bottom 源码路径与状态机](02-use-stick-to-bottom.md)
- [assistant-ui 源码路径与事件仲裁](03-assistant-ui.md)
- [react-scroll-to-bottom 浏览器竞态证据](advanced-a-react-scroll-to-bottom.md)
- [React Virtuoso 测量系统](advanced-b-react-virtuoso.md)

## 证据边界

- 源码事实固定到 commit；
- 教学代码保留状态与时序语义，但不是可直接发布的完整 hook；
- JSDOM 几何 mock 不能替代 WebKit/iOS 惯性滚动、软键盘和真实 selection；
- “长列表”没有统一消息数量阈值，应以 item 复杂度、设备和测量预算决定是否虚拟化。
