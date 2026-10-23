import { describe, expect, it } from 'vitest'
import { schedule, humanInterval } from './srs'

const NEW = { stability: 0, difficulty: 0.3, reps: 0, lapses: 0, state: 0 }

describe('间隔重复调度', () => {
  it('新卡记得：间隔至少一天，进入复习态', () => {
    const now = 1_700_000_000_000
    const r = schedule(NEW, 2, now)
    expect(r.state).toBe(2)
    expect(r.reps).toBe(1)
    expect(r.due_at).toBeGreaterThan(now + 86_400_000)
    expect(r.intervalDays).toBeGreaterThanOrEqual(1)
  })

  it('忘了：十分钟后重来，lapses 加一', () => {
    const now = 1_700_000_000_000
    const r = schedule({ ...NEW, stability: 10, reps: 3 }, 0, now)
    expect(r.lapses).toBe(1)
    expect(r.state).toBe(1)
    expect(r.due_at - now).toBeLessThanOrEqual(10 * 60_000)
    expect(r.stability).toBeLessThan(10)
  })

  it('连续记得：间隔单调增长', () => {
    let s = schedule(NEW, 2).stability
    const first = s
    s = schedule({ ...NEW, stability: s, reps: 1 }, 2).stability
    expect(s).toBeGreaterThan(first)
    s = schedule({ ...NEW, stability: s, reps: 2 }, 3).stability
    expect(s).toBeGreaterThan(first * 2)
  })

  it('间隔有上限，不会无限膨胀', () => {
    const r = schedule({ stability: 900, difficulty: 0, reps: 9, lapses: 0, state: 2 }, 3)
    expect(r.stability).toBeLessThanOrEqual(400)
    expect(r.intervalDays).toBeLessThanOrEqual(400)
  })

  it('人类可读间隔', () => {
    expect(humanInterval(3 * 86_400_000)).toContain('天')
    expect(humanInterval(45 * 86_400_000)).toContain('个月')
  })
})
