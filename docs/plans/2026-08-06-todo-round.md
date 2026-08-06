# Todo 扩展轮 — 第 4 官方扩展:长程工作记忆,发 0.1.29

2026-08-06. Spec:"todo 扩展轮(第 4 官方扩展,长程工作记忆),发 0.1.29。
内核+E1 loader 零改动(core 余 5 行,本轮不进 core 是硬边界)。" 汇报纪律照旧。

## 取证(先取证后改码)

- **扩展模板**(extensions/skills/src/kiso-skills.mjs):一个 .mjs 文件,default
  export = 扩展或工厂;`{name, tools, systemPrompt:{append}, approvals}`;
  加载器(E1)逐文件 import,零构建的纯 .mjs 直接可用(safe-defaults 即先例)。
- **do-not-compact 机制已存在于 core**(kernel/project.ts:46):`DO_NOT_COMPACT`
  常量 + 两处消费——microcompact 的清除排除(loop.ts:1165 计数口径 + project.ts
  :349 替换 pass)与结果消息 tags 透传(loop.ts:712 落盘)。**todo_set 不在
  MICROCOMPACTABLE 白名单**,microcompact 永不清理它——tag 在此侧是防御纵深。
- **/compact 摘要层 = 契约洞检查点**:`summarizeConversation`(runtime)用
  SUMMARY_PROMPT 对 covered 区间生成摘要,投影以 coversToSeq 为界 REPLACE
  covered 内容(ADR-0044)——covered 区间若含最新 todo_set 轮,清单丢失。core
  的投影语义只认 coversToSeq;**边界计算在 runtime**(summaryBoundarySeq,
  session.summarize 调用),可在不改 core 的前提下收口:让边界在 covered 区间内
  最近的 do-not-compact 结果所在轮之前截止(轮边界,投影不拆消息的不变式保持)。
- **tui 解耦链**:CLI 的 consumeRun 逐事件喂 body.*(tool_result → body.toolResult);
  tool_result 事件原生携带 tags(无 name)。渲染数据形状是 tui 自有 RenderInput
  (render.ts,零 kiso-core import)。清单 cell = 新 BodyCell kind + RenderInput
  变体,CLI 负责把 tagged 结果翻译成 items(键=tag,非名字——扩展声明什么 CLI
  渲染什么;解析失败优雅回退普通 cell,绝不丢信息)。
- **safe-defaults** = examples/extensions/safe-defaults.mjs(教程扩展):在它的
  allow 列表加 todo_set 即满足"入 allow(纯会话状态)"。
- **状态在哪里**:扩展零内部状态(纯校验+回显)——清单的持久性来自**事件日志**
  (工具结果消息),kill -9 后 resume 从投影重建,与 CC 的进程内 runtime state
  对照(README 卖点句)。

## 改动

1. **extensions/todo**(零运行依赖,源即产物——src/kiso-todo.mjs 直接可加载,
   无 build):
   - `todo_set{items:[{text,status:"pending"|"active"|"done"}]}`——整表替换
     (CC TodoWrite 同构,幂等);校验:至多一个 active(超=invalid_input 报明)、
     状态枚举、text 非空(trim 后)、≤50 项、text ≤500 字符——全部 invalid_input,
     诚实报因。
   - 结果 = 规范化回显:
     `[todo] N items — P pending, A active, D done` + 每项
     `[pending|active|done] <text>` 行;确定性(纯函数)。
   - 结果 tags:["do-not-compact"]。
   - systemPrompt.append(≤15 行英文,克制):≥3 步先建清单(含一个验证步)/
     动手前标 active(至多一个)/完成即标 done/单步不用/每步完成即更新。
2. **safe-defaults 示例扩展**:todo_set 入 allow(纯会话状态,注释说明)。
3. **/compact 摘要层收口**(runtime/src/summarize.ts,非 core):summaryBoundarySeq
   的边界再收——covered 区间(prevPoint, base] 内最近的 do-not-compact 工具结果,
   其轮(该轮 opening user_input)之前截止;轮内无 tagged 结果或结果在保留轮 →
   行为不变;被保护轮即首轮(边界 == prevPoint)→ undefined(无可摘要)。
4. **tui 清单 cell**(tui 包走 RenderInput 自有形状,解耦纪律):
   - RenderInput 变体 `{type:"checklist", header, items[{text,status}]}` +
     renderEvent case(□ pending / ▖ active / ▣ done,砖块家族,NO_COLOR 安全)。
   - BodyCell kind "checklist" + body.checklist(header, items)——冻结语义照旧
     (done:true,一次成型);passthrough 路径同字节。
   - 不做常驻置顶(v1)。
5. **CLI 翻译**(chat.ts consumeRun 的 tool_result 分支):结果带 do-not-compact
   tag 且内容解析为清单(逐行 `[pending|active|done] <text>`)→ body.checklist
   (header+items);解析失败 → 普通 cell 照旧。

## 验收

- ①扩展单测(todo.test.ts):整表替换幂等/单 active 校验(超=invalid_input)/
  状态枚举/规范化回显字节/空表回显/边界(50 项、500 字符)/do-not-compact tag/
  MICROCOMPACTABLE 不含 todo_set(core 常量钉)。
- ②summarize 单测:covered 区间的 tagged 结果 → 边界收至其轮前;无 tagged →
  不变;tagged 在保留轮 → 不变;tagged 轮为首轮 → undefined。
- ③PTY e2e 长程叙事(todo-e2e.test.ts,真 PTY + 真 SIGKILL):建 3 项清单→完成
  1 项(ask 流 y 注入)→ kill -9(round 7 慢 shell 执行中)→ resume(rerun 裁决)
  → 投影含最新清单(do-not-compact 生效)→ 继续(轨迹到 terminal)→ /compact
  → 投影仍含最新清单 + 摘要文本、round-1 旧清单被覆盖(摘要层尊重 tag,契约洞
  已收口;若此检查点失败,按停止条款停下裁决)。
- ④管道回归 + 门禁零回归:core 不进(硬边界,零 diff)、cli/tui 有增量但限内。

## Gates

- core 2000(本轮零改动,硬边界)/ cli 1856 / tui 1520 — check 实录见下。

## 发布

0.1.29,流程同模板(tag 先于发布;拓扑序;post-publish 验证)。

## Acceptance

- clean-tree:`git status --short` 空 + `git log origin/main..HEAD --oneline`
  空(已推送)。
- 范围外:/todos 人类命令/置顶渲染/子任务嵌套/优先级/activeForm。

## 发布实录 (post-publish)

- (待发布后补录:发布、post-publish 验证、门禁实录、clean-tree 证据。)
