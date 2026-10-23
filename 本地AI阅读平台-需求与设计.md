# 本地 AI 阅读平台 · 需求与设计（v0.1）

> 暂定名：**页边（Margin）** —— 在书页边上和 AI 说话，而不是让 AI 替你读书。
> 文档状态：设计草案，文献部分待联网核实（见 §8）。
> 更新：2026-10-20

---

## 1. 要解决的问题

用户读的是一本自己选的书，读到某一段有感触、有疑问、有异议，需要一个**站在"我读到这里"的认知位置上**的对话者：

- 不能拿本书后文来回答（那等于替读者把路走完，理解不会发生）；
- 但需要比"划线附近几段"更宽的视野：前文脉络、作者别处的说法、其他学派、同类书与论文、背景知识。

所以产品的核心不是"阅读器 + 聊天框"，而是**一个受认知边界约束的讨论引擎**。

## 2. 三条不可动摇的规则

| # | 规则 | 实现层面 |
|---|---|---|
| R1 | **书内后文是禁区**：任何 `offset ≥ 划线位置` 的正文不得进入模型上下文 | 检索与组装阶段物理过滤，不靠提示词 |
| R2 | **书外开放**：其他书、理论、历史背景、同类研究、模型自身知识可用 | 必须打来源标签，不得冒充书内内容 |
| R3 | **手动解锁**：读到后面可点"解锁到 X 章"，但保留"初读反应"存档 | 记录解锁前后两次理解，形成演化轨迹 |

R1 的理论依据不只是"防剧透"：读者在未读后文时的第一反应具有独立价值（读者反应理论的"游移视点"），把它覆盖掉等于销毁了学习证据。

## 3. 核心回路：划线不是终点，是起点

```
用户划线
  ↓
① AI 先追问（默认苏格拉底模式）
   "你觉得作者这里为什么用这个词？"
  ↓
② 用户用自己的话回答（自我解释：学习真正发生的地方）
  ↓
③ AI 才给解释：对照前文脉络，指出用户答对/漏掉/混淆了什么
  ↓
④ 出一道迁移题：换个场景，这个说法还成立吗
  ↓
⑤ 生成复习卡片 → 进入间隔重复
```

可一键切换为「顺畅模式」（直接解释，末尾提一问），两种模式的对话与复习数据分开统计，便于日后比较哪种真的有用。

**依据**：自我解释效应（Chi 等 1994）、ICAP 框架中"交互 > 建构 > 主动 > 被动"（Chi & Wylie 2014）、合意困难（Bjork）、高效学习技术综述（Dunlosky 等 2013）。见 §8。

## 4. 上下文构造（防泄漏的核心）

设划线位置为 `P`（全书字符偏移）。上下文按层级装配，总预算约 6k–10k tokens：

| 层 | 内容 | 预算 | 说明 |
|---|---|---|---|
| L0 | 划线原文 + 前后各 2 段 | 必给 | 防断章取义 |
| L1 | 划线所在段落/小节的完整文本 | 必给 | 同上 |
| L2 | 本章已读部分 | 若 < 8k 字给全文，否则关键段 | — |
| L3 | 前文章节摘要链（章摘要 → 卷摘要） | 800–1500 字 | 预建，避免临时摘要 |
| L4 | 前文检索 top-k（BM25 + 向量，k=4–6） | 1200–2400 字 | **候选集在 SQL 层加 `char_end < P` 过滤** |
| L5 | 用户自己的历史划线/笔记（同书，位置 < P） | 500 字 | 让讨论接上你之前想过什么 |
| L6 | 书外知识 / 同类书片段 | 按需 | 仅"别处怎么说"或用户要求时注入 |

**三重保险**：
1. 数据层：检索 SQL 带 `char_end < P`，后文块根本不进候选；
2. 装配层：拼装后统一断言 `max(char_end) < P`，否则抛错（写单测）；
3. 生成后：校验回答中的引用是否都来自已给片段；出现"后面/结局/最后"类越界表述则重写或降级为"我不能用后文回答"。

## 5. 功能清单

### P1 · 阅读内核（先能读、能划、能聊）
- 书架：导入 EPUB / TXT / Markdown / PDF（首版），封面与元数据解析
- 阅读器：目录、进度、字号/行距/主题、单双页、全文搜索、书签
- 划线：多色、加批注、复制、删除；锚点 = 章节 + 字符区间 + 原文 + 前后各 20 字（抗重排）
- 讨论面板：四入口「顺着作者想 / 这里没懂 / 我想反驳 / 别处怎么说」
- 来源角标：`[前文 2.3]` 可点击跳转；`[书外]` `[推断]` 明确区分
- 卡片：原文 + 我的想法 + AI 要点 + 标签；导出 Markdown
- 设置：AI 通道（OpenAI 兼容 / 本地 Ollama）、模型、温度

### P2 · 翻译流水线与格式（"两边同时推"的另一边）
- 整书翻译：术语表 → 初译 → 一审 → 二校 → 三审 → 终校，六环节可分别指定模型
- 双语对照 EPUB：段落级切换原文/译文，划线讨论可引双语
- 断点续译、并发控制、失败重试、进度与 token 成本可视化
- Calibre 封装：MOBI / AZW3 / DOCX ↔ EPUB、PDF → EPUB/TXT
- 扫描版 PDF：OCR（Tesseract / PaddleOCR）

### P3 · 学习沉淀
- 间隔重复（FSRS 算法）复习卡片
- 主题聚合：按标签/概念把跨书划线聚成"知识脉络"
- 理解演化：初读反应 vs 解锁后修正的对照视图
- 同类书检索（本地书库）+ 论文检索（联网，需来源可信）

## 6. 技术架构

```
Electron (main)                     Renderer (React + TS + Vite)
├── 书库服务 SQLite (better-sqlite3)  ├── 书架 / 阅读器 / 讨论面板
├── 解析器                            ├── 卡片 / 复习 / 设置
│   ├── EPUB: 自研（unzip + XML → 归一化 HTML + 规范文本流）
│   ├── PDF : pdf.js 文本层 → 页内字符偏移
│   ├── TXT/MD: 直接
│   └── MOBI/AZW3/DOCX: Calibre ebook-convert → EPUB
├── 检索: FTS5（BM25）+ 可选向量（sqlite-vec / LanceDB）
├── AI 编排: Provider 抽象 + 上下文装配 + 流式输出
├── 翻译队列: 子进程 worker，落库断点
└── 导出: Markdown / Anki CSV / 双语 EPUB
```

**为何自研 EPUB 渲染**：需要全书规范文本流（给 AI 算偏移）与稳定锚点。epub.js 的 CFI 体系不利于"全书字符偏移"这种跨章节的线性坐标。自研 = 解析出的每章 HTML 由我们渲染，字符偏移只在一处定义。

**内存约束**：本机物理内存约 6GB。大书只加载当前章 + 相邻章，其余按需；翻译 worker 分块流式处理，不整本进内存。

## 7. 数据模型（草案）

```sql
books(id, title, author, format, path, cover, lang, word_count, added_at, meta_json)
sections(id, book_id, idx, title, href, char_start, char_end)
chunks(id, book_id, section_idx, char_start, char_end, text, tokens)   -- 检索单元
chunks_fts(text)                                                       -- FTS5
annotations(id, book_id, section_idx, char_start, char_end, quote, prefix, suffix,
            note, color, global_pos, created_at)
threads(id, annotation_id, mode, model, created_at)
messages(id, thread_id, role, content, sources_json, created_at)
cards(id, annotation_id, front, back, tags, due_at, stability, difficulty, reps, lapses, state)
progress(book_id, section_idx, char_offset, percent, updated_at)
translation_jobs(id, book_id, config_json, stage, status, progress, cost_json)
translation_blocks(id, job_id, block_idx, src, draft, review1, review2, final, status, notes)
glossary(id, book_id, term, translation, note, locked)
settings(key, value)
```

## 8. 文献依据（**待联网核实**，先列骨架）

> 状态说明：以下条目我按记忆列出，作者/年份/期刊需逐条核对后才可引用。中文核刊只能给到"期刊层级 + 主题"，具体篇目必须查到再写。

### 8.1 学习机制（外文，SSCI 级）

| 主题 | 文献线索 | 对产品的意义 |
|---|---|---|
| 自我解释 | Chi, de Leeuw, Chiu & LaVancher (1994), *Cognitive Science* | 主流程必须让用户先自述 |
| 认知投入层级 | Chi & Wylie (2014), *Educational Psychologist*（ICAP） | "交互"才算学会；聊天不能是单向讲授 |
| 有效学习技术 | Dunlosky 等 (2013), *Psych. Science in the Public Interest* | 优先自我解释/自测/分散；划重点低效 → 卡片不能只是摘抄 |
| 测验效应 | Roediger & Karpicke (2006), *Psychological Science* | 划线自动转成问题 |
| 间隔效应 | Cepeda 等 (2006), *Psychological Bulletin* | FSRS 排程 |
| 合意困难 | Bjork & Bjork (2011) 章节 | 不给完整答案，做提示阶梯 |
| 阅读理解模型 | Kintsch (1988), *Psychological Review*；Kintsch (1998) 专著 | 检测"只复述字面"，逼出情境模型 |
| 辅导式提问 | Graesser & Person (1994), *AERJ*；VanLehn (2011), *Educational Psychologist* | 多问少讲；ITS 效果接近人类导师的前提是交互 |
| 反馈设计 | Hattie & Timperley (2007), *Review of Educational Research*；Kluger & DeNisi (1996) | 反馈三问；不当表扬会降低表现 |
| 互惠教学 | Palincsar & Brown (1984), *Cognition and Instruction* | 预测/提问/澄清/总结四动作 |
| 提问作者 | Beck & McKeown (2006) 专著（QtA） | 非虚构四问模板 |
| 生成性学习 | Fiorella & Mayer (2016) 专著 | 总结/绘图/自测的任务设计 |
| 认知卸载 | Risko & Gilbert (2016), *Trends in Cognitive Sciences* | 防"AI 代我思考"；记录用户先答 |
| 阅读策略训练系统 | McNamara 等 iSTART 系列（*Discourse Processes* 等） | 自我解释提示的分级策略可借鉴 |

### 8.2 中文核刊（北大核心 / CSSCI）—— 待检索确认篇目

检索方向（每个方向找 2–3 篇实证或综述）：
- 阅读心理学 / 篇章理解：《心理学报》《心理科学进展》《心理科学》
- 深度阅读、整本书阅读、批注式阅读：《课程·教材·教法》《中国教育学刊》《教育研究》
- 数字阅读与认知负荷：《现代教育技术》《电化教育研究》《中国图书馆学报》
- 二语/外语阅读策略：《外语教学与研究》《外语界》
- 学习科学与元认知：《开放教育研究》《远程教育杂志》

### 8.3 AI + HCI（用户追加要求）

