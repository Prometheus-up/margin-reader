import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixPunct, fixText, type CharCand } from './correct'

/**
 * PP-OCRv4（PaddleOCR 的检测 + 识别模型）跑在 onnxruntime 上。
 *
 * 为什么要自己写这一层：
 * - Windows 自带的 Windows.Media.Ocr 对中文扫描件错字偏多（像/象、自由/自山、普鲁士/普鲁七），
 *   而且逐词返回、把「商务印书馆」拆成「商」「务印书」「馆」；
 * - @gutenye/ocr-node 这类现成封装质量好，但它把整页 resize 到没有上限（一页识别 17–27 秒）；
 * - 这里只做必要的事：检测缩到 960 长边、连通域取行框、unclip 补偿、识别按宽度分桶批量跑，
 *   一张 2500px 的正文页约 3.5 秒，250 页的书十几分钟，质量与 PaddleOCR 官方一致。
 */

export interface PpLine {
  t: string
  x: number
  y: number
  w: number
  h: number
  q: number
}

export interface PpPage {
  w: number
  h: number
  lines: PpLine[]
}

const DET_FILE = 'ch_PP-OCRv4_det_infer.onnx'
const REC_FILE = 'ch_PP-OCRv4_rec_infer.onnx'
const DICT_FILE = 'ppocr_keys_v1.txt'

/** 模型目录：打包后在 resources/app/models，开发时在项目根 models/ */
function modelsDir(): string {
  let here = process.cwd()
  try {
    here = dirname(fileURLToPath(import.meta.url))
  } catch {
    /* 打包成 CJS 后没有 import.meta */
  }
  const cands = [
    process.env.MARGIN_OCR_MODELS ?? '',
    join((process as any).resourcesPath ?? '', 'app', 'models'),
    join(process.cwd(), 'models'),
    join(here, '..', '..', '..', 'models'),
    join(here, '..', '..', '..', '..', 'models')
  ]
  return cands.find((p) => p && existsSync(join(p, REC_FILE))) ?? ''
}

/** 模型在不在、依赖装没装 */
export function ppOcrAvailable(): boolean {
  return process.platform === 'win32' && !!modelsDir()
}

interface Sessions {
  ort: any
  sharp: any
  det: any
  rec: any
  dict: string[]
}

let loading: Promise<Sessions> | null = null

async function load(): Promise<Sessions> {
  const dir = modelsDir()
  if (!dir) throw new Error('找不到 OCR 模型目录（models/）')
  const ortMod: any = await import('onnxruntime-node')
  const ort = ortMod.default ?? ortMod
  const sharpMod: any = await import('sharp')
  const sharp = sharpMod.default ?? sharpMod

  const detPath = join(dir, DET_FILE)
  const recPath = join(dir, REC_FILE)
  // CPU 跑检测最快（DirectML 在这个模型上反而慢 10 倍）；
  // 识别（rec）走 DirectML 能快一倍，显卡不可用时退回 CPU
  const det = await ort.InferenceSession.create(detPath, { executionProviders: ['cpu'] })
  let rec: any
  try {
    rec = await ort.InferenceSession.create(recPath, { executionProviders: ['dml'] })
  } catch {
    rec = await ort.InferenceSession.create(recPath, { executionProviders: ['cpu'] })
  }
  const dict = [...readFileSync(join(dir, DICT_FILE), 'utf8').split('\n'), ' ']
  return { ort, sharp, det, rec, dict }
}

function sessions(): Promise<Sessions> {
  if (!loading) {
    loading = load().catch((e) => {
      loading = null
      throw e
    })
  }
  return loading
}

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * 同一行的多个框并成一个：垂直方向重叠过半、水平间隙小于约 1.5 个字高就合并。
 * 封面和版权页的美术字/方框里的字常被检测切成好几块，不合并就会识别成「商务」「务印书馆出」「版」。
 */
function mergeSameLine(input: Box[]): Box[] {
  const boxes = input.map((b) => ({ ...b }))
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        const hMin = Math.min(a.y1 - a.y0, b.y1 - b.y0)
        const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
        if (oy < hMin * 0.5) continue
        const gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1)
        if (gap > Math.max(8, hMin * 1.5)) continue
        boxes[i] = {
          x0: Math.min(a.x0, b.x0),
          y0: Math.min(a.y0, b.y0),
          x1: Math.max(a.x1, b.x1),
          y1: Math.max(a.y1, b.y1)
        }
        boxes.splice(j, 1)
        changed = true
        break
      }
      if (changed) break
    }
  }
  return boxes
}

const DET_MAX = 960
const DET_THRESH = 0.3
const REC_H = 48
const REC_MAX_W = 1600
const BATCH = 8

