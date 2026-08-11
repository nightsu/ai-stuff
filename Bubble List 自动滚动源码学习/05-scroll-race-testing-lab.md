# 第 5 章 综合实践：自动滚动竞态测试实验

> 必修先修：第 1–4 章。进阶 A 对应时间窗口实验，进阶 B 对应虚拟列表实验。

## 本章要解决的问题

状态模型看起来合理，并不代表它能经受浏览器事件乱序。怎样把 resize、scroll、pointer、selection、软键盘与虚拟测量的竞态变成可重复、可诊断的实验？

## 本章目标

围绕第 4 章的推荐控制器建立两层测试：

- **确定性状态测试**：使用 fake geometry 精确控制事件顺序；
- **真实浏览器 E2E**：在 Chromium 与 WebKit 中验证 anchoring、惯性、selection 和 resize。

## 本章练习：1. 定义可观察状态

```ts
type ScrollControllerState = {
  followMode: "FOLLOWING" | "USER_SCROLLING" | "DETACHED";
  atBottom: boolean;
  pendingIntent: null | {
    id: number;
    behavior: "instant" | "smooth";
    reason: "initial" | "send" | "button" | "conversation";
  };
  lastSource: "user" | "program" | "content" | "viewport" | "virtualizer";
};
```

测试不得只断言 `scrollTop`。还要断言系统为什么移动，以及之后是否仍承诺跟随。

## 2. 建立 fake geometry

```ts
type Geometry = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

const distanceToBottom = (g: Geometry) =>
  g.scrollHeight - g.clientHeight - g.scrollTop;
```

fake geometry 要能独立触发：

- 用户 scroll；
- content resize；
- viewport resize；
- programmatic scroll start/end；
- pointerdown/wheel/selection；
- virtualizer list refresh。

## 3. 必测状态不变量

1. 用户明确向上滚动后，后续内容增长不能强制拉回底部；
2. pending programmatic intent 未完成时，内容增长产生的 scroll 不应被误判为 user escape；
3. `atBottom=true` 不自动意味着未来继续 following；
4. 用户点击回底后，intent 完成才进入稳定 following；
5. prepend 历史消息保持原阅读 anchor；
6. 组件卸载后 observer、timer 和 animation 全部停止；
7. reduced-motion 下不依赖 smooth scroll 才能到达正确终态。

## 4. 事件排列实验

对同一场景交换事件顺序：

```text
A: content resize → synthetic scroll → observer callback
B: user wheel up → content resize → scroll
C: scroll-to-bottom start → image load → pointerdown
D: prepend → virtual measurement → list refresh
```

每种排列都记录：

- geometry before/after；
- state before/after；
- event source；
- 是否执行 scroll command；
- 是否取消 pending intent；
- 是否产生 unread。

## 5. 普通消息增长

覆盖：

- 单条新消息；
- 同一 assistant item 持续增高；
- code block 展开；
- 图片晚加载；
- tool result 折叠/展开。

分别在 `FOLLOWING`、`DETACHED`、存在 `PENDING_BOTTOM` 三种条件下运行。

## 6. 用户输入

至少覆盖：

- wheel up/down；
- touch drag 与惯性；
- scrollbar thumb；
- PageUp、Home、End、Space；
- pointerdown 中断 smooth scroll；
- 活动文本选择跨 viewport 边缘；
- 点击内部可展开内容。

用户输入优先级高于内容跟随，但不能把内容 resize 伪装的 scroll 误当用户输入。

## 7. 视窗与浏览器（基础 + 进阶 A）

真实浏览器测试：

- Chromium、Firefox、WebKit；
- iOS Safari 真机或 WebKit 自动化；
- 软键盘出现/隐藏；
- orientation change；
- 浏览器 scroll anchoring 开关；
- `column-reverse` 与普通布局；
- `prefers-reduced-motion`。

## 8. 虚拟列表（进阶 B）

对 React Virtuoso 类实现额外验证：

- 数据已追加但最后 item 尚未测量；
- `listRefresh` 后才 follow；
- dynamic height 二次变化；
- prepend 后保持 anchor；
- render range 不包含最后 item；
- `scrollToIndex` 被用户打断。

## 9. JSDOM 与真实浏览器的分工

| 层 | 适合验证 | 不足 |
|---|---|---|
| 纯状态机 | 转换、不变量、事件排列 | 不含浏览器几何 |
| JSDOM/fake geometry | observer 回调、timer、cleanup | 没有真实布局与惯性 |
| Chromium E2E | 常规 scroll、resize、selection | 不能代表 WebKit |
| WebKit/iOS | anchoring、惯性、软键盘 | 成本高，适合关键矩阵 |

## 10. 失败诊断格式

```text
Scenario:
Expected state:
Actual state:
Geometry timeline:
Event-source timeline:
Pending intent:
Scroll commands:
Browser:
Likely violated invariant:
```

保留时间线比保存最终截图更能解释竞态。

## 练习验收

### MVP 毕业线（必做）

- [ ] `FOLLOWING`、`USER_SCROLLING`、`DETACHED`、atBottom、pending intent 分开断言；
- [ ] 正常增长、用户逃逸、显式回底都通过；
- [ ] 交换 resize/scroll/pointer 事件顺序仍满足用户输入优先；
- [ ] observer、timer、animation cleanup 有测试；
- [ ] Chromium 至少跑一组关键路径；

### 主线正确性扩展（建议）

- [ ] Chromium 与 WebKit 至少各跑一组关键路径；
- [ ] 图片晚加载、selection、软键盘和 reduced-motion 有覆盖；
- [ ] 失败报告包含 geometry 与 event-source timeline；

### 进阶 A 专项

- [ ] 不依赖单一 17ms/50ms/100ms 窗口证明正确性。

### 进阶 B 专项

- [ ] 虚拟列表等待测量稳定再 follow；
- [ ] prepend 后保持原阅读 anchor。

## 检查理解

1. 为什么只断言最终 `scrollTop` 不足以验证自动跟随？
2. synthetic scroll 与用户 scroll 最可靠的区分证据是什么？
3. 为什么 pending intent 必须独立于 `atBottom`？
4. JSDOM 能验证哪些逻辑，哪些必须交给 WebKit？
5. （完成进阶 B 后）虚拟列表为什么需要等待 list measurement/refresh？

## 本章小结

自动滚动的正确性不来自某个时间窗口，而来自可观察状态、不变量和事件排列。fake geometry 用来穷举逻辑，真实浏览器用来验证事件来源、布局和输入行为；两层证据缺一不可。

---

[上一章：推荐控制器](04-controller-model.md) · [课程目录](00-learning-guide.md) · [返回入口](README.md)