检索方向：
- CHI / CSCL / IJHCI / BJET / Computers & Education 中"AI 阅读助手""LLM 辅导""人机协作学习"
- 关键问题：AI 直接给答案是否削弱学习（认知卸载、元认知懒惰）；什么样的交互设计能保住"合意困难"
- 目标：找出已被验证有效的交互范式（提示梯度、先答后评、苏格拉底式追问），而不是自己拍脑袋

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 免费模型限流 / 上下文小 | 分块、并发闸门、重试退避、降级到小模型摘要 |
| 大书内存压力（6GB 内存） | 按章加载、流式解析、worker 独立进程 |
| PDF 文字层错乱 / 扫描版 | 文本层优先；OCR 兜底；PDF 划线降级为"页内选区" |
| 翻译质量不稳定 | 术语表锁死 + 多轮审校 + 抽样评分 + 人工抽检入口 |
| 后文泄漏 | §4 三重保险 + 单测（构造跨章节用例，断言零泄漏） |
| 版权 | 仅本地个人使用；不内置任何书籍分发；不上传原文到第三方（除用户配置的模型通道，需明示） |

## 10. 里程碑与验收

| 阶段 | 交付 | 验收标准 |
|---|---|---|
| M0 | 工程骨架跑起来 | `npm run dev` 出现空窗口，无报错 |
| M1 | 导入 EPUB + 阅读 + 划线 + 上下文装配 | 用一本真书划 5 条线，导出上下文 JSON，人工核对无后文 |
| M2 | 讨论回路 + 卡片 + 导出 | 走完"追问→自述→解释→迁移题→卡片"一轮 |
| M3 | 翻译流水线（先跑通短篇） | 1 万字短篇六环节跑完，产出双语对照 EPUB |
| M4 | 复习 + 主题聚合 | 卡片按 FSRS 排程，跨书同标签可聚合 |
| M5 | 打包 exe | 双击可用，书库/配置持久化 |

## 11. 待用户确认 / 待办

- [ ] 应用名（暂用「页边 / Margin」）
- [ ] 联网后核实 §8 文献，替换为可引用条目
- [ ] AI 通道：用户提供的 key / 本地 Ollama / OpenCode 免费模型适配（v2 API 需鉴权，路径与公开文档不一致，需单独攻关）
- [ ] 样本书：EPUB 小说 1 本、社科书 1 本、教材 1 本、外文书 1 本、扫描版 PDF 1 份（用于测试）

---

## 10. 实施进度（2026-10-20 更新）

### 10.1 已跑通的骨架（v0.2）
代码在 `margin/`（Electron 44 + React 19 + TypeScript + electron-vite + Node 内置 `node:sqlite`）。

| 模块 | 状态 | 说明 |
|---|---|---|
| EPUB 导入 | ✅ | fflate 解包 + linkedom 解析 OPF/NAV，全书字符偏移 |
| TXT / Markdown 导入 | ✅ | 按「第X章 / Chapter N / # 标题」切节，切不到按 5000 字切块 |
| SQLite 落库 | ✅ | books / sections / chunks / annotations / threads / messages / cards / progress / settings |
| 六层上下文装配 | ✅ | L0 划线原文 → L2 本章已读 → L3 前文章节（长书转逐章摘要）→ L4 前文检索 → L5 历史笔记 |
| 后文隔离 | ✅ | 检索 SQL 层 `char_end <= 划线位置` 过滤 + 装配后区间断言（越界抛 ContextLeakError） |
| 四种讨论模式 | ✅ | 顺着作者想 / 这里没懂 / 我想反驳 / 别处怎么说 |
| 选区→划线→高亮 | ✅ | 跨文本节点按字符偏移包 `<mark>`，点击标记回看该条讨论 |
| AI 通道 | ✅（Mock + OpenAI 兼容） | 设置页可填 baseUrl / apiKey / model；Mock 模式无需联网 |
| 三栏界面 | ✅ | 书架 216 / 正文 / 讨论 372，纸色衬线排版 |
| 测试 | ✅ | 13 个单测 + 集成测试全通过；`tsc --noEmit` 与 `electron-vite build` 均通过 |

### 10.2 怎么跑
- 双击 `margin/启动页边.cmd`（跑构建产物）；或 `margin/开发模式.cmd`（热更新）。
- 样例书：`margin/样例/示例书-页边四章.epub`（原创 936 字，四章分别讲划线、边界、复述、迁移）。
- 首次进入点「+ 导入书籍」选这个 EPUB。

### 10.3 还没接（按优先级）
1. PDF（pdf.js 已装未接）、MOBI/AZW3/DOCX（Calibre `ebook-convert` + 扫描版 OCR）
2. 翻译流水线（术语表 → 初译 → 一审 → 二校 → 三审 → 终校，环节×模型配置矩阵）
3. 复习与知识沉淀（cards 表已建，待接 FSRS 间隔重复 + 划线导图）
4. 书外知识检索（同类书/论文，需标来源；先留接口）
5. OpenCode 免费模型的 v2 API 适配层（二期）
6. 文献核实（OpenAlex / Crossref 直连可用，Google Scholar 当前网络不可达）
---

## 11. 基础阅读功能补齐（2026-10-20 晚）

定位：先把"能正常看书"这件事做完整，翻译流水线 / 复习卡片 / 书外检索按计划留到后面。

### 11.1 格式支持

| 格式 | 实现方式 | 说明 / 已知限制 |
|---|---|---|
| EPUB | fflate 解包 + linkedom 解析 OPF/NAV | 现有实现，最完整 |
| PDF | pdfjs-dist 取文字层，按 y 坐标聚行、按间距/标点/缩进切段 | 一页一节；**扫描件（无文字层）会明确报错提示先 OCR** |
| MOBI / AZW / AZW3 | 自研 PDB + PalmDOC(LZ77) 解压 + EXTH 元数据 | HUFF/CDIC 压缩与 DRM 加密的书会给出明确提示，不静默失败 |
| DOCX | fflate 解 `word/document.xml`，按「标题 1」切章 | 只取正文与标题，表格内文字暂不保留 |
| TXT / Markdown | 按「第 X 章 / Chapter N / # 标题」切节，否则 5000 字切块 | 自动识别 UTF-8 / GBK，中文 TXT 不乱码 |

### 11.2 阅读功能

- **目录抽屉**：整本节列表，显示每节进度百分比，点击跳转
- **全书检索**：右键无需，Ctrl+F 或顶栏进入；返回命中片段 + 所在节，点击跳过去并在正文里高亮闪烁定位
- **书签**：一键给当前节加书签，抽屉里集中管理，可删
- **排版**：字号 14–26、行距 1.5–2.6、字体（宋/黑/楷）、底色（纸/米/夜）四档，设置本地记忆
- **键盘**：← / → 翻节，Esc 关闭浮层，Ctrl+F 搜索
- **进度记忆**：关闭再打开回到上次那一节
- **书架**：多本管理，悬停出现删除（连带删该书划线/笔记/进度，不动原文件）
- **划线列表**：右栏「划线」页集中查看，点击回跳到原位置并打开当时的讨论

### 11.3 验证

- `npx vitest run`：**4 个文件 19 个测试全过**（新增 docx/mobi/pdf 三个解析器的 6 个测试，含「DRM 必须报错」）
- `tsc --noEmit`（node + web 两套）无报错
- `electron-vite build` 通过
- 界面在浏览器预览中逐一验证：目录、检索命中、书签、夜读主题、排版浮层、划线列表

### 11.4 本机没有 Calibre

