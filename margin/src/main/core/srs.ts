/**
 * 极简间隔重复（FSRS 思路的简化版）。
 *
 * 只保留四个状态量：stability（记忆稳定度，单位「天」）、difficulty（0–1）、
 * reps（成功复习次数）、lapses（遗忘次数）。足够区分「忘了 / 有点印象 / 记得牢」，
 * 又不需要跑完整的 FSRS 参数拟合。
 */
export type Grade = 0 | 1 | 2 | 3

export interface CardState {
  stability: number
  difficulty: number
  reps: number
  lapses: number
  state: number
}

export interface ScheduleResult extends CardState {
  due_at: number
  intervalDays: number
}

const DAY = 86_400_000
const MIN = 60_000

export function schedule(s: CardState, grade: Grade, now = Date.now()): ScheduleResult {
  const isNew = s.stability <= 0
  let { stability, difficulty, reps, lapses } = s
  if (!difficulty) difficulty = 0.3

  let intervalDays: number
  let dueAt: number
  let state: number

  if (grade === 0) {
    // 忘了：回到学习态，10 分钟后再出现，稳定度打回
    lapses += 1
    stability = Math.max(0.4, isNew ? 0.4 : stability * 0.35)
    difficulty = clamp(difficulty + 0.12, 0, 1)
    intervalDays = 0
    dueAt = now + 10 * MIN
    state = 1
  } else {
    const ease = grade === 1 ? 1.35 : grade === 2 ? 2.3 : 3.1
    stability = isNew ? (grade === 1 ? 1 : grade === 2 ? 2.5 : 4) : stability * ease
    stability = Math.min(400, Math.max(0.5, stability))
    difficulty = clamp(difficulty + (grade === 1 ? 0.05 : grade === 3 ? -0.07 : -0.01), 0, 1)
    reps += 1
    // 难度越高，实际间隔越短
    intervalDays = Math.min(400, Math.max(1, Math.round(stability * (1.15 - difficulty * 0.35))))
    dueAt = now + intervalDays * DAY
    state = 2
  }

  return { stability, difficulty, reps, lapses, state, due_at: dueAt, intervalDays }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** 人类可读的下次间隔 */
export function humanInterval(ms: number): string {
  const d = ms / DAY
  if (d < 1 / 24) return '一会儿'
  if (d < 1) return `${Math.round(d * 24)} 小时后`
  if (d < 30) return `${Math.round(d)} 天后`
  if (d < 365) return `${Math.round(d / 30)} 个月后`
  return `${(d / 365).toFixed(1)} 年后`
}
