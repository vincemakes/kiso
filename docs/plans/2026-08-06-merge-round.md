# 合并轮 — fresh 之谜调查修复 + Config 设置面,发 0.1.23

2026-08-06. Spec: "合并轮:fresh 之谜调查修复 + Config 设置面,发 0.1.23。
两部分独立工作流,先 A 后 B;汇报纪律照旧。"

## A. fresh 之谜 — 裁定:测量错误 + 一个真 D 区违规,均已修

### 取证(先取证后改码)

- `KISO_DUMP_REQUESTS=<dir>` 调试工具(openai provider,发送前按序号落盘完整
  请求体,留作常驻 debug 工具,文档注明含敏感内容)+ `bench/dumpdiff.py`
  (逐字节公共前缀 + 首个分歧的 JSON 路径定位)。
- 真 DeepSeek 3 轮会话取证:14 请求,13 对相邻请求,**两处断点,都在轮边界**,
  断点后请求 fresh 跳到 ≈ 全部历史(49% 缓存 vs 平时 90%+)。

### 两个发现

1. **"fresh ≈ 系统提示大小"异常是提取器测量错误** — extract.py 把 kiso 的
   `inputTokens`(DeepSeek 惯例:含缓存前缀)当作 "fresh" 列输出,且 "raw total"
   = input + cache 把缓存**双算**。真实 fresh/req = 77-295,与 pi(≈326)同量级;
   每 run 逐请求 cached 82-99%;req 1 的 cached=1024 证明系统提示跨会话字节
   稳定。README 的双口径 headline("pi 反超 2.7×")与 fresh 待办均基于此错误。
   **修复**:extract.py/extract-t5.py 统一 fresh/total/cost_weighted 口径
   (kiso: fresh = input − cache;pi/CC: input 即 fresh),语义钉死在
   `bench/tests/test_extract.py`(回归测试),README 表格与 headline 全部
   重基准(0.1.7 历史段同时修正:"总量翻倍"叙事也是双算伪影——0.1.7 的
   9.5K 与修正后当前值 9.5K 一致)。
2. **一个真 D 区请求级违规(嫌疑③命中)**:openai adapter 的 C7 规则把
   `reasoning_content` 存在性绑定在"当前轮"上,轮边界一过旧轮 assistant
   消息被剥字段,改写旧历史,前缀断在旧消息处(每轮边界一次缓存断点)。
   **修复(单调规则)**:投影里存在任一 reasoning → 所有 assistant 消息恒带
   字段(自身 reasoning 或 "");否则全不带。存在性会话内最多翻转一次(首个
   thinking,通常在首轮),轮边界零翻转;真 OpenAI 永不产生 reasoning → 其
   请求路径与旧行为逐字节相同。真 API 验证:旧轮 ""/reasoning 回传 200 +
   2560 cached;修复后同会话 13 对全 HEALTHY、逐请求 cached 82-99%(含轮
   边界)。契约表述扩进 ADR-0026 Amendment 1(请求级不变量:request N+1 与
   request N 共享到 N 末条消息结尾的字节前缀——可达最大前缀,messages 数组
   插入点是唯一合法分歧)。

## B. Config 设置面(ADR-0045,三裁定照实现)

- **凭据不落盘**:配置只存 apiKeyEnv 名字;env 缺失 = 档案标注不可用,
  切换被响亮拒绝,不炸。
- **项目配置入信任包**:`<cwd>/.kiso/config.json` 成为 E3 第四类构件
  (digest 覆盖,变更即重新裁决);未信任项目的配置永不读取。
- **不做 "always"**:projectTrust 只有 "ask"(默认 E3 门)与 "never"
  (自动拒绝,不询问不加载)。

schema v1(model/models{kind,baseUrl?,model,apiKeyEnv}/mode/contextWindow/
autoCompact/projectTrust);优先级 flags > env > 项目 > 用户 > 默认;损坏
JSON 响亮失败(带文件名);未知键放行(前向兼容)。`/model`(列表标注可用性
+ 运行时切换,NoticeCell 留痕)、`--model`(档案名或 provider/model 直写)、
菜单入册英文描述。内核零改动;runtime 三处轻触(buildAdapter 导出 /
session.setAdapter / trust 包 config.json 构件)。

## 验证与发布

- 586 测试全绿(0.1.21 时 563);发布产物复证:全局安装的 0.1.23 真 DeepSeek
  短会话 12 请求 0 断点、cached 85-98%(A 修复在发布产物上复证)。
- bench 全量重基准:0.1.23 重跑 kiso T1-T5(n=2),提取器修正口径,README
  表格/headline 更新。T4/T5 总量较 0.1.22 再提取略升(reasoning 回传走缓存
  0.1×,cached 份额 24.6K→40.3K / 102.7K→131.8K;会话长度方差 n=2),T4
  cost-weighted pi 以 7.2K vs 8.0K 微胜一格——如实写明。
- 发布 0.1.23 八包(核心/evals/两 provider/tools-node/runtime/tui/cli),
  peerDependencies 同步升。

## Gates(实测基准 = 去注释去空行代码行,与 0.1.21 记录逐文件吻合)

- core 1914/2000 ✓ · tui 1335/1520 ✓ · **cli 1547/1320 ⚠ 超 227**。
- cli 超限来自规格强制项 config 面(config.ts 新模块 + 接线,≈316 行)。
  按 ADR-0043 逃生舱请求裁定:config 面为一次性增量,建议 cli gate
  重校准(实际 + 20%)或接受本轮超限。

## Acceptance

- clean-tree:`git status --short` 空 + `git log origin/main..HEAD --oneline`
  空(已推送)。
- 原始数据路径:`bench/runs/<tool>-<task>-<run>/`(kiso 单元为 0.1.23 重跑,
  pi/claude 为 0.1.22 期数据,口径已修正)。