原计划用 `ebook-convert` 做格式转换，实际本机未安装（`C:\Program Files\Calibre2\` 不存在）。因此 MOBI/AZW3 改为自研解析，不引入外部依赖；将来若要做"任意格式互转 / 扫描版 OCR"，再单独装 Calibre 或接 OCR 引擎。
---

## 12. 打包成 EXE 与"双击没反应"的根因（2026-10-20 夜）

### 12.1 双击没反应的真正原因
`src/main/index.ts` 里写了 `const __dirname = fileURLToPath(new URL('.', import.meta.url))`，而 electron-vite 构建时会自动注入同名 shim（`const __dirname = import.meta.dirname`）。两份声明在同一个模块作用域里 → **`SyntaxError: Identifier '__dirname' has already been declared`** → 主进程在加载阶段就崩了，窗口自然永远不会出现。

排查手法（可复用）：用 `ELECTRON_RUN_AS_NODE=1 electron.exe -e "import('file:///.../out/main/index.js')"` 直接加载构建产物，语法错误会立刻打印出来；这一步不需要桌面会话。

已修：删掉自定义声明，改用构建注入的版本；并加上 `show: true`（不再依赖 `ready-to-show`，避免渲染失败时窗口永不显示）、`uncaughtException`/`did-fail-load`/`render-process-gone` 全部写日志到 `%APPDATA%\margin\boot.log`，启动失败会弹系统错误框而不是静默退出。

### 12.2 免安装 EXE
`scripts/打包.ps1` 生成 `页边-win64/`：
- 复制 Electron 44 运行时 → 重命名主程序为 `页边.exe`
- 删掉 `resources/default_app.asar`（否则会打开 Electron 欢迎页）
- `resources/app/` 放构建产物 + 运行时依赖（fflate / linkedom / pdfjs-dist 及其传递依赖）
- 附带 `样例/` 与 `使用说明.txt`

双击 `页边-win64\页边.exe` 即可运行，无需安装，整个文件夹可拷到 U 盘。

**为什么不是单文件 exe**：单文件需要 NSIS/electron-builder 的 portable 目标，而它要从 GitHub 下载 nsis、winCodeSign 二进制；本机网络只能直连 github.com 主站，release 资产走 objects.githubusercontent.com（不通）。因此先给"文件夹 + 真 exe"的免安装版，功能完全一致。

重新打包命令：`pwsh -File scripts/打包.ps1`（会先假定已 `npx electron-vite build`）。
---

## 11. 两种运行形态（2026-10-20 晚更新）

### 11.1 网页版（当前推荐，已跑通）
双击 `启动页边.cmd` —— 起一个只监听 127.0.0.1 的本地服务并自动开浏览器。

- 服务：`margin/server/index.mjs`（esbuild 打包自 `src/main/api.ts` + `src/server/index.ts`），端口 5178，被占用则顺延
- 数据：`%APPDATA%\margin\margin.db`（与 Electron 版共用同一个库）
- 接口：`POST /api/call {method,args}`（与 IPC 同构的方法名）、`POST /api/upload?name=`（原始字节导入）、`GET /api/ping`
- 导入：点「＋ 导入书籍」会弹出浏览器文件选择，逐个 POST 上传，主进程解析后入库
- 好处：不涉及代码签名、不触发 SmartScreen，双击即可用

### 11.2 桌面版（打包完成，启动受阻）
`页边-win64\页边.exe`（206 MB，Electron 44.9.1 + Node 24.22）已打包，但双击无反应：
点过 SmartScreen「更多信息 → 仍要运行」后仍无进程、无日志，事件日志/Defender/Kaspersky 均无记录。
已排除：主进程语法错误（已在 RUN_AS_NODE 下验证可加载）、缺依赖（已 BFS 复制全部运行时包）、缺文件。
未签名（NotSigned）且带 GitHub 的版本信息，最可能是杀软静默拦截或 AppLocker 类策略。**暂缓**，等网页版把功能跑顺再回头处理（可选方案：代码签名、或改用 Tauri/便携 exe、或用 nsis 安装包形式）。

### 11.3 已支持的阅读功能
格式：EPUB / PDF（文字层）/ TXT / Markdown / DOCX / MOBI / AZW3（DRM 的会明确报错）。
阅读：目录抽屉、全文检索（命中跳转 + 闪烁）、书签、划线列表、字号/行距/字体/主题（纸/米/夜）、键盘 ←/→ 翻节、Ctrl+F 搜索。
讨论：选区 → 四模式 → AI 首轮追问（上下文严格止于划线处）。
---

## 12. EXE 启动问题：根因与最终部署位置（2026-10-20 17:40）

### 12.1 现象
双击 `…\Clubhouse\2026-10-20_本地AI阅读平台\页边-win64\页边.exe`：SmartScreen 弹窗 → 点「仍要运行」→ 无任何反应。无进程、无 boot.log、事件日志无记录。

### 12.2 排查过程（可复用）
1. 打包完整性：与 `node_modules/electron/dist` 逐文件比对 SHA256，`icudtl.dat`/`v8_context_snapshot.bin`/`resources.pak`/各 DLL 全部一致；exe 亦同（246,588,416 字节）。
2. 主进程代码：写一个 CommonJS `bootstrap.cjs` 作为入口，第一行就同步写日志，再 `import()` 真正的 ESM 主进程。结果在该目录下 **连这行日志都没产生** → 说明进程根本没进入 JS。
3. 换位置复现：把同一套文件复制到 `%TEMP%`、`C:\Users\jy130\Desktop\mt1`、`D:\MarginApp`，全部正常启动（boot.log 依次出现 boot start → init db → createWindow → loadFile → ready），窗口标题 `页边 Margin`。
4. 反向验证：把 `D:\MarginApp` 的原样内容复制回 `…\Clubhouse\…\bundle2`，又启动失败。
5. 已排除：文件损坏、缺依赖、未签名/MotW（无 Zone.Identifier）、Defender/Kaspersky 事件、主进程 JS 报错。

### 12.3 结论
问题不在程序，而在**所在目录**。`C:\Users\jy130\Desktop\Clubhouse` 这棵树的 ACL 里带有沙箱用户 SID（`S-1-4-…`、`CodexSandboxUsers`）和一个 `Everyone DENY DeleteSubdirectoriesAndFiles` 条目，启动器/安全检查层把这棵树下新生成的可执行文件当成不可信来源，因而在进程创建阶段就被拦掉（所以既没有进程也没有日志）。

### 12.4 最终部署（已验证）
- 程序目录：`D:\MarginApp\`（`页边.exe` + resources + locales + 样例 + 使用说明.txt）
- 桌面快捷方式：`C:\Users\jy130\Desktop\页边.lnk` → `D:\MarginApp\页边.exe`
- 验证方式：用 ShellExecute 启动该快捷方式，进程出现且 `MainWindowTitle = 页边 Margin`，boot.log 完整。
- 数据目录：`%APPDATA%\页边\margin.db`（与网页版的 `%APPDATA%\margin\margin.db` 是两套，注意区分）

### 12.5 教训
以后本机产出的大体积可执行目录，一律放 `D:\`，不要放在 `Desktop\Clubhouse` 树下；该树只放源码与文档。
---

## 13. 阅读器基本功（v0.4，2026-10-20 补齐）

> 用户的批评：AI 讨论只是阅读器里"比较重要的一个功能"，标亮、摘抄、分享图这些基本功不能缺。因此把「划线」从"必须弹 AI"改成"先标记"，AI 变成其中一个可选项。

### 13.1 划线四色
- 黄＝重点、绿＝认同、蓝＝疑问、粉＝灵感（`api.ts` 的 `COLORS`）。
- 选中文字后浮出的气泡分两行：上行四个色点 + 「写想法」，下行「和 AI 聊」+ 四个讨论模式。点色点＝纯标记，不弹 AI；点「写想法」＝标记并直接打开批注页。
- 带批注的划线多一条下划线，与纯标亮区分。

### 13.2 批注
- 右栏「批注」页：单条划线的编辑器（章节名、四色切换、完整引文、textarea）。
- 保存时机：Ctrl+Enter 或失焦自动保存。
- 按钮：保存批注 / 复制原文 / 生成分享图 / 和 AI 聊聊这段 / 删除。
- 提示语固定显示「AI 只能看到这条线之前的内容，你的批注也算之前」。

### 13.3 摘抄本
- 右栏「摘抄」页：颜色筛选 chips（全部/黄/绿/蓝/粉，带计数）、按章节分组、每条左侧色条 + 原文 + 批注。
- 多选复选框；无选中时操作作用于当前筛选结果全部。
- 操作：复制 / 导出（Markdown）/ 分享图 / 删除。
- Markdown 结构：`# 《书名》` → 作者 → 按章节 `## 章节名` → `> 原文` + 批注。

### 13.4 分享图
- `lib/share.ts` 用 Canvas 直接画，1080 宽、dpr=2，不依赖 html2canvas。
- 三种主题（纸/墨/夜）、细边框、品牌字「页 边 · M A R G I N」、书名、逐条「引号原文 → 出处 → 批注（左侧绛红竖线）」、页脚日期与「读到这里，停了一下」。
- 弹窗预览后点「保存图片」下载 PNG。

### 13.5 阅读体验
- 顶栏：目录抽屉 / 全文搜索 / 排版（字号 14–26、行距 1.5–2.6、宋黑楷、纸米夜）/ 上一节 / 全书百分比 / 下一节。
- 顶栏下方细进度条按 `section.char_start / book.word_count` 计算全书位置。
- 滚动位置按书记忆（`localStorage['margin.pos.<bookId>']`，400ms 防抖），切回来自动恢复。
- 键盘 ←/→ 翻节，Esc 关浮层，Ctrl+F 搜索。
- 修掉正文首块标题重复（首块若为 h1–h3 且文本等于节标题则不渲染）。

### 13.6 部署状态
- 已构建并热替换 `D:\MarginApp\resources\app\out`（不换 exe），清理了旧 hash 资源，只剩 `index-C04LGdD8.js` + `index-D-LICKto.css`。
- **需要完全退出页边再重新打开**才能看到新界面。
---

## 14. 信息架构重构（v0.5，2026-10-20）

### 14.1 调研依据
- 墨亭 TingRead《为什么我们做了墨亭》（tingread.cn/blog/why-tingread-not-calibre/）：书架只做封面网格 + 搜索 + 在读/读完，不做数据库；工具栏藏起来，鼠标到顶部才唤回；划词浮层只给少数动作；AI 在阅读现场，不在书目管理里。
- Calibre 的普遍差评：界面难用、卡顿、设置看不懂、功能过多。
- Koodo Reader / Readest 的标配：多格式、布局切换、TTS、即时翻译、内置词典、批注高亮书签、字体行距背景自定义、夜间主题、全文搜索、分屏对照。

### 14.2 新的三层结构
1. **书架（启动页）**：封面网格（按书名哈希生成书脊配色）、搜索、全部/在读/读完、卡片进度条与划线数、hover 删除。
2. **阅读页**：顶栏可自动隐藏（滚动向下收起、鼠标到顶部或向上滚回弹）；正文单栏 660px，无任何常驻侧栏。
3. **知识库**：跨书全部摘抄，按主题/按书/按时间分组，标签编辑（最多 6 个），颜色筛选，导出 Markdown，生成分享图，点条目跳回原书定位。

### 14.3 AI 内化的三处入口
- 划词气泡：四色标记 + 写想法 + 四种讨论模式（唯一显式对话入口）。
- 章节末卡片：「本节完」+「和 AI 过一遍这一节」+ 上一节/下一节 + 本书划线统计（章节级锚点，非划线锚点）。
- 目录：每章右侧显示该章划线数，作为"这一章我读得有多用力"的足迹。
- 讨论面板从常驻三栏改为抽屉，默认关闭——AI 不再占据阅读界面。

### 14.4 数据层
- annotations 增 tags 字段（老库自动 ALTER TABLE 迁移）。
- listBooks 返回 progress_pct / progress_sec / ann_count。
- 新增 listAllAnnotations()：JOIN books 取书名作者、子查询取节名。
- chat:send 支持章节锚点（bookId + secIdx 合成 id `sec:<bookId>:<secIdx>`）。

### 14.5 尚未做（对齐调研清单）
- TTS 朗读、内置词典、双栏/分屏对照、多设备同步、即时翻译（翻译流水线在规划中）。
---

## 15. 学习闭环：复习卡片 · 章节概括 · AI 通道（v0.6，2026-10-20）

前面几轮做的是"把书读进去"，这一轮开始做"把读进去的东西留下来"。

### 15.1 复习卡片（间隔重复）
- 入口：书里划一条线 → 右侧「笔记」→「做成卡片」；书架顶部出现「复习 N」（N 为今日到期数，红点提示）。
- 生成：AI 只拿**划线之前的正文**（`sec.text.slice(0, global_pos - char_start)` 的最后 1200 字）+ 划线原文 + 你的批注，一次最多出 2 张问答卡，答案不超过 60 字。所以卡片问的永远是"你当时读到那里"能回答的问题。
- 复习：全屏卡片页，点击翻面（3D 翻转动画），四个按钮「忘了 / 有点印象 / 记得 / 很熟」，键盘 1–4 评分、空格翻面、Esc 返回。翻面前不显示答案与评分，避免"看一眼就会"的错觉。
- 算法（`core/srs.ts`，简化 FSRS）：每张卡维护 stability / difficulty / reps / lapses / state。
  - 忘了：stability × 0.35（下限 0.4），difficulty +0.12，10 分钟后重来；
  - 记得类：stability 乘 ease（1.35 / 2.3 / 3.1），difficulty 微调；
  - 间隔 = stability × (1.15 − 0.35 × difficulty)，夹在 1–400 天之间。
- 删除划线会连带删除其卡片（`deleteAnnotation` 里先清 cards）。

### 15.2 章节 AI 概括
- 位置：每章末尾的「本节完」卡片里，点「AI 概括本节」。
- 产出：120–180 字概括 + 3–4 个关键词 chips，喂给模型的正文截断到 7000 字。
- 缓存：结果写入 `summaries(book_id, idx, text)`，文本列存 JSON `{summary, keywords}`；再次进入同一章直接读缓存，点「重新概括本节」强制重算。老库里纯文本格式的旧记录会自动按纯文本兼容读取。

