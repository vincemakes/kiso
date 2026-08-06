# Token 轮 — 工具输出纪律 + 请求数收缩 + T4 失格调查,发 0.1.27

2026-08-06. Spec: "Token 轮(主战场专项):工具输出纪律 + 请求数收缩 +
T4 失格调查,发 0.1.27。计分板=bench T2-T4 cost-weighted。" 红线:省
token 不致远盲——每一处截断都带可行动的续取路径。汇报纪律照旧。

## 取证(先取证后改码)

- 工具现状(tools-node/src/index.ts):read_file 全量读 + 通用 100K 字符
  cap("…[truncated]",**不可行动**);search_text 200 匹配硬上限(无计数无
  注);list_dir 无上限。schema 无 range 参数。
- 系统提示词(cli index.ts):既有 5 条 discipline,含 "search_text and
  list_dir are cheap — use them to orient before reading whole files"。
- T4 结构差(bench/runs 0.1.26 轨迹逐事件重建):
  - kiso run2:**13 请求 / 16 工具调用**。模型物理探索 `.claude/skills`
    (list_dir ×3 + read_file ×1 = REQ8-11);另读 clamp.test.js/README.md/
    package.json 定位约定;一次合并验证失败(REQ15)→ 重跑(REQ16)。
  - pi run2:**8 请求 / 10 调用**。--skill 把 SKILL.md 全文注入 prompt,
    零探索开销;bash 探索 + read ×2 + edit ×2 + bash 验证 ×4。
  - 初判:请求数差 ≈ 模型选择 + 设计差(两级渐进加载 vs 全文注入)。
    **发布会后调查推翻前半**:KISO_DUMP_REQUESTS 对账显示系统提示词里
    根本没有 skills 索引行——harness 从未加载 skills 扩展(见发布实录),
    模型一直在裸探索。框架杠杆始终存在,只是 bench 没测到。
- 计分板现状(README 0.1.26 行):T4 cost-weighted kiso **6,586** vs pi
  **7,249**——cost-weighted 上 kiso 已赢;失格项是**请求数**(13 vs 8.5)。

## 改动

1. **工具输出范围化**(tools-node):
   - read_file 加 `offset?`/`limit?`(1-based 行号);无参时 >200 行文件
     默认头 200 行 + "… N more lines (call again with offset=201)"(单数
     line);≤200 行行为逐字节不变;offset 超界 = 诚实 invalid_input(报
     行数);输出字符 cap 改为**行边界切割 + 下一 offset 可行动注**(单行
     超 cap 时给 shell 路径,防循环);全部确定性。
   - search_text 上限 50 匹配 + 全量计数 + "… +N more matches (narrow
     the pattern)"(walk 不再早停——注的 N 必须是文件真实总数);list_dir
     上限 200 + "… +N more entries (narrow to a subdirectory)"。
   - schema/描述同步(描述即模型的使用说明书)。
2. **请求数收缩**(system prompt,克制 +6 行):①独立调用一轮发出(并行
   基建);②先 search 再 offset/limit 范围读,禁整读大文件;③不重读未变
   内容。既有 "search_text cheap" bullet 并入 ②,不堆 prompt。
3. **T4 失格调查**:发布产物重跑 T4(n=2,KISO_DUMP_REQUESTS 逐请求对
   账),针对性收口或如实记录。

## 验收

- ①单测:scoped-reads.test.ts 17 例(范围/截断注/确定性/边界/重构/超
  cap)全绿;registry 去重回归入 kernel-contract(10/10)。
- ②PTY e2e:scoped-read-e2e.test.ts — 大文件默认截断 + 模型凭注续读
  (offset=201),会话日志双结果 + 调用断言。
- ③bench T2-T4 kiso 单元重跑:T2/T3 请求数 4/5 不动,cw 均值受 r1 冷
  启动影响如实记录(r2 稳态在方差内);**T4 翻盘**:5 请求(pi 8.5)、
  cw 均值 2,327(pi 7,249,3.1×)、墙钟 13s(pi 34s),双 pass。翻盘
  靠 harness 修复(产品原生机制)+ 批量引导,原因与全过程见发布实录。
- ④管道回归 + 门禁零回归:check EXIT 0,89 文件 614 测试,smoke 5 层
  PASS。

## Gates

- core / cli / tui — 改动在 tools-node(无 gate)与 cli prompt(计入
  cli gate),check 实录见下。

## 发布

0.1.27,流程同模板(tag 先于发布;拓扑序;post-publish 验证)。

## Acceptance

- clean-tree:`git status --short` 空 + `git log origin/main..HEAD
  --oneline` 空(已推送)。
- 范围外:输出压缩/去重缓存(涉 staleness,另议)/请求级并发。

## 发布实录 (post-publish)

- **0.1.27 八包发布**(tag 先于发布、拓扑序、全局 CLI 升 0.1.27)。
- **bench 重跑(0.1.27)**:T2 7s/6s pass、T3 11s/12s pass、**T4 r1 29s
  pass / r2 19s FAIL**——r2 模型从未发现 skill(daysBetween 过了,版本没
  bump;根目录 list 里有 .claude/ 但模型没钻)。请求数:13 → **9/8**,
  批量引导生效(prompt 变更的 r1 冷启动如实记录)。
- **T4 失格调查(KISO_DUMP_REQUESTS 逐请求对账,reconcile-t4.py)**:
  ①dumpdiff 全绿(分歧点均在 messages 数组末尾,ADR-0026 插入点);
  ②skills-index-line **absent**——harness bug:run-one.sh 的扩展目录只
  有 bench-allow,官方 skills 扩展从未加载(场景规格却写明"kiso 经其
  原生机制:skills 扩展 index + read_skill")。0.1.26 的 13 请求 = 裸探
  索的代价,不是产品。
- **修 harness → 挖出 0.1.26 潜伏真 bug**:加载 skills 扩展后真 API 回
  "400 Tool names must be unique"——agent 把同步扩展的工具**急切注册 +
  registerLive 双轨**,read_skill 进 spec 两次(skills/subagent/mcp
  status 全中招;faux 测试全瞎)。修 registry.list() 去重(map 赢,与
  get()/has()/文档同规则),回归测试入 kernel-contract。
- **0.1.28 八包发布**(修复随版带出;npm 本地缓存 ETARGET 坑一次,强
  制 --prefer-online 后全局 CLI 就位)。
- **T4 0.1.28 固定 harness 重跑:15s/11s 双 pass**;对账:r1 靠系统提示
  词里的索引行直接拿到约定、r2 走原生 read_skill(与 read 批量同发)——
  **5 请求 ×2(pi 8.5),cost-weighted 均值 2,327(pi 7,249,3.1×)**。
  T4 翻盘完成,顺带比 pi 还少 3.5 个请求。
- **bench README 刷新**:kiso T2/T3/T4 行、T4 harness 修复说明、headline
  (T4 反超句退役);产品 README 同步浓缩表 + 工具范围化一段 + 冷启动
  如实注。T2/T3 的 r1 fresh 含 prompt 变更的一次性冷启动(r2 稳态在方
  差内)。
- 门禁:core 1981/2000 · cli 1552/1856(+3:prompt 引导行) · tui
  1361/1520;89 文件 614 测试;smoke 5 层 PASS。
- 范围外不变:输出压缩/去重缓存(涉 staleness,另议)/请求级并发。
