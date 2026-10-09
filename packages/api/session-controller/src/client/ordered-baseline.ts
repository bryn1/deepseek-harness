/**
 * Merge an authoritative baseline without moving identities already visible to
 * the client. Baseline-only identities are inserted relative to the nearest
 * following known identity; identities absent from the baseline are removed.
 *
 * @param current - the established client order.
 * @param baseline - the latest authoritative rows.
 * @param keyOf - stable identity selector.
 * @returns baseline-valued rows with the established relative order retained.
 */
export function mergeOrderedBaseline<T>(
  current: readonly T[],
  baseline: readonly T[],
  keyOf: (value: T) => unknown,
): T[] {
  const baselineByKey = new Map<unknown, T>()
  for (const value of baseline) baselineByKey.set(keyOf(value), value)

  const merged = current
    .map(value => baselineByKey.get(keyOf(value)))
    .filter((value): value is T => value !== undefined)
  const mergedKeys = new Set(merged.map(keyOf))

  for (let index = 0; index < baseline.length; index++) {
    const value = baseline[index]
    /* v8 ignore next -- dense-array guard: index is bounded by baseline.length. */
    if (value === undefined || mergedKeys.has(keyOf(value))) continue
    let insertion = merged.length
    for (let following = index + 1; following < baseline.length; following++) {
      const candidate = baseline[following]
      /* v8 ignore next -- dense-array guard: following is bounded by baseline.length. */
      if (candidate === undefined) continue
      const known = merged.findIndex(item => keyOf(item) === keyOf(candidate))
      if (known !== -1) {
        insertion = known
        break
      }
    }
    merged.splice(insertion, 0, value)
    mergedKeys.add(keyOf(value))
  }
  return merged
}

/**
 * Merge streamed list arrivals without hiding established identities.
 * Established rows the stream has not carried yet keep their relative
 * positions ahead of arrival rows; every id the stream carried appears once,
 * with its latest arrival value, at its first-arrival position. Nothing is
 * removed — only the completion frame's {@link mergeOrderedBaseline} install
 * settles membership.
 *
 * @param established - the client's current order.
 * @param arrivals - rows in stream (page, then in-page) order; repeats allowed.
 * @param keyOf - stable identity selector.
 * @returns established rows absent from `arrivals` in established order, then
 *   arrival ids in first-arrival order.
 */
export function mergeStreamedBaseline<T>(
  established: readonly T[],
  arrivals: Iterable<T>,
  keyOf: (value: T) => unknown,
): T[] {
  const latestByKey = new Map<unknown, T>()
  for (const value of arrivals) latestByKey.set(keyOf(value), value)
  const merged = established.filter(value => !latestByKey.has(keyOf(value)))
  for (const value of latestByKey.values()) merged.push(value)
  return merged
}