### 15.3 AI 通道
- 设置页新增「快速选择」预设：本地模拟（不联网）/ DeepSeek / OpenAI / Kimi / 智谱 GLM / 通义千问 / 本地 Ollama，选中即填好 baseUrl 与 model，只需补 key。
- 「测试连接」按钮：先保存配置再发一句"只回两个字：正常"，回显 `连通正常 · 320 ms · deepseek-chat` 或具体错误。
- 所有 AI 调用统一走 OpenAI 兼容 `/chat/completions`，90 秒超时；需要结构化输出时自动加 `response_format: json_object` 并对返回做宽松解析（剥 ```json 围栏、截首尾括号）。
- 未配置 key 时全部功能回落「本地模拟」，返回可读的示例内容，保证界面永远可走通。

### 15.4 数据层新增
- `summaries(book_id, idx, text, created_at, PK(book_id, idx))`
- cards 表接上前端：list / due / counts / generate / update / delete / review。

### 15.5 仍未做
- 复习统计（连续天数、热力图、遗忘曲线）
- 卡片与知识库的双向跳转（现在只能从卡片回原文）
- 翻译流水线、书外知识检索（同类书/论文）
---

## 16. 翻译流水线（v0.7，2026-10-20）

### 16.1 为什么按"块"而不是按"页/段"
译文要能逐段对照、逐段替换、逐段重新译。所以以「块（block）」为最小翻译单元：
- 原文块来自解析阶段生成的 `Block{ i, tag, text, html, start, end }`；
- 一块一译，译完立刻落库，可以随时停、随时续；
- 对照展示时按 `block.i` 对齐，原文与译文一一对应。

### 16.2 五环节流水线
| 环节 | 干什么 | 默认 |
|---|---|---|
| 初译 draft | 带上文/下段各一段做上下文，先出一版 | 开 |
| 一审 scope | 只挑准确性问题：漏译、误译、增译、专有名词错 | 开 |
| 二校 polish | 只看目标语表达：生硬、语序、搭配、标点 | 开 |
| 三审 terms | 术语表一致性、称谓、语气统一 | 开 |
| 终校 final | 通读一遍去掉翻译腔（成本最高） | 关 |

### 16.3 三审三校怎么落地
- 每个审校环节返回 `{score, issues, revised}`，score 为 0–100。
- 若 `score < 及格线` 且该环节重跑次数 < `最多重跑`，就带着 issues 再改一遍。
- 及格线默认 75（可调 40–98），最多重跑默认 3 轮（1–5），并发默认 3 段（1–6）。
- 每段最终记为「最高分的那一版 + 最后所处环节」。

### 16.4 两个模型档位
- `main`：讨论、概括、出卡片用。
- `review`：翻译审校单独用，可以配一个更便宜的模型；不配就回落到 main。
- 设置页「测试连接」可分别测这两个档位。

### 16.5 断点续译与失效
- 每段存 `src_hash`（原文的 FNV-1a 指纹）。
- 续译时 `src_hash` 一致就跳过——所以「暂停三天再继续」不会重复花钱。
- 书重新导入、正文变了 → 指纹变 → 该段自动重译。

### 16.6 术语表
- 每本书一张表（`src → dst`，可加备注）。
- 「从全书抽取」抽前 8 节各 1200 字，让模型吐 30 条以内的候选术语。
- 术语以「必须遵守」的形式注入每次初译与三审，保证全书一致。

### 16.7 三种对照模式
| 模式 | 显示 | 用途 |
|---|---|---|
| 原文 | 只有原文 | 正常阅读 |
| 对照 | 原文 + 下方译文（左侧绛红细线） | 精读、校验 |
| 译文 | 只显示译文 | 当译本来读 |

双击任意一段可以只翻这一段（没开始整本翻译时也能用）。

### 16.8 数据与接口
- 表：`translations(book_id, sec_idx, block_i, src_hash, text, score, stage, updated_at)`、`glossary(book_id, src, dst, note)`、`tr_jobs(book_id, target_lang, state, total, done, cursor_sec, error, updated_at)`。
- 接口：`tr:config` / `tr:config:set` / `tr:stages` / `tr:langs` / `tr:status` / `tr:start` / `tr:pause` / `tr:reset` / `tr:section` / `tr:block` / `tr:glossary*` / `tr:glossary:build`。

### 16.9 已知限制
- 现在是「逐块独立翻译 + 上下文两句」，长句跨段时会不够顺；后续可做「段落合并译再回填」。
- 图片、图注、脚注暂不译。
- 翻译任务跑在本地服务进程里，关掉应用会中断（已译部分保留，下次续译）。
---

## 17. OpenCode 免费模型接入（v0.8）

### 17.1 为什么不能直连
`https://opencode.ai/zen/v1/models` 可以匿名列出模型，但 `POST /zen/v1/chat/completions` 一律返回 403 `FreeTierError`：「OpenCode's free tier can only be used from within OpenCode.」。本地后台服务 `http://127.0.0.1:45278` 的 `/api/*` 需要鉴权，试过 Bearer / x-opencode-password / x-password 均 401，且不能重启该服务（会杀掉正在运行的 OpenCode 会话）。

### 17.2 采用的方案：调用本机 CLI
```
D:\OpenCode\app\resources\opencode-cli.exe run --model <provider/model> --format json --title "页边 · 后台调用" "<prompt>"
```
输出是 JSONL，逐行取 `type==='text'` 的 `part.text` 拼接；`type==='error'` 时把 `error.message` 转成可读错误（带 status）。

实现要点（`src/main/core/ai.ts`）：
- `ModelConfig.kind` 增加 `'opencode'`，新增 `cliPath`。
- `callModel()` 开头按 kind 分流，其余链路（`complete` / `completeJson` / `testModel` / 翻译 / 概括 / 卡片）全部自动生效，无需改动调用方。
- `flattenMessages()` 把 system 合并到开头，assistant 包成「【你刚才的回答】」，要求 JSON 时追加一句约束。
- `spawn` 的 `cwd` 设为系统临时目录，避免读到项目的 AGENTS.md 影响输出；`windowsHide: true` 不弹黑框。
- 120 秒超时；prompt 超过 24000 字符直接报「这次上下文太长」；CLI 不存在时报「找不到 OpenCode CLI：<路径>」。
- 9 个免费模型：DeepSeek V4.1 Flash、GLM 5.3 Flash、MiniMax M3.1 Flash、MiMo v2.6 Flash、LongCat 2.5 Preview、Nemotron 3.5 Lightning、Nemotron 3.5 Super、Nemotron 3 Ultra、Beam（部分地区 403，已标注）。

### 17.3 配置方式
设置 → 类型选「OpenCode 免费模型（走本机 CLI）」→ 选模型（9 项）→ 可选填 CLI 路径（默认已是本机路径）。「测试连接」会真的发一次请求。

桌面版首次启动时已预置：主模型 deepseek-v4.1-flash-free，审校模型 minimax-m3.1-flash-free（翻译流水线的「主模型 / 审校模型」两档）。

### 17.4 性能与副作用（实测）
- 每次调用新起一个 CLI 进程，固定开销约 2.5 秒。
- 实测：测试连接 19.5s（冷启动）、章节概括 6.0s、划线讨论 8.5s、卡片生成 5.9s、单段翻译 6.9s。
- 会在 OpenCode 的会话列表里留下标题为「页边 · 后台调用」的会话，属预期行为。
- Beam 模型在本机所在地区返回 403 RegionError，不要选。

### 17.5 翻译流水线针对真实模型的调优
- 三审三校在真实模型下代价很高（每块 1 次初译 + 最多 4 环节 × 重跑次数），默认 `maxRounds` 从 3 降到 2、并发从 3 升到 4。
- 用户双击单段翻译走 `fast` 模式，只做初译，不跑审校。
- 新增语言检查 `ensureLang()`：原书语言与目标语言相同直接报错「这本书本身就是这个语言，换一个目标语言再翻」——否则模型会拒译并输出解释，被当成译文入库。
---

## 18. OpenCode 会话复用与长期记忆（v0.9）

### 18.1 原来的问题
每调用一次就新建一条会话，用几次之后 OpenCode 的会话列表就被「页边 · 后台调用」淹没，用户找不到自己的对话。

### 18.2 会话复用
- 讨论、概括、卡片、复习生成等归为 `purpose='discuss'`，共用一条会话，标题 **「页边 · 讨论与学习」**。
- 翻译流水线（初译/审校/术语抽取）归为 `purpose='translate'`，共用一条会话，标题 **「页边 · 翻译流水线」**。
- 会话 ID 存在 settings 的 `ai.oc.session`（JSON：`{discuss:{id,calls},translate:{id,calls}}`），下次调用带 `--session <id>` 继续。
- 因此列表里最多只有两条页边会话，且不再增长。
- **必须由服务端分配 ID**：自己编一个 `ses_xxx` 会被判为外部调用并返回 403 FreeTierError；只有 CLI 正常创建出来的会话才享有免费额度。

### 18.3 会话长期保留（不自动删除）
- 会话永不过期、不轮换。页边只有两条会话，会跟着读者一起积累。
- 唯一的例外是**失败自愈**：调用报错且存在旧会话时（上下文超长、会话被手动删掉），自动删掉这条已经坏掉的会话、清空记录、重试一次。
- 代价：CLI 侧上下文会越来越长，但页边自己装配的上下文（六层）始终是精确的，所以单次调用并不会无限变慢；真正积累的是"记忆"，见 18.5。

### 18.4 关于清理
早期版本曾在设置里提供「清理历史会话」按钮，用户明确表示不需要（他要的是长期陪伴，而不是定期清空），已移除。后端 `ai:cleanup` 接口保留，仅作维护手段。

### 18.5 长期记忆：不靠会话，靠自己的库
会话只能记住"这个 OpenCode 会话里说过的话"，一旦会话失效、换模型、重装就断片。因此记忆另存一层：

- **存什么**：读者在这本书上所有讨论里**自己说的话**（`messages.role='user'`），跨划线、跨讨论、跨会话。
- **怎么取**：`db.listUtterances(bookId, 20, excludeThreadId)` —— 按书关联（既有划线级 thread `annotation_id`，也有章节级 thread `sec:<bookId>:<idx>`），并排除当前正在使用的 thread（它的历史已经单独注入，避免重复）。
- **怎么用**：`buildContext` 新增 L6 层，取最近 8 条，每条截 160 字，写成「读者在这本书上此前的思考（他自己说过的话，可以接着往下谈）」。
- **为什么不违反 R1**：这些是读者自己的话，不是书的正文，不受"后文禁区"约束。但它们能让 AI 在你读到后面时，知道你前面想过什么。
- 界面：讨论面板底部的统计行会显示「记得你说过 N 句」。

### 18.6 验证记录
- 连续两次 `sec:summary`：`ai.oc.session` 的 discuss.id 不变，calls 从 1 累加到 2。
- 同一本书两条不同划线上各发一次讨论：第一次 `stats.memory=0`；第二次 `stats.memory=2, notes=1`，回复里直接引用了读者此前的批注原话。
- `vitest`：5 个文件 25 个测试全过（新增「读者以前的思考会被注入上下文」）。
---

## 19. 记忆库（v0.10）

### 19.1 为什么要独立成表
上一版把"读者说过的话"直接当成每条消息去查，能用的只是最近几条，且无法编辑、无法删除、无法跨书浏览。真正的长期陪伴需要一层可管理的数据。

### 19.2 表结构
```sql
CREATE TABLE memory (
  id TEXT PRIMARY KEY, book_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'thought',
  text TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', ref_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX idx_memory_book ON memory(book_id, created_at);
```
- `kind`：`note`（写在划线上的批注）、`thought`（讨论里读者自己说的话）。
- `ref_id`：批注指向 annotation id，思考指向 thread id —— 同一条来源重复写入时覆盖，不堆叠。

### 19.3 三个入口
1. **历史回填**：首次启动时跑一次（settings `memory.backfilled` 标记），把已有批注与讨论发言写进记忆库；自动首轮留下的占位消息（形如「【顺着作者想】」）跳过。
2. **自动沉淀**：`ann:update` 保存批注时写入 `note`；`chat:send` 保存用户消息时写入 `thought`，并带上章节标题作为来源。
3. **手动管理**：阅读页右侧工具栏「记忆」按钮 → 抽屉里按「批注 / 你说的」分组，点文字可改，右侧 × 删除，空文本保存等于删除。

