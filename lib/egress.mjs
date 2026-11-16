// One provider failing is that provider's problem. Several unrelated providers
// failing inside the same few minutes is this machine's: a local resolver, a
// VPN, a proxy or a firewall sits in front of all of them. The detector below
// looks only for that second shape, so expired keys, quotas and 429s never
// raise it — those are per-account categories, not shared ones.
// `stream` only ever means the connection was cut after the reply started, so
// it belongs here too: from the outside a cut stream and a refused connection
// are the same question — did the path to the provider break?
export const EGRESS_REASONS = new Set(["dns", "network", "timeout", "stream"])

// Ten minutes is wide enough to hold one burst of retries and narrow enough
// that two unrelated incidents do not land in the same window.
export const BUCKET_MS = 10 * 60e3

const MIN_PROVIDERS = 2
const MIN_FAILURES = 3

export function isEgressFailure(row) {
  return Boolean(row && row.failed) && EGRESS_REASONS.has(row.errorReason)
}

// Rows in [since, now] → the worst window where >=2 providers failed together,
// or null when that never happens. Only counts stay here: no upstream text.
export function egressCluster(rows, { since = -Infinity, now = Infinity, bucketMs = BUCKET_MS } = {}) {
  const buckets = new Map()
  const bucketOf = (t) => {
    const key = Math.floor(t / bucketMs)
    let b = buckets.get(key)
    if (!b) {
      b = { key, from: key * bucketMs, to: (key + 1) * bucketMs, calls: 0, failures: 0, providers: new Map(), reasons: new Map() }
      buckets.set(key, b)
    }
    return b
  }
  const providerOf = (b, name) => {
    let p = b.providers.get(name)
    if (!p) { p = { provider: name, calls: 0, failures: 0 }; b.providers.set(name, p) }
    return p
  }
  for (const r of rows) {
    if (!r || !Number.isFinite(r.t) || r.t < since || r.t > now) continue
    const b = bucketOf(r.t)
    b.calls++
    providerOf(b, r.provider).calls++
    if (!isEgressFailure(r)) continue
    b.failures++
    providerOf(b, r.provider).failures++
    b.reasons.set(r.errorReason, (b.reasons.get(r.errorReason) || 0) + 1)
  }
  // an unnamed provider is not independent evidence of anything
  const hit = (b) => [...b.providers.values()].filter((p) => p.failures > 0 && p.provider !== "unknown")
  const qualifying = [...buckets.values()].filter((b) => hit(b).length >= MIN_PROVIDERS && b.failures >= MIN_FAILURES)
  if (!qualifying.length) return null
  // the worst window: most providers involved, then most failures
  const worst = qualifying.sort((x, y) => {
    const px = hit(x).length
    const py = hit(y).length
    return py - px || y.failures - x.failures || y.key - x.key
  })[0]
  const providers = hit(worst)
    .sort((x, y) => y.failures - x.failures || x.provider.localeCompare(y.provider))
  return {
    bucketMs,
    // how many separate windows show the same shape: one is an incident,
    // several is an ongoing misroute
    windows: qualifying.length,
    from: worst.from,
    to: worst.to,
    calls: worst.calls,
    failures: worst.failures,
    providers,
    reasons: [...worst.reasons.entries()].sort((x, y) => y[1] - x[1]).map(([reason, count]) => ({ reason, count })),
  }
}