/** 识别一张页面图片（PNG/JPEG 均可），返回行框与文字，坐标是图片像素坐标 */
export async function ppOcrPng(file: string): Promise<PpPage> {
  const { ort, sharp, det, rec, dict } = await sessions()

  const page = await sharp(file).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const pw: number = page.info.width
  const ph: number = page.info.height
  const pch: number = page.info.channels

  // ---- 检测：整页缩到长边 960，输出收缩后的文字区域概率图 ----
  const scale = Math.min(1, DET_MAX / Math.max(pw, ph))
  const dw = Math.max(32, Math.ceil((pw * scale) / 32) * 32)
  const dh = Math.max(32, Math.ceil((ph * scale) / 32) * 32)
  const detImg = await sharp(page.data, { raw: { width: pw, height: ph, channels: pch } })
    .resize({ width: dw, height: dh, fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer()
  const n = dw * dh
  const detData = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    const r = detImg[i * 3 + 2]
    const g = detImg[i * 3 + 1]
    const b = detImg[i * 3]
    detData[i] = (r / 255 - 0.5) / 0.5
    detData[n + i] = (g / 255 - 0.5) / 0.5
    detData[2 * n + i] = (b / 255 - 0.5) / 0.5
  }
  const detOut = await det.run({ x: new ort.Tensor('float32', detData, [1, 3, dh, dw]) })
  const map = detOut[Object.keys(detOut)[0]]
  const mh: number = map.dims[2]
  const mw: number = map.dims[3]

  // ---- 连通域：概率图 > 阈值 的连通块就是一行字（多行会被分成多个块） ----
  const bin = new Uint8Array(mw * mh)
  for (let i = 0; i < bin.length; i++) bin[i] = map.data[i] > DET_THRESH ? 1 : 0
  const seen = new Uint8Array(mw * mh)
  const stack = new Int32Array(mw * mh)
  const boxes: { x: number; y: number; w: number; h: number }[] = []
  for (let y0 = 0; y0 < mh; y0++) {
    for (let x0 = 0; x0 < mw; x0++) {
      const s = y0 * mw + x0
      if (!bin[s] || seen[s]) continue
      let sp = 0
      stack[sp++] = s
      seen[s] = 1
      let minX = x0
      let maxX = x0
      let minY = y0
      let maxY = y0
      let cnt = 0
      while (sp > 0) {
        const p = stack[--sp]
        cnt++
        const py = (p / mw) | 0
        const px = p - py * mw
        if (px < minX) minX = px
        if (px > maxX) maxX = px
        if (py < minY) minY = py
        if (py > maxY) maxY = py
        if (px > 0 && bin[p - 1] && !seen[p - 1]) {
          seen[p - 1] = 1
          stack[sp++] = p - 1
        }
        if (px < mw - 1 && bin[p + 1] && !seen[p + 1]) {
          seen[p + 1] = 1
          stack[sp++] = p + 1
        }
        if (py > 0 && bin[p - mw] && !seen[p - mw]) {
          seen[p - mw] = 1
          stack[sp++] = p - mw
        }
        if (py < mh - 1 && bin[p + mw] && !seen[p + mw]) {
          seen[p + mw] = 1
          stack[sp++] = p + mw
        }
      }
      const w = maxX - minX + 1
      const h = maxY - minY + 1
      if (cnt < 6 || w < 3 || h < 3) continue
      // 概率均值太低的多半是噪点、扫描杂纹
      let sum = 0
      for (let yy = minY; yy <= maxY; yy++) {
        for (let xx = minX; xx <= maxX; xx++) sum += map.data[yy * mw + xx]
      }
      if (sum / (w * h) < 0.4) continue
      boxes.push({ x: minX, y: minY, w, h })
    }
  }

  // ---- 概率图是「收缩」后的内核区域，直接裁会切掉字的上下沿（识别成「巴右宁」），
  //      按 DB 论文的 unclip 公式外扩 ---- //
  const sx = pw / mw
  const sy = ph / mh
  const items = boxes
    .map((b) => {
      const d = Math.round((b.w * b.h * 2) / (2 * (b.w + b.h)))
      const pad = Math.max(2, Math.round(b.h * 0.35) + Math.round(d * 0.5))
      const x0 = Math.max(0, Math.round((b.x - pad) * sx))
      const y0 = Math.max(0, Math.round((b.y - pad) * sy))
      const x1 = Math.min(pw, Math.round((b.x + b.w + pad) * sx))
      const y1 = Math.min(ph, Math.round((b.y + b.h + pad) * sy))
      return { x0, y0, x1, y1 }
    })
    .filter((b) => b.x1 - b.x0 > 4 && b.y1 - b.y0 > 4)
  // 同一行被切成几块（「商务」「务印书馆出」「版」，或两端对齐的短行在词间断开）先并成整行，
  // 否则识别出来就是半句一句，排版也散
  const merged = mergeSameLine(items)
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
  if (!merged.length) return { w: pw, h: ph, lines: [] }

  // ---- 识别：裁成 48 高的长条，按宽度分桶批量跑（一次 session.run 跑 8 行） ----
  const crops: { w: number; raw: Buffer; box: (typeof merged)[number] }[] = []
  for (const it of merged) {
    const bw = Math.min(REC_MAX_W, Math.max(8, Math.round(((it.x1 - it.x0) * REC_H) / Math.max(1, it.y1 - it.y0))))
    const raw = await sharp(page.data, { raw: { width: pw, height: ph, channels: pch } })
      .extract({ left: it.x0, top: it.y0, width: it.x1 - it.x0, height: it.y1 - it.y0 })
      .resize({ width: bw, height: REC_H, fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer()
    crops.push({ w: bw, raw, box: it })
  }

  const out: PpLine[] = []
  const order = crops.map((_, i) => i).sort((a, b) => crops[a].w - crops[b].w)
  for (let s0 = 0; s0 < crops.length; s0 += BATCH) {
    const grp = order.slice(s0, s0 + BATCH)
    const bw = Math.ceil(Math.max(...grp.map((i) => crops[i].w)) / 8) * 8
    const plane = REC_H * bw
    const data = new Float32Array(grp.length * 3 * plane)
    for (let b = 0; b < grp.length; b++) {
      const c = crops[grp[b]]
      const off = b * 3 * plane
      for (let y = 0; y < REC_H; y++) {
        for (let x = 0; x < c.w; x++) {
          const i = y * c.w + x
          const o = y * bw + x
          data[off + o] = (c.raw[i * 3 + 2] / 255 - 0.5) / 0.5
          data[off + plane + o] = (c.raw[i * 3 + 1] / 255 - 0.5) / 0.5
          data[off + 2 * plane + o] = (c.raw[i * 3] / 255 - 0.5) / 0.5
        }
      }
    }
    const rOut = await rec.run({ x: new ort.Tensor('float32', data, [grp.length, 3, REC_H, bw]) })
    const o = rOut[Object.keys(rOut)[0]]
    const T: number = o.dims[1]
    const C: number = o.dims[2]
    for (let b = 0; b < grp.length; b++) {
      let prev = -1
      let s = ''
      let conf = 0
      let cnt = 0
      const cands: CharCand[] = []
      for (let i = 0; i < T; i++) {
        const base = b * T * C + i * C
        let bi = 0
        let bv = -Infinity
        let bi2 = -1
        let bv2 = -Infinity
        let bi3 = -1
        let bv3 = -Infinity
        for (let c = 0; c < C; c++) {
          const v = o.data[base + c]
          if (v > bv) {
            bi3 = bi2
            bv3 = bv2
            bi2 = bi
            bv2 = bv
            bv = v
            bi = c
          } else if (v > bv2) {
            bi3 = bi2
            bv3 = bv2
            bi2 = c
            bv2 = v
          } else if (v > bv3) {
            bi3 = c
            bv3 = v
          }
        }
        if (bi === 0 || bi === prev) {
          prev = bi
          continue
        }
        prev = bi
        // 不管置信度高低都记下第二、第三候选：这两个字往往就是「形近字认错」的正确答案，
        // 由词典去判断该不该换（置信度高但认错的字也得有机会被纠正，例如 贵任→责任）
        {
          const alt: string[] = []
          const altp: number[] = []
          for (const [idx, val] of [
            [bi2, bv2],
            [bi3, bv3]
          ]) {
            if (idx <= 0) continue
            const c2 = dict[idx - 1] ?? ''
            if (!c2 || !/[\u4e00-\u9fff]/.test(c2)) continue
            alt.push(c2)
            altp.push(val)
          }
          if (alt.length) cands.push({ i: s.length, c: alt, p: altp })
        }
        s += dict[bi - 1] ?? ''
        conf += bv
        cnt++
      }
      if (!s.trim()) continue
      s = fixPunct(fixText(s, cands))
      const box = crops[grp[b]].box
      out.push({
        t: s,
        x: box.x0,
        y: box.y0,
        w: box.x1 - box.x0,
        h: box.y1 - box.y0,
        q: cnt ? conf / cnt : 0
      })
    }
  }
  // 按行排序。扫描件常有轻微倾斜/抖动，两个相邻行的 y 差可能只有几个像素，
  // 直接按 y 排会把「下一行的一个短句」插到上一行中间（读起来像错版）。
  // 所以先按 y 粗排，再把 y 差不到半个行高的行并成一组，组内按 x 排。
  const hs = out.map((l) => l.h).sort((a, b) => a - b)
  const hMed = hs.length ? hs[Math.floor(hs.length / 2)] : 20
  const tol = Math.max(6, hMed * 0.5)
  out.sort((a, b) => a.y - b.y)
  const rows: PpLine[][] = []
  for (const l of out) {
    const g = rows[rows.length - 1]
    if (g && Math.abs(l.y - g[0].y) <= tol) g.push(l)
    else rows.push([l])
  }
  const ordered: PpLine[] = []
  for (const g of rows) ordered.push(...g.sort((a, b) => a.x - b.x))
  return { w: pw, h: ph, lines: ordered }
}