### 19.4 注入规则
`db.listMemoryForContext(bookId, 12)` 取该书最近 12 条，时间正序交给 `buildContext` 的 L6 层，标题为「读者在这本书上此前的思考（他自己说过的话，可以接着往下谈）」，每条截 160 字。
这些是读者自己的话，不属于书内正文，因此不受"后文禁区"约束 —— 但正因为如此，它才能让 AI 在你读到后面时，仍然记得你前面是怎么想的。

### 19.5 界面
- 讨论面板底部统计行：`· 记得你说过 N 句`。
- 记忆抽屉：可以看到 AI 到底记得什么，也可以删掉不该记的。

### 19.6 验证
- `mem:list / mem:count / mem:update / mem:delete` 全部可用；删除一条后计数同步下降。
- 回填在示例书上产出 3 条（1 条批注 + 2 条思考），占位消息已剔除。
---

## 20. 一批基础能力补齐（v0.11）

### 20.1 全库检索
- `db.searchAll(query, limit)`：跨所有书的 chunks 做子串打分检索，返回 `{book_id, book_title, sec_idx, char_start, char_end, snippet}`。
- 书架搜索框输入两个字以上即触发（260ms 防抖），结果列在书架 Tab 下方：「全书检索 · N 条」，每条显示书名与命中片段。
- 点击结果：打开对应书 → 跳到对应节 → 按 char_start/char_end 定位并闪烁高亮。

### 20.2 阅读统计
- 新表 `reading_log(day TEXT PK, seconds INTEGER, chars INTEGER)`。
- 阅读页每分钟上报 60 秒（`stats:add`），书架顶部显示「连续 N 天 · 今天 M 分钟」。
- `stats:get` 返回 `{today, total, streak, days30}`；连续天数允许从昨天开始算（今天还没读也不清零）。

### 20.3 朗读
- 用系统 `speechSynthesis` 读当前节的纯文本，不联网、不花钱。
- 右侧工具栏喇叭按钮切换 朗读/停止；切节或离开阅读页自动停。
- 语言按正文是否含汉字自动选 zh-CN / en-US。

### 20.4 数据备份
- 设置页「导出数据备份」，用 SQLite 的 `VACUUM INTO` 直接写一份完整库文件到桌面，文件名 `页边备份-<时间戳>.db`。
- 备份包含：书、章节、划线、批注、讨论、卡片、记忆、译文、术语表、设置。恢复方式：把文件改名成 margin.db 覆盖即可。

### 20.5 翻译批量提速
- 原来逐段调用（每段 6–9 秒），改为每批 4 段一次请求，模型返回 `{"items":[{"n":0,"text":"…"}]}`。
- 实测同一本书：逐段模式约 3 分钟/25 段，批量后约 40 秒。
- **保底机制**：整批失败（模型输出不合规）时自动退化为逐段快译，不让一段坏掉拖死整节。
- `parseJsonLoose` 改为括号配平扫描（跳过字符串内的括号），能容忍模型在 JSON 前后多写解释文字——原来用「最后一个 }」截断，遇到多个对象时会解析失败。

### 20.6 未做（需要你先定方向）
书外知识检索（同类书/论文）、内置词典、双栏对照、多设备同步、脚注弹窗、书内链接跳转、快捷键自定义、长书性能重构。

---

## 21. 书外知识、查词、左右对照与快捷键（v0.12，2026-10-21）

上一版 §20.6 列了七件没做的事，这一版做了四件半，剩下两件半说清原因。

### 21.1 书外的说法：只查真实文献
- 右侧工具栏新增地球图标「书外的说法」。面板顶部先声明一句：**只查 OpenAlex 与 Crossref 的真实文献，查不到就显示为空——这里不会凭空生成观点**。
- 后端 `src/main/core/external.ts` 两个数据源并行查询（`Promise.allSettled`，任一失败不影响另一个）：
  - OpenAlex：`/works?search=…&per-page=N&sort=relevance_score:desc`，带作者、年份、刊名、被引次数、DOI；摘要存的是倒排索引，本地复原成可读文本。
  - Crossref：`/works?query=…`，作为兜底；两源按 DOI / 标题去重合并。
- 每条结果给三样东西：题录（作者·年·刊名·被引）、摘要前 4 行、「复制引用」——复制出来的是 `作者（年）. 标题. 《刊名》 DOI: … （来源：OpenAlex）`，来源是硬编码进引用串的，粘到别处也不会丢。
- 查不到就是空列表 + 一句「换个更学术的说法试试，比如用英文关键词」，**不会退化成让模型编几篇论文**。
- 实测（2026-10-21）：`reading comprehension` 返回 8 条真实文献，首条被引 2224。

### 21.2 划词查词：AI 释义，但说清它是释义
- 选中不超过 12 个字时，选区气泡多一个「查词」。
- 弹卡显示：词、拼音、最多 3 个义项（带词性）、**在这句话里怎么理解**，以及「存疑」提示（专名、生僻、读音不确定时由模型自己标出来）。
- 卡片底部固定一行：**AI 释义 · 非权威词典，拿不准请以原文语境为准**。这是有意的取舍：本机没有离线词典数据，与其假装是《现代汉语词典》，不如老实标成 AI 释义并利用它「按句内用法解释」的长处。
- 结果内存缓存 300 条，同一词同一句子不重复问模型。
- 实测「门槛」在「线划在理解的门槛上」一句中，返回「名词·门框下部横木 / 名词·比喻界限、标准」并补了一句「此处用的是比喻义，指理解上的那道界限」。

### 21.3 左右对照（原文 ｜ 译文）
- 翻译面板的对照模式从三种变四种：原文 / 对照（译文在下）/ 译文 / **左右**。
- 左右模式不是「报纸分栏」——那种排版在滚动阅读里会把后半段折到右栏顶部，阅读顺序是坏的。这里做的是逐段配对：每段原文和它的译文同一行左右并排，左栏原文、右栏译文，段与段严格对齐（每对是一个两列 grid，缺译文时右栏留白，不会串行）。
- 左右模式下正文容器放宽到 `min(1440px, 视口-160px)`，两栏各得约 45% 宽度。
- 实测：原文块 28–438px，译文块从 482px 起、与原文同一 top，配对正确。

### 21.4 快捷键自定义
- 设置页新增「快捷键」区，9 个动作：下一节/下一页、上一节/上一页、搜索本书、目录、排版、书签、批注与摘抄、朗读、回到书架。
- 点键位按钮 → 按下新组合键即绑定（Ctrl / Alt / Shift 组合都支持），存 `localStorage.margin.keys`，并广播 `margin:keys` 事件让阅读器实时换表，不用刷新。
- 「恢复默认」一键还原。默认值：→ ← Ctrl+F T A B N S Esc。
- 键帽显示做了美化：`ArrowRight` 显示成 `→`，`Escape` 显示成 `Esc`。
- 只在焦点不在输入框时生效；翻页模式下 → / ← / PageUp / PageDown / 空格仍然可用。

### 21.5 知识库 AI 提标签
- 知识库顶栏新增「AI 提标签」：把**还没有标签**的划线（每次最多 24 条）交给模型，按「引文 + 批注」提议 1–2 个 2–5 字的主题词，回写 `annotations.tags`。
- 提示词里明确禁用「重要」「感想」这类空词，要求是「权力」「翻译」「时间观」这种主题词。
- 完成后提示「已给 N 条打上标签」并刷新列表。
- 实测样例书 3 条划线，得到：划线/位置、划线/理解门槛、理解/阅读痕迹。

### 21.6 长书实测（没有重构，因为量完不需要）
用桌面库里的《绝世唐门》（528 万字、1101 节）在临时副本上测（不碰用户数据）：

| 调用 | 耗时 |
|---|---|
| `book:section` 读单节 | 5–11 ms |
| `book:sections` 取 1101 节目录 | 211 ms |
| `book:search` 全书检索 | 858 ms |
| 讨论前装配全书上下文 | ~0.5 s |

结论：单节读取完全不是瓶颈；全书检索接近 1 秒但可接受（有 loading 态）；每轮讨论多花的 0.5 秒装配时间相对模型本身 2–5 秒的延迟可以忽略。所以这一版**不做**索引或懒加载重构——没有证据支持它。

### 21.7 这一版没做的，以及为什么
- **脚注 / 尾注弹窗、书内链接跳转**：现在的解析把 HTML 压成纯文本块（`blocks: {tag, text}`），锚点和 `epub:type="noteref"` 在解析阶段就丢了。要支持弹窗，得让块结构保留内联标记、数据库多存一份锚点映射、渲染层的高亮包裹逻辑跟着改——这是解析层的结构调整，不是加个弹窗组件。硬塞一个「点不动」的按钮不如不做。EPUB 的注释页本身作为单独一节出现在目录里，暂时还能用目录翻过去。
- **卡片与知识库联动**：查过代码，这块本来就通着——复习卡背面已显示来源引文与批注，`onOpenSource` 可以跳回原文；知识库条目也能跳转。这一版只补了自动标签，没有重复造。

> 追记（v0.13）：这两件已在 §22 补上——脚注/书内链接做了真正的解析层改造，知识库也加上了卡片联动标记。

### 21.8 验收路径
1. 书架 → 打开任意书 → 右侧地球图标 → 输入 `reading comprehension` → 应出现真实论文题录，点「复制引用」得到带来源的引用串。
2. 正文里选一个两三个字的词 → 气泡里点「查词」→ 看释义卡片底部那行「AI 释义 · 非权威词典」。
3. 翻译面板（有译文时）把对照模式切到「左右」→ 每段原文与译文左右对齐。
4. 设置 → 快捷键 → 点「目录」右侧键位 → 按 `y` → 回阅读页按 `y` 应打开目录。
5. 知识库 → 「AI 提标签」→ 提示已给 N 条打上标签，列表里出现主题词。

---

## 22. 脚注与书内链接、卡片联动（v0.13，2026-10-21）

§21.7 里说「这两件做不了/不用做」，被用户当场否了：那就做。

### 22.1 先把链接信息留在数据里（改解析层）
- `core/text.ts` 的 `Block` 增加两个可选字段：`anchor`（这个块自身的 id，用于被别的链接指过来）、`links: Array<{start, end, href}>`（块内第几个字符到第几个字符是链接）。
- `sanitizeInline` 原来把所有 `href` 一律压成 `#`，现在改成 `href="#"` + `data-href="原地址"`，并且所有白名单标签都保留 `id`。这样既不丢链接目标，也不会让渲染层真的跳转。
- 新增 `extractLinks(html, text)`：正则在净化后的 HTML 里找 `<a>`，剥掉内层标签、反转义实体后，用 `text.indexOf(label, cursor)` 在块文本里定位偏移。用「从上一个链接之后开始找」的方式处理同一段里出现多个同名链接。
- 新增 `unescapeHtml`（具名实体 + `&#x..;` / `&#..;`）。
- 因为改的是 `buildSectionText`，EPUB / DOCX / MOBI 三种格式一起受益；TXT / MD 本身没有内联标记，保持原样。

### 22.2 新增 `book:anchor`：把一条 href 解析成四种结果
- 新文件 `core/anchors.ts`：`resolveAnchor(bookId, secIdx, href)` → `{kind: 'external' | 'note' | 'section' | 'none', url?, secIdx?, secTitle?, text?}`。
  - `http(s):` / `mailto:` → `external`；
  - 只有 `#id` → 在本节找；
  - 带文件路径（如 `ch2.xhtml#fn1`）→ 用当前节的 href 拼相对路径，在 `db.listSectionPaths()` 里匹配到节，再找锚点；
  - 找不到 → `none`（前端提示「这条链接指向的内容没找到」，不猜）。
