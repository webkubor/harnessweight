import { test } from "node:test"
import assert from "node:assert/strict"
import { errorReason } from "../lib/errors.mjs"
import { egressCluster, isEgressFailure, BUCKET_MS } from "../lib/egress.mjs"
import { summarize } from "../lib/summarize.mjs"
import { parseUsageLine } from "../lib/usage.mjs"

const T0 = Date.parse("2026-11-16T16:00:00Z")
const mk = (values = {}) => parseUsageLine(JSON.stringify({ t: T0, agent: "claude", model: "m1", provider: "alpha", status: 200, ...values }))
const fail = (provider, message, minute, status = 0) => mk({ provider, t: T0 + minute * 60e3, status, err: message })
const ok = (provider, minute) => mk({ provider, t: T0 + minute * 60e3 })

test("network-path failures get their own categories instead of falling into unknown", () => {
  // the strings this machine actually logs when a proxy or VPN is in the way
  assert.equal(errorReason(0, "", "getaddrinfo ENOTFOUND agent.minimax.cn"), "dns")
  assert.equal(errorReason(0, "", "getaddrinfo ENOTFOUND www.workbuddy.ai"), "dns")
  assert.equal(errorReason(0, "", "getaddrinfo EAI_AGAIN api.example.com"), "dns")
  assert.equal(errorReason(200, "", "Xiaomi MiMo: no first token in 30s"), "timeout")
  assert.equal(errorReason(200, "", "MiniMax Code: no first token in 30s"), "timeout")
  assert.equal(errorReason(0, "", "EOF"), "network")
  assert.equal(errorReason(0, "", "read tcp: connection reset by peer"), "network")
  // a gateway's 502 that is really a broken connection is transport, not app
  assert.equal(errorReason(502, "", 'Post "https://ark.example.com/v3/chat/completions": unexpected EOF'), "network")
  assert.equal(errorReason(502, "", "ECONNRESET: The socket connection was closed unexpectedly."), "network")
  // the client's own proxy being down reports as a 502 from the local gateway
  assert.equal(errorReason(502, "", 'Post "https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages?beta=true": proxyconnect tcp: dial tcp 127.0.0.1:7890: connect: connection refused'), "network")
  assert.equal(errorReason(502, "", 'Post "https://opencode.ai/inference/go/openai/v1/chat/completions": proxyconnect tcp: dial tcp 127.0.0.1:7890: connect: connection refused'), "network")
  assert.equal(errorReason(503, "", "dial tcp 1.2.3.4:443: connect: no route to host"), "network")
  // and the categories that were already right stay right
  assert.equal(errorReason(0, "", ""), "unknown")
  assert.equal(errorReason(400, "invalid_request_error", ""), "request")
  assert.equal(errorReason(200, "", "Codex: connection lost mid-reply (unexpected EOF)"), "stream")
})

test("only failures of the path to the provider count as shared-path failures", () => {
  assert.equal(isEgressFailure(mk({ status: 0, err: "getaddrinfo ENOTFOUND x" })), true)
  assert.equal(isEgressFailure(mk({ status: 200, err: "unexpected EOF" })), true)
  assert.equal(isEgressFailure(mk({ status: 401, err: "invalid api key" })), false)
  assert.equal(isEgressFailure(mk({ status: 500 })), false)
  assert.equal(isEgressFailure(mk({ status: 404, err: "model glm-5.3 is not available" })), false)
  assert.equal(isEgressFailure(ok("alpha", 0)), false)
  assert.equal(isEgressFailure(null), false)
})

test("one provider failing is that provider's problem, several together is not", () => {
  // three failures, all from one provider: no cluster
  assert.equal(egressCluster([fail("alpha", "ECONNRESET", 1), fail("alpha", "ECONNRESET", 2), fail("alpha", "EOF", 3)]), null)
  // several providers, but only two failures: too thin to call it shared
  assert.equal(egressCluster([fail("alpha", "EOF", 1), fail("beta", "EOF", 2)]), null)
  // several providers failing in the same moment: a cluster
  const rows = [
    fail("xiaomi", "no first token in 30s", 1), fail("xiaomi", "no first token in 30s", 2),
    fail("minimax", "getaddrinfo ENOTFOUND agent.minimax.cn", 2), ok("minimax", 3),
    fail("volcengine", "EOF", 4), ok("volcengine", 5),
  ]
  const e = egressCluster(rows)
  assert.ok(e)
  assert.equal(e.bucketMs, BUCKET_MS)
  assert.equal(e.failures, 4)
  assert.equal(e.windows, 1)
  assert.deepEqual(e.providers.map((p) => [p.provider, p.failures]), [["xiaomi", 2], ["minimax", 1], ["volcengine", 1]])
  assert.equal(e.providers.find((p) => p.provider === "minimax").calls, 2)
  assert.equal(e.reasons[0].count, 2)
  assert.equal(e.from, Math.floor(T0 / BUCKET_MS) * BUCKET_MS)
})

test("provider-side failures never raise the cluster", () => {
  const rows = [
    mk({ provider: "alpha", status: 401, err: "invalid api key", t: T0 }),
    mk({ provider: "beta", status: 429, err: "rate limit exceeded", t: T0 }),
    mk({ provider: "gamma", status: 402, err: "insufficient quota", t: T0 }),
    mk({ provider: "delta", status: 500, t: T0 }),
  ]
  assert.equal(egressCluster(rows), null)
})

test("windows are separate, ordered and counted; the window filter is respected", () => {
  const rows = []
  for (const minute of [0, 11, 22]) {
    rows.push(fail("alpha", "EOF", minute), fail("beta", "EOF", minute + 1), fail("alpha", "EOF", minute + 2))
  }
  const e = egressCluster(rows)
  assert.ok(e)
  assert.equal(e.windows, 3)
  // a provider literally named "unknown" cannot stand in for a second one
  assert.equal(egressCluster([fail("unknown", "EOF", 0), fail("alpha", "EOF", 1), fail("alpha", "EOF", 2)]), null)
  // outside [since, now] nothing counts
  assert.equal(egressCluster(rows.slice(0, 3), { since: T0 + 60e3 }), null)
  assert.equal(egressCluster(rows, { now: T0 + 30e3 }), null)
})

test("summarize reports the cluster first, in the reader's language", () => {
  const usage = [
    fail("xiaomi", "Xiaomi MiMo: no first token in 30s", 1),
    fail("minimax", "getaddrinfo ENOTFOUND agent.minimax.cn", 1),
    fail("volcengine", "getaddrinfo ENOTFOUND ark.example.com", 2),
  ]
  const now = T0 + 3600e3
  const zh = summarize({ usage, period: "today", now, lang: "zh" })
  assert.ok(zh.egress)
  assert.equal(zh.insights[0].kind, "egress")
  assert.match(zh.insights[0].text, /minimax、volcengine、xiaomi/)
  assert.match(zh.insights[0].text, /10 分钟/)
  const en = summarize({ usage, period: "today", now, lang: "en" })
  assert.equal(en.insights[0].kind, "egress")
  assert.match(en.insights[0].text, /minimax, volcengine, xiaomi/)
  assert.match(en.insights[0].text, /10-minute/)
  assert.doesNotMatch(en.insights[0].text, /[一-鿿]/)
  // a healthy ledger says nothing at all
  const calm = summarize({ usage: [ok("xiaomi", 1), ok("minimax", 2)], period: "today", now, lang: "en" })
  assert.equal(calm.egress, null)
  assert.ok(calm.insights.every((i) => i.kind !== "egress"))
})