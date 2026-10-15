/**
 * Load-time validation of the warm policy keys before the base resolves the rest.
 *
 * @module @deepseek-ai/dsh-compaction-warm/config
 */

import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { ResolvedWarmFields, WarmCompactionConfig } from './types.ts'

/** Warm-owned configuration keys stripped before the base validates its fields. */
const WARM_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'warm',
  'warmProviders',
  'warmRequireReportedCache',
])

/**
 * Validate the warm-owned keys and detach them from the base configuration.
 * The base object goes to `BasicCompactionEngine`, which owns validation of
 * every non-warm key, including unknown-key rejection.
 * @param config - untrusted plugin configuration after Loader normalization.
 * @returns the base configuration for `super` and the resolved warm fields.
 * @throws when a warm-owned key has the wrong type.
 */
export function resolveWarmConfig(config: WarmCompactionConfig = {}): {
  base: BasicCompactionConfig
  warm: ResolvedWarmFields
} {
  if (config.warm !== undefined && typeof config.warm !== 'boolean') {
    throw new Error('WarmCompactionConfig: warm must be a boolean')
  }
  if (config.warmRequireReportedCache !== undefined
    && typeof config.warmRequireReportedCache !== 'boolean') {
    throw new Error('WarmCompactionConfig: warmRequireReportedCache must be a boolean')
  }
  if (config.warmProviders !== undefined && typeof config.warmProviders !== 'string') {
    throw new Error('WarmCompactionConfig: warmProviders must be a string')
  }
  const base: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (!WARM_CONFIG_KEYS.has(key)) base[key] = value
  }
  return {
    base,
    warm: Object.freeze({
      warm: config.warm ?? true,
      warmProviders: Object.freeze((config.warmProviders ?? '')
        .split(',')
        .map(entry => entry.trim().toLowerCase())
        .filter(entry => entry.length > 0)),
      warmRequireReportedCache: config.warmRequireReportedCache ?? false,
    }),
  }
}
