# 性能轮 — 并行执行 + 流中执行 + MCP 懒连接 (ADR-0024 触发条件兑现),发 0.1.26

2026-08-06. Spec: "性能轮(ADR-0024 触发条件兑现):并行执行 + 流中执行 +
MCP 懒连接,发 0.1.26。前置:v5(mono+措辞)已落地复审。这轮动 kernel
执行序,按最高纪律来。" 汇报纪律照旧(clean-tree 两行机器证据)。

## 取证(先取证后改码)

- ADR-0024 decision #4(串行执行)的 revisit 条款即触发条件原文:"when a
  real workload shows the sequential ledger is the bottleneck — restore
  windowed batching with the ledger events emitted per call in
  deterministic order"。本轮的 bench T3 多工具轮 + 规格宣布触发兑现。
- 执行序现状:loop.ts 两阶段(流收集 → 顺序执行);executeOne 为 async
  generator,事件逐条 yield;投影按 seq 顺序(完成序)排 tool_result;
  registry 快照扩展工具;MCP factory 顺序 await 所有连接(启动阻塞)。

## 并行 + 流中执行(kernel)

- **流中执行**:tool_call_end 校验+策略链通过即 launch,与模型流并行。
  执行事件经共享队列,流循环每事件 drain —— seq 按完成序单调(EventLog
  单一分配器)。窗口上限 4(常量 WINDOW_SIZE)。
- **写前保证**:STARTED 事件被 drain ack —— handler 永不在其落盘前跑。
  executionId 在 append 处原子分配(`ex-<seq>` — 重放/resume 派生同一
  id;并发下旧的 lastSeq+1 预测有竞争,已废);decisionId 走单调计数
  (关联键,值与 seq 无关)。
- **ask 保守序**:decide 阶段按 call 序串行链;ask 的人类裁决 gate 其后
  调用(无论裁决结果,防人批时上下文已变);ask 之前自由跑。
- **违规/中止语义**:伪造事件、post-stop 违规、非兼容 stop reason 都
  void 整轮 —— violated 信号:已 started 的执行跑完落 receipt(照落),
  未 started 的 bail(abort 语义,无 started 无 uncertain);terminal 在
  receipt 之后。C 组 stop-reason 验证从"阻止执行"改为"void 整轮"
  (调用已在 tool_call_end 启动)。
- **字节纪律(投影)**:同轮 tool_result 缓冲、轮边界按 call 序落盘 ——
  完成序只影响落盘时刻,永不进入派生消息。非渲染事件(execution/
  permission/usage)不再 mid-message flush assistant —— 每个 tool_calls
  消息必须紧跟其 tool 消息(真 DeepSeek 400:bench 实测发现)。

## MCP 懒连接(扩展层)

- factory 立即返回;连接后台启动;启动不再阻塞。
- 工具列表来自 TOOL CACHE($KISO_HOME/mcp-tools.json,连接成功后写,存
  原始工具名):缓存工具立即注册,就绪前调用 = 等待连接(带超时);断连
  诚实(连接失败 → 调用报连接错误)。
- 横幅 "mcp (connecting…)" 态(扩展契约新增可选 `connecting` 字段);
  mcp__status 显示 connecting/connected/error。
- registry 新增 registerLive(live 工具源) —— 后台连接的工具落地即可
  调用,无需重建会话。

## 验证(红→绿)

- ①并行:3×300ms 工具墙钟 ~300ms(串行 ~900ms,<60% 门槛)——
  packages/core/tests/parallel.test.ts。
- ②kill9 并行变体:一轮 3 并发 shell,kill 于 3 started → 3 uncertain,
  resume 逐个裁决 → 轨迹完成(kill9.test.ts 新变体,3 测试全绿)。
- ③字节纪律:并发轮投影按 call 序(loop.test.ts 的投影断言)。
- ④流中:300ms-gap 流,started 先于 stop(seq 时间戳证明)。
- ⑤ask 保守序:ask 及其后调用等待,已批准先行(seq 断言)。
- ⑥MCP:横幅即时+connecting 态;缓存工具首调等待就绪;断连诚实。
- ⑦bench T2-T4 重跑:墙钟如实 —— 无 measurable 变化(LLM 方差内;
  工具 ms 级,墙 = 模型往返);并行收益在工具延迟主导时(合成门禁
  900→300ms)。README 照写。
- 修复途中:投影两处真 bug(跨轮结果混缓冲 → 真 DeepSeek 400;execution
  事件 mid-message flush 拆 assistant 消息 → 400),均为真机复现定位。

## Gates

- core 2034/2000 — 超 34(规格强制增量:并行机制 + 投影缓冲 + registry
  live 源)。按 ADR-0043 Amendment 1 请求裁定(0.1.23 cli 先例):
  重校准 core gate 或接受本轮超限。cli 1547/1856 ✓ · tui 1361/1520 ✓。

## 发布

0.1.26 八包,流程同模板。

## Acceptance

- clean-tree:`git status --short` 空 + `git log origin/main..HEAD --oneline`
  空(已推送)。
- 范围外:请求级并发(多模型轮并行)/推测执行。

## ⚠ 待裁定

- core gate 2045/2000(规格强制增量 +45,ADR-0043 Amd 1 逃生舱请求;
  0.1.23 cli 先例:交付 + 请求裁定,gate 数字落地后补 check 证据)。

## 发布实录 (post-publish)

- registry:8 包全部 0.1.26;全局 CLI 已升 0.1.26。
- 发布产物并行复证:新鲜目录 PTY 冒烟 —— 三 800ms 工具墙钟 0.9s
  (串行 2.4s),会话 3 个 started 事件,结果全回传。D 区在发布产物上
  完好(真 DeepSeek 已由 bench T2-T4 全 pass 复证,零 400)。
