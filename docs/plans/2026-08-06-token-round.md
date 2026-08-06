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
  - kiso run2:**13 请求 / 16 工具调用**。模型无视系统提示词里的 skills
    索引行,物理探索 `.claude/skills`(list_dir ×3 + read_file ×1 =
    REQ8-11);另读 clamp.test.js/README.md/package.json 定位约定;一次
    合并验证失败(REQ15)→ 重跑(REQ16)。
  - pi run2:**8 请求 / 10 调用**。--skill 把 SKILL.md 全文注入 prompt,
    零探索开销;bash 探索 + read ×2 + edit ×2 + bash 验证 ×4。
  - 结论方向:请求数差 ≈ 模型选择(不调用 read_skill,物理走目录)+ 设计
    差(两级渐进加载 vs 全文注入)。T4 场景 fixture 全小文件,输出范围化
    对 T4 无直接作用。
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
  cap)。
- ②PTY e2e:scoped-read-e2e.test.ts — 大文件默认截断 + 模型凭注续读
  (offset=201),会话日志双结果 + 调用断言。
- ③bench T2-T4 kiso 单元重跑(n=2):cost-weighted 各格不得倒退;T4
  目标翻盘(翻不了如实写原因)。
- ④管道回归 + 门禁零回归。

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

(填)