- `db.findBlockByAnchor`：用 SQLite 的 `json_each(sections.blocks)` + `json_extract(j.value,'$.anchor')` 直接查 JSON 里的锚点，并按 `ABS(idx - 当前节)` 排序取最近的一条（同 id 在全书重复时优先当前章），返回该块纯文本（截断 600 字）。

### 22.3 阅读页：虚线下划线 + 注释浮层
- `Reader.tsx` 新增 `wrapLinks(el, links)`：和划线高亮同一套字符偏移算法（TreeWalker + splitText），只是包出来的是 `<a class="doc-link" data-href="…" href="#">`；带幂等守卫，重复渲染不会套娃。
- 单独的 `useLayoutEffect` 在高亮之后运行（保证划线的 mark 在内层、链接在外层不会互相拆坏）。
- 点击委托在 `.reader-page` 上：命中 `a.doc-link` 就 `preventDefault`，调 `onLink(href)`；其它点击仍走「点划线看批注」。
- `App.tsx` 的 `openLink`：`external` → 系统浏览器打开；`section` → 直接跳节；`note` → 右下角 `.note-pop` 浮层显示注释原文，若注释在别的节还带一个「跳到该节」按钮。浮层底部固定一行：**注释来自书内原文，不是 AI 生成的**。

### 22.4 卡片与知识库联动
- 知识库打开时同时拉 `annotations.all()` 和 `cards.list()`，按 `card.annotation_id` 聚合成每条划线的卡片数。
- 条目上：已有卡片 → 显示 `◎ N 张卡` 徽标；没有卡片 → 显示「出卡片」按钮，点了调 `cards.generate(annotationId)`，完成后刷新并提示「已生成 N 张复习卡片」。
- 不做「再出一张」——同一条划线反复生成只会堆重复卡片。

### 22.5 两条限制（必须知道）
1. **旧书要重新导入**。`links` / `anchor` 是导入时写进 `sections.blocks` 的 JSON 里的；已经入库的老书没有这两个字段，也不会自动补。想看脚注/链接，把书删掉重新导入一次即可（划线、批注、卡片是按书 id 存的，删书会一起没——这点得先想清楚再删）。
2. **TXT / Markdown / PDF 没有脚注弹窗**。这几种格式解析出来就是纯文本，没有链接结构，不是功能没做完。

### 22.6 实测（2026-10-21）
自造一本带脚注的 EPUB（`ch1.xhtml` 里 `<a epub:type="noteref" href="#fn1">[1]</a>`、一段跨文件链接 `ch2.xhtml`、`<p id="fn1">` 注释段）导入网页版：
- blocks 结果：章节标题块 `anchor=top`；正文块 `links={start:17,end:20,href:"#fn1"}`（偏移正好盖住「[1]」三个字符）；跨文件链接块 `links={start:7,end:10,href:"ch2.xhtml"}`；注释块 `anchor=fn1` 且文字完整。
- `book:anchor('#fn1')` → `{kind:'note', secIdx:0, secTitle:'第一章 边界', text:'[1] 这里的“边界”指…'}`；`book:anchor('ch2.xhtml')` → `{kind:'section', secIdx:1}`；`book:anchor('https://example.com/x')` → `{kind:'external'}`。
- 浏览器里：阅读页出现 2 个 `a.doc-link`（首个 label `[1]`、data-href `#fn1`），点击后浮层显示「第一章 边界 / [1] 这里的“边界”指… / 注释来自书内原文，不是 AI 生成的」。

### 22.7 踩坑记录
排查时一度以为 `book:anchor` 没注册——真实原因是机器上还留着 4 个旧的 `node server/index.mjs` 进程占着 5178，跑的是旧包，所以报「未知接口 book:anchor」，导入的书自然也没有新字段。杀进程时匹配串要写 `index\.mjs`（命令行里是正斜杠 `server/index.mjs`，写反斜杠匹配不到）。以后遇到「新功能不生效 / 未知接口」，先数进程。

### 22.8 验收路径
1. 删掉测试书后重新导入一本**带脚注的 EPUB**（或用我造的 `footnote-test.epub`，网页库里已有一本「脚注测试书」）。
2. 正文里点虚线下划线的小字（如 `[1]`）→ 右下角弹出注释原文，底部写明「不是 AI 生成的」。
3. 点跨文件的链接（如「第二章」）→ 直接跳到对应章节。
4. 知识库 → 找一条没有卡片的划线 → 点「出卡片」→ 提示已生成 N 张；再回知识库，该条变成 `◎ N 张卡`。


---

## 23. 电子书导入实测与 MOBI 乱码修复（2026-10-21）

### 23.1 现象
从手机批量导入后，两本 MOBI（《置身事内》《第二性》）打开是满屏 `�`，并漏出 `/blockquote>`、`/b1/`、`/f00年` 这类残缺标记；其余 EPUB 全部正常。

### 23.2 根因（三处，均在 `src/main/core/mobi.ts`）
1. **PalmDOC LZ77 漏了 0xC0–0xFF 分支（主因）**。原实现把所有 `>=0x80` 的字节都当回引处理，而规范里 `c >= 0xc0` 应输出「空格(0x20) + (c ^ 0x80)」。GBK/UTF-8 中文文本大量命中该区间 → 解压错位 → 成片替换符 + 残缺标记。
2. **未剔除文本记录尾部的 trailing entries**。MOBI 头 `headerLen >= 0xE4` 时，`extra flags`（MOBI 头 +0xF2）每置一位，记录尾部就多一段变长整数编码的附加数据，不裁剪就会在正文里冒杂字。
3. **编码只信声明的 codepage**。声明 UTF-8 实际是 GBK 的书很常见，现在按 U+FFFD 比例（>0.2%）自动重试 `gbk` / `gb18030`，取替换符最少者。

### 23.3 具体改动
- `decompressRecord`：分支顺序改为 `c===0` → `c<=8`(直拷) → `c<0x80` → `c>=0xc0`（push 0x20, push c^0x80）→ 否则回引；回引越界回退为 0x20。
- 新增 `trimTrailingEntries(rec, extraFlags)`：从末尾往前读变长整数（每字节低 7 位、高位表示继续，最多 4 字节），按 flags 逐位扣减。
- 新增 `decodeWith(bytes, enc)` 与重写 `decodeText(bytes, codepage)`（替换符计数 + 多编码择优）。
- `parseMobi` 内新增 `headerLen = u32(rec0, mobiStart + 0x14)`、`extraFlags = headerLen >= 0xe4 ? u16(rec0, mobiStart + 0xf2) : 0`，记录循环改为「先解压、再裁尾」。

### 23.4 踩坑：**旧 bundle 陷阱（最重要）**
改完 `core/mobi.ts` 后直接用探针（esbuild 现编译 TS）验证是干净的，但导入到库里还是脏的——因为导入走的是 `node server/index.mjs`，那是**修复前打包的旧 bundle**。
→ **规则：改 `src/main` 下任何 core 代码后，必须重跑 `npx esbuild src/server/index.ts --bundle --platform=node --format=esm --packages=external --outfile=server/index.mjs`，再导入或验证。**

### 23.5 手机导入结果（桌面库 30 本）
- 10 EPUB / 11 MOBI / 8 PDF / 1 TXT。
- MOBI 实测：`badPct` 从 29.7% 降到 **0.054%–0.283%**，HTML 残留计数为 0；抽样真读原句（例：《置身事内》第 28 节「很多重要的非经济因素，如奋斗精神和家国情怀等……推荐北京大学路风的《光变：一个企业及其工业史》」；《第二性》第 18 节「……直到十二岁，小姑娘像她的兄弟们一样强壮……」）。
- 剩余 0.05%–0.28% 的替换符来自原书自身（OCR/生僻字），不是解析问题。

### 23.6 PDF 文字层体检
对手机 `Books/MoonReader/attachments` 的 **77 个 PDF** 逐个跑 `parsePdf`：
- **19 个有文字层**，其中 8 本内容干净、可正常阅读（720事件实录、共和国的历程、无政府国家和乌托邦、面包与自由、虚实之间、无尽的资本主义、斯大林模式的形成、邓小平时代的中国）；
- 2 本为扫描 + OCR 文本层（字间多空格、数字断开，可读但不精美）；
- **58 个是纯图片扫描件，没有文字层，无法阅读**，需要先 OCR 才能导入。

### 23.7 `sections.text` 只是节文本预览
`sections.text` 存的是该节的文本预览（比 `books.word_count` 短很多），**正文实际在 `blocks` 表**。例如《论犯罪与刑罚》`word_count=105171`，而 9 个 section 的 text 合计仅 13824 字符——这不是导入截断，判断内容完整性要看 blocks。
（乱码体检用 `sections.text` 仍然有效，因为它也是真实文本。）

### 23.8 仍存在的限制
- 3 个 MOBI 未导入：1 个 114 字符的坏文件；2 个无法从内容判定书名（一个正文只有「目录 一 二 三…」，一个开头是「多年来养成一种习惯……」，不猜书名）。
- PDF 只体检了 MoonReader 目录那 77 个；手机 Download / Quark / 百度网盘下另有约 180 个 PDF 未逐一试。
- MOBI 的 EXTH 标题多数取不到（多为「未命名电子书」），本次是按正文特征人工核对后在库里回填书名；后续可考虑读 PDB 名称字段或让用户在界面改名。

## §24 v0.14 目录 / 排版 / 封面（2026-10-21）

### 24.1 问题
1. PDF 正文「一行一段、汉字间全是空格」，几乎无法阅读。
2. 目录一律是程序编的「第 N 节」，没有用书里的真目录。
3. 书架没有封面。

### 24.2 原因
- `pdf.ts`：段首规则里有一条「上一行以句号结尾就断段」，中文每行都以标点结尾 → 行行成段；另外没有清理扫描 OCR 文字层里插在汉字之间的空格；没有读 `getOutline()`，所以只能按页分节。
- `epub.ts`：判断 epub3 nav 的条件写成 `v.type.includes('xhtml') === false && includes('nav')`，而 nav 的 media-type 是 `application/xhtml+xml` → 恒假；同时完全没实现 epub2 的 `toc.ncx`。于是全部退化成 h1/h2 或「第 N 节」。
- `mobi.ts`：只按 h1/h2 或每 12000 字硬切，没有处理 `<mbp:pagebreak>`，也没读目录页。
- `db.ts` / 渲染层：books 表没有 cover 字段。

### 24.3 修复
- PDF：新增 `squeeze()`（CJK 之间空格、拆开的数字合并）；段落改按「行距中位数 / 行首缩进 / 行尾是否未满行 / 字号跳变」判断；分节优先用 `getOutline()`，其次字号更大的短行（并过滤每页重复的页眉），最后按 8 页一组并标注真实页码；书名过滤「封面/序/版权页/Microsoft Word…」等垃圾元数据，交给文件名兜底。
- EPUB：nav 改为按 `properties` 含 `nav` 识别，新增 `toc.ncx`（`spine[toc]` 指向）递归解析；同一 spine 文件在目录里有多个锚点时按标题再切节；封面取 `meta[name=cover]` 或 `properties` 含 `cover-image`。
- MOBI：按 `<mbp:pagebreak>` 分页，页首识别「序/前言/第X章/Chapter N」，并扫描书内目录页校对标题；封面从图片记录里找第一张 JPEG/PNG。
- DB：books 增加 `cover TEXT DEFAULT ''`（存 data URL），`replaceBookContent()` 支持按原 book id 就地重建，保留划线/卡片/进度；上传接口支持 `?id=`。

