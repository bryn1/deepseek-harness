import { describe, expect, it } from 'vitest'
import { resolveWarmConfig } from '@deepseek-ai/dsh-compaction-warm/src/config.ts'
import type { WarmCompactionConfig } from '@deepseek-ai/dsh-compaction-warm'
import { warmHarness } from './harness.ts'

describe('resolveWarmConfig', () => {
  it('defaults every warm field and keeps base fields for the base resolver', () => {
    const resolved = resolveWarmConfig({ thresholdRatio: 0.42, warm: false, warmProviders: ' Mock , X ', warmRequireReportedCache: true })
    expect(resolved.warm).toEqual({
      warm: false,
      warmProviders: ['mock', 'x'],
      warmRequireReportedCache: true,
    })
    expect(resolved.base).toEqual({ thresholdRatio: 0.42 })
  })

  it('allows every provider when the provider list is empty', () => {
    const resolved = resolveWarmConfig({ warmProviders: ' , ' })
    expect(resolved.warm.warmProviders).toEqual([])
    expect(resolved.warm.warm).toBe(true)
    expect(resolved.warm.warmRequireReportedCache).toBe(false)
  })

  it('rejects wrong warm key types at load', () => {
    const bad = [
      [{ warm: 'yes' }, /WarmCompactionConfig: warm must be a boolean/],
      [{ warmProviders: 12 }, /WarmCompactionConfig: warmProviders must be a string/],
      [{ warmRequireReportedCache: 'auto' }, /WarmCompactionConfig: warmRequireReportedCache must be a boolean/],
    ] as Array<[unknown, RegExp]>
    for (const [config, pattern] of bad) {
      expect(() => resolveWarmConfig(config as WarmCompactionConfig)).toThrow(pattern)
    }
  })

  it('leaves base key validation to BasicCompactionEngine via super', () => {
    const bad = [
      [{ auto: 'sometimes' }, /BasicCompactionConfig: auto must be a boolean/],
      [{ thresholdRatio: 0 }, /thresholdRatio/],
    ] as Array<[unknown, RegExp]>
    for (const [config, pattern] of bad) {
      expect(() => warmHarness(config as WarmCompactionConfig)).toThrow(pattern)
    }
  })

  it('keeps base configuration visible on the engine after the split', () => {
    const { engine } = warmHarness({ thresholdRatio: 0.42, headroomTokens: 4000 })
    expect(engine.config).toMatchObject({ thresholdRatio: 0.42, headroomTokens: 4000, auto: false })
  })
})
