# 页边 Margin

[![CI](https://github.com/Prometheus-up/margin-reader/actions/workflows/ci.yml/badge.svg)](https://github.com/Prometheus-up/margin-reader/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 在书页边上和 AI 说话，而不是让 AI 替你读书。

一个本地优先的桌面阅读器：书存在自己电脑上，AI 只在你读到的那一页上说话——不拿后文剧透，也不替你把路走完。

---

## 特性

**能读书**
- EPUB / MOBI / AZW3 / TXT / Markdown / DOCX / PDF
- PDF 逐行重建段落：修跨页、跨栏、被页码切开的断句，剥离页眉页脚
- 中文 PDF 缺字修复（内置 pdf.js 的 CMap 与标准字体）
- 脚注识别与上标角标：角标可点击，跳转到对应脚注
- 扫描版 PDF 离线 OCR（见下）

**目录**
分节按可靠性四级回退，绝不凭空造章节：
1. PDF 自带书签（最可靠，逐条照搬）
2. 书里印着的目录页（书签太粗或缺失时启用，支持合订本的多套目录）
3. 正文里的「第 X 章 / 第 X 节 / 序 / 前言」标题
4. 都没有，整本一节

**扫描件离线 OCR**
- 自建 PP-OCRv4 管线（`onnxruntime-node` + `sharp`），检测用 CPU、识别用 DirectML，2500px 宽渲染约 4–6 秒/页
- 每页识别结果落 JSON 缓存，重解析不必重跑
- CTC 候选 + 词频词典整行打分，纠正常见小字错认；脚注判定只认「字号偏小 **且** 行首是脚注序号」，避免把正文误判成脚注

**读与记**
- 划线提问：交给 AI 的上下文严格限制在「已读到的位置」，越界内容不进入提示词
- AI 翻译、笔记、摘录、知识库、间隔复习（SRS）
- 书籍、划线、笔记全部存本地 SQLite；AI 接口自填（OpenAI 兼容的 baseUrl + key + 模型名）

## 技术栈

Electron 44 · React 19 · TypeScript · electron-vite · pdfjs-dist · onnxruntime-node · sharp · node:sqlite

## 快速开始

```bash
cd margin
npm install          # .npmrc 里配了国内镜像，可按需改回官方源
npm run dev          # 开发模式
```

构建与打包：

```bash
npm run build        # 产物在 out/
npm run typecheck    # 两个 tsconfig 都检查
npm test             # vitest，25 个用例
powershell -ExecutionPolicy Bypass -File scripts\打包.ps1   # 免安装版，默认输出 %USERPROFILE%\MarginApp
```

打包脚本可用环境变量 `MARGIN_OUT` 指定输出目录。

### OCR 模型（不在仓库里）

`margin/models/` 下的两个 ONNX 文件因体积（约 15 MB）未纳入版本库，需要自行放入：

| 文件 | 用途 |
| --- | --- |
| `ch_PP-OCRv4_det_infer.onnx` | 文本行检测 |
| `ch_PP-OCRv4_rec_infer.onnx` | 文本行识别 |

模型来自 PaddleOCR 官方发布的 PP-OCRv4 推理模型，转成 ONNX 后按上表命名即可。仓库内已保留 `ppocr_keys_v1.txt`（识别字符表）与 `dict.txt`（词频词典，纠错用）。

缺这两个文件时，文字层完好的书照常阅读，只有扫描版 PDF 会提示无法识别。

## 目录结构

```
margin/
├─ src/
│  ├─ main/            # 主进程
│  │  ├─ core/         # 解析与业务：epub / mobi / txt / pdf / docx / ocr / ppocr / correct / translate / ai / db / srs …
│  │  ├─ api.ts        # 渲染进程可调的接口表
│  │  └─ index.ts      # 窗口与生命周期
│  ├─ preload/
│  ├─ renderer/        # 界面（书架、阅读器、笔记、翻译、问答、复习…）
│  └─ server/          # 无界面服务（批量导入 / 命令行调用）
├─ scripts/            # 打包、PDF 渲染
├─ models/             # OCR 字符表、词典（ONNX 需自行放置）
└─ 样例/               # 示例书
```

## 文档

设计与实现记录见 [本地AI阅读平台-需求与设计.md](本地AI阅读平台-需求与设计.md)（约 4.3 万字，按版本逐节记录踩过的坑与实测数据）。

## 许可证

[MIT](LICENSE)