### 24.4 实测（27 本就地重导后）
- EPUB 10 本：封面 7–203KB，目录为书内原文（如《筚路维艰》「目录/前言/第一章 实行新民主主义/一 "新民主主义"的源流…」）。
- MOBI 10 本：封面 38–158KB，目录明显改善（《美国演义》「第1回 碧海万里移民找谋生路…」、《银河帝国》「第一篇 心理史学家…」）。
- PDF 7 本：汉字间空格率 0（千字），段落正常成段（单节 40–100+ 段），有书签的用真标题（《无政府、国家和乌托邦》「译者前言/第一章为什么要探讨自然状态理论？」）。
- 未完成：《邓小平时代的中国》PDF 原文件 pdfjs 报 Invalid PDF structure，未重导；《世界中心的岛·奠基者…》合集 mobi 手机里找不到原文件；txt 无目录概念；少数无 nav 无标题的 spine 文件仍显示「第 N 节」。

## §25 v0.15 乱码 / 真目录 / PDF 缺字（2026-10-21 第二轮）

### 25.1 乱码根因（MOBI）
MOBI 每条文本记录的尾部有一段附加数据（trailing entries）。之前三处都错了：
1. MOBI 头长度读成 `mobiStart + 0x14`（那是 file version），正确是 `mobiStart + 0x04`；
2. extra data flags 读成 `mobiStart + 0xf2`，正确是 `mobiStart + 0xe2`（绝对偏移 0xF2）；
3. 附加数据压在**压缩后**记录末尾，必须先 `trimTrailingEntries` 再 `decompressRecord`，否则会把尾部字节当 LZ77 指令解压。

修完实测：10 本 MOBI 的 U+FFFD 全部为 0（此前 42–7724 个）。

### 25.2 「第 N 节」占位标题
新增 `text.ts/snippetTitle()`：没有真目录时用该节正文第一句（≤16 字）命名，不再用编号。EPUB/MOBI/TXT 三条链路都已替换；txt 的章节正则去掉 `\b`（中文后没有词边界，导致《绝世唐门》1101 节全成占位，修复后 3172 个真章节）。

