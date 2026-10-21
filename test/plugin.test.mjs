// Run: node --test test/
// Loads desktop/plugin.js with the host SDK and React stubbed out, then
// exercises the pure accounting internals exported as `__test`.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const src = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const stub = `
const atom = v => { let s = v; return { get: () => s, set: n => { s = n }, listen: () => () => {} } }
const noop = () => null
const Badge = noop, Button = noop, SegmentedControl = noop, Tip = noop
const cn = (...a) => a.filter(Boolean).join(' ')
const host = { state: {}, notify() {}, navigate() {}, request: async () => null }
const queryClient = { fetchQuery: async q => q.queryFn(), getQueryData: () => null }
const usePluginI18n = noop, useQuery = noop, useValue = noop
const jsx = noop, jsxs = noop
`
const body = src
  .replace(/import \{[^}]*\} from '@hermes\/plugin-sdk'\n/, stub)
  .replace(/import \{ jsx, jsxs \} from 'react\/jsx-runtime'\n/, '')
const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tcm-'))
const file = join(dir, 'plugin.mjs')
writeFileSync(file, body)
const { __test: T } = await import(pathToFileURL(file).href)

const NOW = new Date(2026, 9, 21, 12).getTime()
const copilotPayload = rates => ({
  model: 'claude-opus-5',
  provider: 'github-copilot',
  providers: [
    { slug: 'nous', pricing: { 'claude-opus-5': { input: '$9', output: '$9', cache: '$9' } } },
    { slug: 'github-copilot', pricing: rates ? { 'claude-opus-5': rates } : {} }
  ]
})

test('readUsage: hit% present — gap split into reads + writes, input not reduced twice', () => {
  const u = T.readUsage({ input: 100, prompt: 150, cache_hit_pct: 20, output: 10 })
  assert.equal(u.input, 100)
  assert.equal(u.cacheRead, 30)
  assert.equal(u.cacheWrite, 20)
  assert.equal(u.input + u.cacheRead + u.cacheWrite, 150)
  assert.equal(u.cacheEstimated, true)
})

test('readUsage: no hit% — gap is all cache writes, exact', () => {
  const u = T.readUsage({ input: 100, prompt: 150, output: 1 })
  assert.deepEqual([u.input, u.cacheRead, u.cacheWrite, u.cacheEstimated], [100, 0, 50, false])
})

test('readUsage: raw cache fields win and are exact', () => {
  const u = T.readUsage({ input: 100, prompt: 160, cache_read: 40, cache_write: 20, cache_hit_pct: 99 })
  assert.deepEqual([u.input, u.cacheRead, u.cacheWrite, u.cacheEstimated], [100, 40, 20, false])
})

test('readUsage: input fell back to prompt — split by hit%', () => {
  const u = T.readUsage({ input: 200, prompt: 200, cache_hit_pct: 50 })
  assert.deepEqual([u.input, u.cacheRead], [100, 100])
  assert.equal(u.cacheEstimated, true)
})

test('readUsage: plain usage, junk hit%', () => {
  const u = T.readUsage({ input: 10, output: 5, cache_hit_pct: 'x' })
  assert.deepEqual([u.input, u.output, u.cacheRead, u.cacheWrite], [10, 5, 0, 0])
})

test('resolveRates: own provider wins over a foreign row with the same model', () => {
  const r = T.resolveRates({ model: 'claude-opus-5', provider: 'github-copilot', payload: copilotPayload({ input: '$5', output: '$25', cache: '$0.5' }) })
  assert.equal(r.origin, 'live')
  assert.deepEqual(r.rates, { input: 5, output: 25, cache: 0.5 })
})

test('resolveRates: empty own catalog -> bundled table of the same provider, not nous', () => {
  const r = T.resolveRates({ model: 'claude-opus-5', provider: 'github-copilot', payload: copilotPayload(null) })
  assert.equal(r.origin, 'bundled')
  assert.equal(r.rates.input, 5)
})

test('resolveRates: remembered rates are scoped by provider', () => {
  const remembered = { 'github-copilot|m': { input: 1, output: 2, cache: 0.1 } }
  assert.equal(T.resolveRates({ model: 'm', provider: 'github-copilot', remembered }).origin, 'remembered')
  assert.equal(T.resolveRates({ model: 'm', provider: 'openai', remembered }).origin, 'none')
})

test('resolveRates: unknown provider -> foreign and flagged', () => {
  const r = T.resolveRates({ model: 'claude-opus-5', provider: '', payload: null })
  assert.equal(r.origin, 'foreign')
  assert.equal(r.providerUnknown, true)
  assert.ok(r.foreignSlug)
})

test('applyUsage: deltas, settlement at record time, no-op on repeat', () => {
  const payload = copilotPayload({ input: '$5', output: '$25', cache: '$0.5' })
  let led = T.emptyLedger()
  const args = { now: NOW, payload, profile: 'p', provider: 'github-copilot', sessionId: 's1' }
  led = T.applyUsage(led, { ...args, usage: { model: 'claude-opus-5', input: 1_000_000, output: 0, calls: 1 } })
  const same = T.applyUsage(led, { ...args, usage: { model: 'claude-opus-5', input: 1_000_000, output: 0, calls: 1 } })
  assert.equal(same, led)
  led = T.applyUsage(led, { ...args, usage: { model: 'claude-opus-5', input: 1_000_000, output: 1_000_000, calls: 2 } })
  const s = T.summarize(led, () => true, null)
  assert.equal(s.rows.length, 1)
  assert.equal(s.rows[0].cost, 30)
  assert.equal(s.rows[0].calls, 2)
  assert.equal(s.rows[0].provider, 'github-copilot')

  // Catalog price change later must NOT move the settled total.
  const cheaper = copilotPayload({ input: '$1', output: '$1', cache: '$0.1' })
  const s2 = T.summarize(led, () => true, T.legacyPricer(cheaper, {}))
  assert.equal(s2.totals.cost, 30)
})

test('applyUsage: counter reset adopts the new run whole', () => {
  const payload = copilotPayload({ input: '$1', output: '$1', cache: '$1' })
  const args = { now: NOW, payload, provider: 'github-copilot', sessionId: 's' }
  let led = T.applyUsage(T.emptyLedger(), { ...args, usage: { model: 'claude-opus-5', input: 500, calls: 3 } })
  led = T.applyUsage(led, { ...args, usage: { model: 'claude-opus-5', input: 100, calls: 1 } })
  const r = T.summarize(led, () => true, null).rows[0]
  assert.equal(r.input, 600)
  assert.equal(r.calls, 4)
})

test('applyUsage: same model on two providers stays in separate buckets', () => {
  let led = T.emptyLedger()
  led = T.applyUsage(led, { now: NOW, provider: 'github-copilot', sessionId: 'a', usage: { model: 'claude-opus-5', input: 10 } })
  led = T.applyUsage(led, { now: NOW, provider: 'anthropic', sessionId: 'b', usage: { model: 'claude-opus-5', input: 10 } })
  assert.equal(T.summarize(led, () => true, null).rows.length, 2)
})

test('applyUsage: unpriced tokens tracked, not silently zero', () => {
  const led = T.applyUsage(T.emptyLedger(), { now: NOW, provider: 'x', sessionId: 's', usage: { model: 'no-such-model-zz', input: 42 } })
  const s = T.summarize(led, () => true, null)
  assert.equal(s.totals.unpricedTokens, 42)
  assert.equal(s.totals.known, false)
  assert.equal(s.rows[0].cost, null)
})

test('applyUsage: gateway cost_usd preferred and diffed', () => {
  const args = { now: NOW, provider: 'openrouter', sessionId: 's' }
  let led = T.applyUsage(T.emptyLedger(), { ...args, usage: { model: 'm', input: 10, cost_usd: 0.5 } })
  led = T.applyUsage(led, { ...args, usage: { model: 'm', input: 20, cost_usd: 0.75 } })
  const r = T.summarize(led, () => true, null).rows[0]
  assert.equal(r.cost, 0.75)
  assert.equal(r.sources.gateway, 20)
})

test('retention is by calendar date (400 days), not by count', () => {
  let led = T.emptyLedger()
  const old = new Date(2025, 0, 1).getTime()
  led = T.applyUsage(led, { now: old, provider: 'p', sessionId: 'o', usage: { model: 'm', input: 1 } })
  led = T.applyUsage(led, { now: NOW, provider: 'p', sessionId: 'n', usage: { model: 'm', input: 1 } })
  assert.deepEqual(Object.keys(led.days), [T.dayKey(NOW)])
  // 121 distinct recent days all survive (v1 capped at 120).
  let l2 = T.emptyLedger()
  for (let i = 0; i < 121; i++) {
    const at = new Date(2026, 9, 21 - i, 12).getTime()
    l2 = T.applyUsage(l2, { now: NOW, provider: 'p', sessionId: `s${i}`, usage: { model: 'm', input: 1 } })
    l2 = T.applyUsage(l2, { now: at, provider: 'p', sessionId: `t${i}`, usage: { model: 'm', input: 1 } })
  }
  assert.equal(Object.keys(l2.days).length, 121)
  assert.equal(l2.since, T.daysAgoKey(120, NOW))
})

test('v1 migration keeps tokens, marks them legacy, never fakes a settled cost', () => {
  const v1 = {
    v: 1,
    days: { '2026-10-01': { 'claude-opus-5': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 } } },
    rates: { 'claude-opus-5': { input: 5, output: 25, cache: 0.5 } },
    snapshots: { 's::claude-opus-5': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 } }
  }
  const store = { get: (k, d) => (k === 'ledger.v1' ? v1 : d) }
  const { ledger, migrated } = T.readStoredLedger(store, NOW)
  assert.equal(migrated, true)
  assert.equal(ledger.v, 2)
  const s = T.summarize(ledger, () => true, T.legacyPricer(null, ledger.legacyRates))
  assert.equal(s.rows[0].legacy, true)
  assert.equal(s.rows[0].cost, 5)
  assert.equal(s.totals.legacyTokens, 1_000_000)
  // Continuing the same session after upgrade must not double count.
  const next = T.applyUsage(ledger, { now: NOW, provider: 'github-copilot', sessionId: 's', usage: { model: 'claude-opus-5', input: 1_000_000, calls: 1 } })
  assert.equal(next, ledger)
})

test('CSV export: header, settled cost, formula injection neutralised', () => {
  let led = T.applyUsage(T.emptyLedger(), {
    now: NOW,
    payload: copilotPayload({ input: '$5', output: '$25', cache: '$0.5' }),
    profile: '=HYPERLINK("x")',
    provider: 'github-copilot',
    sessionId: 's',
    usage: { model: 'claude-opus-5', input: 1_000_000, calls: 1 }
  })
  const csv = T.ledgerCsv(led).trim().split('\r\n')
  assert.equal(csv.length, 2)
  assert.ok(csv[0].startsWith('date,profile,provider,model'))
  assert.ok(csv[1].includes(`"'=HYPERLINK(""x"")"`))
  assert.ok(csv[1].includes(',5,live,'))
  assert.equal(T.csvCell(-3), '-3')
})

test('daysAgoKey is DST-safe local calendar math', () => {
  assert.equal(T.daysAgoKey(1, new Date(2026, 2, 9, 0, 30).getTime()), '2026-03-08')
  assert.equal(T.daysAgoKey(0, NOW), T.dayKey(NOW))
})