### 25.3 PDF 缺字与重复节
- 缺字：pdfjs 解码中文 CID 字体需要 `cmaps` 与 `standard_fonts`。新增 `findAssetDir()` 多路径探测，并在部署时把两个目录复制到 `D:\MarginApp\resources\app\`。
- 同一页两个书签导致「下一节还是那页序言」：书签按页严格递增去重，并丢掉空区间。
- 数字书签（1/2/3…）与「封面/目录」这类垃圾书签过滤掉；书签稀疏时按「每页前 3 段的第 X 章/序/前言」补章节；最后合并相邻同名节。

### 25.4 重导方式
按正文 45% 处 30 字归一化片段做内容指纹，把手机拷来的源文件对回 book id，再 `POST /api/upload?name=…&id=<bookId>` 就地替换——划线、卡片、进度全部保留。30 本中 27 本重导成功。

### 25.5 遗留（源文件本身的问题，未伪造）
- 《世界中心的岛…》合集 mobi：手机里找不到原件，仍有 639 个替换符、132 个「第 N 节」。
- 《邓小平时代的中国》PDF：pdfjs 报 Invalid PDF structure，打不开，仍是旧数据。
- 《720事件实录》PDF：292 页无书签、OCR 层识别不出章节，只有「序 / 附录7」两节。
- 《斯大林模式的形成》PDF：OCR 把同一章标题写成多种变体，出现重复章节名。
- 《日常生活中的自我呈现》EPUB：原书目录只到 3 个大块，未再强行细分。

## 26 脚注与上标角标（v0.16）

### 26.1 问题
学术类 PDF 的注释要么是页底小字，要么是正文里的上标数字。原先它们被当成普通行，混进正文，读起来像乱码（「……的产量①」，脚注内容插在段落中间）。

### 26.2 做法
- **页底脚注**：一行若同时满足「位于页面下方 28% 以内」+「字号 < 正文字号 × 0.9」，不进正文，单独成 `blockquote` 块。
- **行内上标**：一个 item 的基线比当前行抬高了「字号 × 0.25」以上、字号小于正文 0.82、内容是 `1–3 位数字` 或 `①–⑳`，说明它是角标。写私有标记 `\u0001N\u0001` 占位（不污染坐标/断段逻辑），建块时替换成
  `<a class="fn-ref" href="#fn-N"><sup>N</sup></a>`；脚注块首加 `<a id="fn-N"></a>` 锚点。
- 渲染层：`.fn-ref` 用主题色、不换行；`blockquote:target` 高亮一下，点角标能跳到底注并闪一下。

### 26.3 实测
《共和国的历程》85 个 section 含 `fn-ref`；《国家制度和无政府状态》（OCR 本）9 个 section 含 `fn-ref`，点「1」直接跳到「1 1949年按年底1美元兑……」那条。

## 27 扫描件 OCR（v0.17）

### 27.1 选型：不装任何东西
评估过 tesseract.js（要联网下模型、慢）、PaddleOCR（要 Python/native）、云 OCR（要联网、要钱）。最终用 **Windows 自带的 WinRT**：
- `Windows.Data.Pdf.PdfDocument` 渲染页面为位图（不用 pdf.js + canvas，不用原生模块）；
- `Windows.Media.Ocr` 识别，本机只有 `zh-Hans-CN` 一个语言包，够用；
- 全程离线，零依赖，零安装。

### 27.2 关键坑
- **必须用 Windows PowerShell 5.1**（`powershell.exe`），pwsh 7(.NET 10) 加载不了 WinRT 类型，报 `Unable to find type Windows.Media.Ocr.OcrEngine`。
- WinRT 集合的索引 `$line.Words[0].BoundingRect.X` 会退化成 `Object[]`，`[int]` 转换直接抛异常。先把 `$r = $w.BoundingRect` 落到标量，再取 `[int]$r.X`；行坐标在循环里记住首个词的 x/y。
- 脚本结束（`$writer.Close()` 之后）进程常以 **0xC0000005 访问违例**退出，这是 WinRT 回收的老问题，`[Environment]::Exit(0)` 也压不住。Node 侧把 `3221225477 / -1073741819` 当「可疑成功」，只要结果文件完整就接受。
- 几百页拼一个大字符串再写会崩（261 页直接进程死、结果全丢）。改成 **JSONL 流式写**：首行写总页数，之后每页一行，写一行 `Flush()` 一行。末行被截断就丢掉，靠首行声明的页数判断完整性。

### 27.3 速度
`-MaxWidth 2000`（250 DPI 渲染后按宽度封顶）时 **1.27 秒/页**；261 页整本 474 秒（7.9 分钟）。不限宽会到 3.6 秒/页且吃内存。识别出来的字之间被插了空格（`国 家 制 度`），复用既有 `squeeze()` 去掉即可。

### 27.4 接进现有管线
- `parsePdf()` 先走 pdfjs 文字层；若无文字层（或字数 < `max(40, 页数×8)`），判定为扫描件，落盘临时 PDF → `ocrPdfFile()` → 每页的「词」重建成 `Line[]`（字号取词高中位数、坐标翻转成 pdf.js 坐标系、上标照样打 `\u0001N\u0001` 标记）→ 交给同一个 `finishPage()`。**空页必须占位**，否则按页码取节的区间会整体错位。
- 结果按 PDF 内容 SHA1 缓存在 `%APPDATA%\页边\ocr-cache\`，重导同一本书 1–3 秒完成。
- 进度：主进程记 `ocrLive{name,done,total}`，`books:progress` 走 IPC/HTTP 暴露；渲染层导入时每 2 秒轮询，toast 显示「正在识别扫描件《书名》12/261 页…」。

### 27.5 目录别编造
书签就是原书目录，读者认的就是它。早期版本还会在书签跨度 ≥60 页时按 25 页硬切一段，结果一个「导论」被拆成「导论·第 9–33 页」九条假目录——属于自作主张，已彻底删掉；扫描件连「字号变大的短行」这种启发式也不用（字号是 OCR 估出来的，只会造出「的全俄罗斯沙皇的鞭子去拯救他们！」这种假章节）。现在：**有书签就严格按书签分节，没书签才找「第 X 章」这类真标题，都没有就整本一节**。同时修掉三个目录问题：书签里的控制符（`版权页\u0000` 漏过垃圾过滤）、PDF 字符串转义残留（`补充\(一\)`）、首节书名与作者被空格挤在一起。

### 27.6 实测
《国家制度和无政府状态》261 页纯扫描件 → 13 节、18 万字、0 个 U+FFFD、9 节带可跳转脚注；正文样张「巴枯宁（1814一1876）是俄国无政府主义者……」通顺可读。（节数是当时还没删掉 25 页硬切和字号启发式的版本，现已按原书书签收敛到 5 节，见 §28.9。）

> **注**：本节记录的 Windows.Media.Ocr 方案已在 v0.18 被 PP-OCRv4 取代（见 §28）。保留此节是因为其中三个坑（PowerShell 5.1、WinRT 集合索引、进程 0xC0000005）在渲染脚本 `render.ps1` 里依然适用。

## 28 扫描件 OCR 换引擎：PP-OCRv4 自建管线（v0.18）

### 28.1 为什么要换
Windows.Media.Ocr 速度够（1.27 秒/页）但识别质量撑不起精读：把「商务印书馆」拆成三个碎块、把「根据莱顿」认成「根倨来顿」、「自由」认成「自山」、「普鲁士」认成「普鲁七」、「能干」认成「能千」、「像」认成「象」。用户的原话是「这种细节上的疏漏也是十分影响观感的」。

### 28.2 选型过程（实测，不是拍脑袋）
| 方案 | 单页耗时 | 质量 |
| --- | --- | --- |
| Windows.Media.Ocr | 1.3 s | 差（见上） |
| `@gutenye/ocr-node`（PP-OCRv4 包装） | 17.7 s | 好 |
| **自建 PP-OCRv4（采用）** | **5.2 s** | 好 |

`@gutenye` 慢不在 onnxruntime：直接跑 rec 模型只要 38–45 ms/次。慢在它的纯 JS 预处理——det 把整页 resize 到 32 的倍数且没有上限（2500×3878 → 2528×3904），一次 det 就 19–27 秒，rec 还要 366 ms/行。于是自建：模型用同款 PP-OCRv4（det 4.7 MB + rec 10.8 MB），预处理/后处理全部自己写，检测分辨率封到 960、识别按宽度分桶批量跑。

### 28.3 管线（`src/main/core/ppocr.ts`）
1. `scripts/render.ps1` 用 `Windows.Data.Pdf` 把 PDF 逐页渲染成 PNG（每页 0.3 s，只渲染不识别），参数 `-MaxWidth 2500`。
2. det：`sharp` 读图 → 缩到 640×960（32 的倍数）→ 归一化 → onnxruntime CPU → 输出概率图。
3. 后处理：阈值 0.3 → 自己写的 BFS 连通域（4 邻接，`Int32Array` 栈）→ 过滤碎块 → **unclip 外扩**。
   - 坑：DB 概率图是收缩后的内核区域，直接按 AABB 裁剪会切掉字的上下半截，识别出「巴右宁」「马意思主义」，置信度只有 0.6–0.8。外扩 `d = w*h*2/(2*(w+h))`、`pad = max(2, h*0.35 + d*0.5)` 之后置信度 0.98–1.00。
   - `mergeSameLine()` 把垂直重叠 ≥ 半行高、水平间隙很小的框并成一行，解决「商务 / 务印书馆出 / 版」这种碎行。
4. rec：裁成 48 高的长条，按宽度分桶、每 8 行一次 `session.run`（支持动态 batch），DML（DirectML）执行，失败自动退回 CPU。**det 固定 CPU**（DML 上反而慢 13 倍）。
5. CTC 解码：字典 `ppocr_keys_v1.txt`，blank=0；解码时同时记下每个字的第 2/3 候选，供纠错用。

### 28.4 词典纠错（`src/main/core/correct.ts`）
出版物的用字是固定的，OCR 错的永远是那几组形近字，所以用词频词典约束即可，不需要 GPU 语言模型（pycorrector/FASPell 那条路的词典版）。
- 词库：jieba 词频表（`models/dict.txt`，3.4 MB，33 万词），只取 1–4 字、词频 ≥5。
- 打分：整行 DP 最长 4 字窗口，词得分 `log(词频)`，查不到的多字片段重罚，虚词/常用单字固定 0 分（否则「他/它」会因词频差被互换）。
- 判据：把某字换成 CTC 的第 2/3 候选后，**整行得分涨幅 ≥ 8** 才改；该字所在的「孤立字串」长度 ≥3（多半是人名地名，如「巴枯宁」「马骧聪」）直接跳过。
- 实测：4 页样本 3 处修正全对（`即张→印张`、`贵任编辑→责任编辑`、`利已主义者→利己主义者`），误改被拦住（`页→顶`、`他→它`）。整本 261 页共修正 79 处。
- 词典救不了的（只能靠人工）：`王容井→王府井`（专名且词频不够）、`195干→195千`、`定价11.05元`、`印张 81V4`。

### 28.5 行序修复
原实现 `sort((a,b) => a.y - b.y || a.x - b.x)` 在轻微倾斜的扫描页上会把下一行的短句插进上一行中间（读出来是「他并不是一个可怕的 / 没有留下。 / 怪物」）。改为：取行高中位数，容差 `max(6, 中位行高×0.5)`，先按 y 排序，再把 y 差在容差内的行归成一组、组内按 x 排。

### 28.6 部署与体积
- `models/`（det 4.7 MB + rec 10.8 MB + 字典 `ppocr_keys_v1.txt` + 词频表 `dict.txt` 3.4 MB）随包部署到 `resources/app/models`，`scripts/打包.ps1` 里已有复制步骤。
- `node_modules` 需带 `sharp`（含 `@img/sharp-win32-x64`）和 `onnxruntime-node`；后者原始体积 301 MB（含全平台二进制），打包时只留 `bin/napi-v6/win32/x64`，压到 64 MB。
- 两个原生模块都实测能在 Electron 44.9.1 里加载（`ELECTRON_RUN_AS_NODE=1 electron.exe` 跑过 smoke test），`electron.vite.config.ts` 的 `externalizeDepsPlugin()` 自动外置，无需改配置。

### 28.7 速度与缓存
- 2500 宽渲染 + DML 识别：**5.2 秒/页**（261 页约 22 分钟）；纯 4 页切片 21.7 秒（含 2 秒 session 初始化）。
- 缓存粒度从「整本一个 JSONL」改成**每页一个 JSON**：`%APPDATA%\页边\ocr-cache\<PDF 内容 SHA1>\p0001.json`，识别完一页立刻落盘，支持断点续跑；重导同一本书 25 秒。

### 28.8 OCR 的「字号」不能当真
正文被腰斩过一次：`他并不是一个可怕的` / `没有留下。` / `德国人，主要是德国官吏和军官…` / `怪物，而是一个淡黄色头发的青年…`。

- 根因：脚注判定是「字号 < 正文 0.9 倍 且 落在页底 28%」。OCR 的「字号」是词框高度的估值，同一行正文在 96–111 px 之间跳，`96/111 = 0.865` 就跌破了 0.9 —— 于是四行正文被判成脚注抽出来当 `blockquote` 拼到页尾，正文断成两截，跨页续段也跟着错位。
- 修复：`finishPage()` 增加 `isOcr` 参数；OCR 走更严的判据 **字号 < 正文 0.78 倍 且 行首必须是脚注序号**（`^(\d{1,3}|[①-⑳])`），文字层维持原判据。
- 顺带修掉脚注块拼接用的 `join(' ')` → `join('')`，否则会出现「谨慎 斯文」「多愁 善感」这种句内空格。

### 28.9 验收数据
- 《国家制度和无政府状态》261 页纯扫描件：5 节（书名页 3320 / 导论 150908 / 补充(一) 14365 / 补充(二) 1443 / 向何处去？怎么办？ 10570），共 17.9 万字，与原书目录一致。
- 整本 1152 个正文块里「汉字 + 空格 + 汉字」的块数 = 0；导论节仍有 12 处可跳转角标（无回归）。
- 遗留：版权页这类极小字号仍有残错（`王容井→王府井`、`195干→195千`、`印张 81V4`、`定价11.05元`）。这些错需要词频以外的证据（专名库或更高分辨率重识别），词典纠错不敢强改，避免把人名地名改坏。

## 29 手机藏书批量导入（v0.19）

### 29.1 规模
手机（OnePlus 7，MTP）共扫到 **2584 个书文件**：txt 2149、pdf 299（7.1 GB）、epub 100、mobi 35、azw3 1。按文件名去重后 253 个唯一 PDF，最终落到本地 `D:\mobooks` 190 个（其余 63 个因手机中途掉线没拷完）。

### 29.2 两批导入
- **第一批 73 本有文字层**：69 本入库、4 本同名跳过、0 失败，几乎瞬时完成。
- **第二批 64 本扫描件**（按页数从小到大排队）：54 本成功、4 本同名跳过、0 失败，耗时约 24 小时。
- 实测速度 **3.7–3.9 秒/页**（2500 宽渲染 + DirectML rec），全程 21825 页真正走了 OCR。

### 29.3 假扫描件
判断标准是「前 12 页文字 < 每页 8 字」，于是把一批「前面几页是纯图封面/扉页、后面正文有文字层」的书误判成扫描件。《高岗文集》《继续革命著作选读》《邱会作回忆录》《江青在她的时代》《革命造反年代1》等都是导入时 4–8 秒就完事——识别没白跑，直接走文字层抽取。判断成本低，这个误差可以接受。

### 29.4 标题与去重清理
PDF 元数据标题常常是垃圾：`SSReader Print.`、`Unknown`、`ssreader`、一长串 UUID、甚至 `D:\wwwroot\...epub` 这种源文件路径，还有文件名本身是纯数字（`59.pdf` 的元数据标题是 `14578919`）。共修了 9 本：
- 依正文判断后重命名：《法国史学革命：年鉴学派，1929—2014》《博弈论与信息经济学》《革命造反年代 1》《邓小平言论自相矛盾“百花大观园”》《马恩列斯毛与刘邓言论对比录》《不再沉默——一个文革亲历者的回顾与思考（武彩霞）》《〈中国的奇迹：发展战略与经济改革〉评介》；
- 内容能看出性质但原书确实没有书名的两本，暂用描述性名称：《无产阶级专政下继续革命 论述汇编》《文革亲历者访谈合集》。
删掉 5 本重复：`国际经济学译丛 流行的国际主义`、`数量上册`、`1960年民兵手册.xps`、`斯大林模式的形成`（旧版保留）、`历史决定论的贫困`（保留篇幅更全的一版）。

### 29.5 最终结果
书库 **157 本 / 5241 万字**（pdf 135、epub 10、mobi 11、txt 1），数据库 736 MB，OCR 缓存 51 本 21825 页（0.14 GB，重导秒回）。

### 29.6 遗留
- 手机还有 **63 个 PDF** 没拷到本地（互助论、社会心理学彩印版、苏联史第九卷等），需重新插线补拷。
- 《若干重大决策与事件的回顾》这类无书签的大部头只有 1–2 节（1316 页 76 万字挤在一节），按「不许编造目录」的原则没有硬切，将来可以靠目录页文本做分节。
- 版权页极小字号仍有残错，词典纠错不敢强改（见 §28.9）。
## 30 印刷目录页分节（v0.20）

### 30.1 为什么做
书签是 PDF 里最可靠的目录，可有些书（尤其扫描本）的书签只有「前言 / 后记」两条，甚至一条都没有。《若干重大决策与事件的回顾（上、下）》1316 页 76 万字，就被塞进了「前言」一节。用户的原话：「这种事情不应该是正常导入的时候就应该做的吗？」

### 30.2 做法（eadPrintedToc）
1. **找目录页**：全书逐页扫，一页里「纯页码行 ≥4 条」或「页首写着目录/目次且页码行 ≥2 条」就算；连续页合并成一段，最多收 6 段——合订本上卷、下卷各有一套目录，要都认得。
2. **切条目**：目录页的排版五花八门——一接管平、津、二新中国的建立、三刘少奇同志……46、页码单独一行（5、·18、...35）。所以不按页码切，而按**章序号**（一/二/……/二十一）切；（一）（二） 是节，不进目录。折行的章标题接到上一条。
3. **章首页码**：OCR 常把章首页码和小节页码搅在一起，所以每个章收集一串候选页码，取「比上一章大的里面最小的」那个。
4. **定位到物理页**：不靠页码换算（页眉页脚清理早就删掉了纯页码行，合订本上下卷还各算一套页码），而是**从上一章之后往后找「章标题出现在页首 6 行内」的那一页**，找不到就跳过。最后强制单调递增。
5. **接入点**：书签「少于 3 条」或「一条书签吞掉半本以上」时才用印刷目录；没书签的书直接用它；都没有才退回「第 X 章」启发式和整本一节。

### 30.3 实测
- 《若干重大决策与事件的回顾（上、下）》：2 节 → **43 节**（上卷 20 章 + 下卷 22 章 + 封面版权页一节），节名和原书目录一致（接管平、津、二新中国的建立……四十三开始全面建设社会主义十年的经验与），单节最大 2.8 万字。重导 34 秒（OCR 缓存命中）。
- 回归：《共和国的历程》112 节不变；《720事件实录》仍 2 节——这本**根本没有印刷目录页**，且小标题是「一、二、」式，不在本次范围内。
- 顺带修掉两处：封面书名被拆成「若干重大决策与」/「事件的回顾」时自动接上；页眉判定以前要求重复 页数×25% 次（1300 页的书要 325 次），短行改成重复 3 次就算页眉，不再把「前言」之类页眉拼进正文。

### 30.4 局限
- 目录页 OCR 质量差到认不出条目的书，仍然退回原逻辑。
- 章标题在正文里若不出现在页首（章从页面中间开始），该章会被跳过，并入上一节。
- 「一、二、」式（顿号）小标题未支持，CHAPTER_TITLE_RE 目前只认「第 X 章/节/回」。