/**
 * token-cost-meter — live token usage + model-aware USD cost, with a
 * persistent local ledger that survives restarting Hermes.
 *
 * Live  : host.state.focusedUsage (streamed UsageStats, no RPC)
 * Prices: host.request('model.options', { session_id }) — scoped to the
 *         session whose usage is being priced, so a split tile never borrows
 *         another tile's provider. pricing[model] = {input,output,cache} as
 *         "$/Mtok" strings ("free", "" = unknown).
 * Ledger: ctx.storage (namespaced, app-level — shared by every profile). The
 *         gateway's in-memory counters reset on restart, so usage is folded
 *         into per-day buckets keyed by profile + provider + model, and the
 *         cost of every delta is SETTLED at the moment it is recorded, with
 *         the rate source that priced it. Re-pricing history at read time
 *         would make yesterday's total move whenever a catalog changes.
 */

import {
  atom,
  Badge,
  Button,
  cn,
  Codicon,
  host,
  queryClient,
  SegmentedControl,
  Tip,
  usePluginI18n,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'token-cost-meter'
const LEDGER_KEY = 'ledger.v2'
/** Pre-1.0 ledger. Migrated on first load and left untouched as a backup. */
const LEGACY_LEDGER_KEY = 'ledger.v1'
const LEDGER_VERSION = 2
/** Calendar days of per-day totals kept (by date, not by count). */
const KEEP_DAYS = 400
/** Per-session counter snapshots older than this are dropped. */
const SNAPSHOT_TTL_MS = 30 * 86_400_000
const MAX_SNAPSHOTS = 2000
/** Per-conversation totals kept for the side pane (newest by lastAt win). */
const MAX_SESSIONS = 1000
const CATALOG_STALE_MS = 10 * 60 * 1000
const M = 1_000_000
const LEDGER_ROUTE = '/token-cost'

/* ------------------------------------------------------------------ utils */

/** "$3.00" | "3.00" | "free" | "" | "?" -> number ($ per 1M tokens) or null */
function parseRate(text) {
  if (text == null) return null
  const s = String(text).trim()
  if (!s || s === '?') return null
  if (s.toLowerCase() === 'free') return 0
  const n = Number.parseFloat(s.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) && n >= 0 ? n : null
}

function fmtTokens(n) {
  const v = Number(n) || 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  return String(v)
}

function fmtUsd(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v === 0) return '$0.00'
  if (v < 0.01) return `$${v.toFixed(4)}`
  if (v < 1) return `$${v.toFixed(3)}`
  return `$${v.toFixed(2)}`
}

/** Local calendar day, not UTC — "today" must mean the user's today. */
function dayKey(ts) {
  const d = ts != null ? new Date(ts) : new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The local day `n` calendar days before `now` (DST-safe: no 86.4M ms math). */
function daysAgoKey(n, now) {
  const d = now != null ? new Date(now) : new Date()
  d.setDate(d.getDate() - n)
  return dayKey(d.getTime())
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function tokensOf(b) {
  return num(b.input) + num(b.output) + num(b.cacheRead) + num(b.cacheWrite)
}

function validRates(r) {
  return !!r && ['input', 'output', 'cache'].every(k => typeof r[k] === 'number' && Number.isFinite(r[k]) && r[k] >= 0)
}

/* ---------------------------------------------------------------- pricing */

/**
 * Bundled fallback rates, generated from the models.dev catalog by
 * scripts/gen-rates.py (the desktop plugin loader forbids relative imports,
 * so the table is inlined).
 *
 * WHY this exists: Hermes only fetches LIVE pricing for openrouter / nous /
 * ai-gateway / novita / deepinfra / fireworks / kilocode
 * (hermes_cli/models_pricing.py::_PRICING_FETCHERS). Every other provider —
 * notably subscription/OAuth routes like github-copilot — gets `pricing: {}`
 * in `model.options`.
 *
 * Shape: { providerId: { modelIdLowercase: [inUsdPerMtok, outUsdPerMtok, cacheReadUsdPerMtok?] } }
 */
const FALLBACK_RATES = /* @generated */ {"alibaba":{"deepseek-v4-flash-0731":[0.2,0.4,0.04],"glm-5.2":[1.4,4.4,0.28],"kimi-k3":[3.0,15.0,0.3],"qvq-max":[1.2,4.8,1.2],"qwen-flash":[0.05,0.4,0.05],"qwen-max":[1.6,6.4,1.6],"qwen-mt-plus":[2.46,7.37,2.46],"qwen-mt-turbo":[0.16,0.49,0.16],"qwen-omni-turbo":[0.07,0.27,0.07],"qwen-omni-turbo-realtime":[0.27,1.07,0.27],"qwen-plus":[0.4,1.2,0.4],"qwen-plus-character-ja":[0.5,1.4,0.5],"qwen-turbo":[0.05,0.2,0.05],"qwen-vl-max":[0.8,3.2,0.8],"qwen-vl-ocr":[0.07,0.16,0.07],"qwen-vl-plus":[0.21,0.63,0.21],"qwen2-5-14b-instruct":[0.35,1.4,0.35],"qwen2-5-32b-instruct":[0.7,2.8,0.7],"qwen2-5-72b-instruct":[1.4,5.6,1.4],"qwen2-5-7b-instruct":[0.175,0.7,0.175],"qwen2-5-omni-7b":[0.1,0.4,0.1],"qwen2-5-vl-72b-instruct":[2.8,8.4,2.8],"qwen2-5-vl-7b-instruct":[0.35,1.05,0.35],"qwen3-14b":[0.35,1.4,0.35],"qwen3-235b-a22b":[0.7,2.8,0.7],"qwen3-32b":[0.7,2.8,0.7],"qwen3-8b":[0.18,0.7,0.18],"qwen3-asr-flash":[0.035,0.035,0.035],"qwen3-coder-30b-a3b-instruct":[0.45,2.25,0.45],"qwen3-coder-480b-a35b-instruct":[1.5,7.5,1.5],"qwen3-coder-flash":[0.3,1.5,0.3],"qwen3-coder-plus":[1.0,5.0,1.0],"qwen3-livetranslate-flash-realtime":[10.0,10.0,10.0],"qwen3-max":[1.2,6.0,1.2],"qwen3-next-80b-a3b-instruct":[0.5,2.0,0.5],"qwen3-next-80b-a3b-thinking":[0.5,6.0,0.5],"qwen3-omni-flash":[0.43,1.66,0.43],"qwen3-omni-flash-realtime":[0.52,1.99,0.52],"qwen3-vl-235b-a22b":[0.7,2.8,0.7],"qwen3-vl-30b-a3b":[0.2,0.8,0.2],"qwen3-vl-plus":[0.2,1.6,0.2],"qwen3.5-122b-a10b":[0.4,3.2,0.4],"qwen3.5-27b":[0.3,2.4,0.3],"qwen3.5-35b-a3b":[0.25,2.0,0.25],"qwen3.5-397b-a17b":[0.6,3.6,0.6],"qwen3.5-flash":[0.1,0.4,0.01],"qwen3.5-plus":[0.4,2.4,0.4],"qwen3.6-27b":[0.6,3.6,0.6],"qwen3.6-35b-a3b":[0.248,1.485,0.248],"qwen3.6-flash":[0.1875,1.125,0.1875],"qwen3.6-max-preview":[1.3,7.8,0.13],"qwen3.6-plus":[0.5,3.0,0.05],"qwen3.7-flash":[0.03,0.13,0.003],"qwen3.7-max":[2.5,7.5,0.5],"qwen3.7-plus":[0.4,1.6,0.04],"qwen3.8-flash":[0.15,0.47,0.016],"qwen3.8-max":[2.0,6.0,0.25],"qwen3.8-omni-flash":[0.15,0.47,0.016],"qwq-plus":[0.8,2.4,0.8]},"amazon-bedrock":{"amazon.nova-2-lite-v1:0":[0.33,2.75,0.0825],"amazon.nova-lite-v1:0":[0.06,0.24,0.015],"amazon.nova-micro-v1:0":[0.035,0.14,0.00875],"amazon.nova-pro-v1:0":[0.8,3.2,0.2],"anthropic.claude-fable-5":[10.0,50.0,1.0],"anthropic.claude-fable-5-1":[10.0,50.0,0.25],"anthropic.claude-haiku-4-5-20251001-v1:0":[1.0,5.0,0.1],"anthropic.claude-haiku-5-5":[0.1,0.5,0.01],"anthropic.claude-opus-4-1-20250805-v1:0":[15.0,75.0,1.5],"anthropic.claude-opus-4-5-20251101-v1:0":[5.0,25.0,0.5],"anthropic.claude-opus-4-6-v1":[5.5,27.5,0.55],"anthropic.claude-opus-4-7":[5.0,25.0,0.5],"anthropic.claude-opus-4-8":[5.0,25.0,0.5],"anthropic.claude-opus-5":[5.0,25.0,0.5],"anthropic.claude-opus-5-5":[4.0,20.0,0.2],"anthropic.claude-sonnet-4-5-20250929-v1:0":[3.0,15.0,0.3],"anthropic.claude-sonnet-4-6":[3.3,16.5,0.33],"anthropic.claude-sonnet-5":[2.0,10.0,0.2],"anthropic.claude-sonnet-5-5":[2.0,10.0,0.1],"apac.amazon.nova-lite-v1:0":[0.063,0.252,0.01575],"apac.amazon.nova-micro-v1:0":[0.037,0.148,0.00925],"apac.amazon.nova-pro-v1:0":[0.84,3.36,0.21],"apac.anthropic.claude-sonnet-4-20250514-v1:0":[3.0,15.0,0.3],"au.anthropic.claude-haiku-4-5-20251001-v1:0":[1.1,5.5,0.11],"au.anthropic.claude-haiku-5-5":[0.11,0.55,0.011],"au.anthropic.claude-opus-4-6-v1":[5.5,27.5,0.55],"au.anthropic.claude-opus-4-7":[5.5,27.5,0.55],"au.anthropic.claude-opus-4-8":[5.5,27.5,0.55],"au.anthropic.claude-opus-5":[5.5,27.5,0.55],"au.anthropic.claude-opus-5-5":[4.4,22.0,0.22],"au.anthropic.claude-sonnet-4-5-20250929-v1:0":[3.3,16.5,0.33],"au.anthropic.claude-sonnet-4-6":[3.3,16.5,0.33],"au.anthropic.claude-sonnet-5":[2.2,11.0,0.22],"ca.amazon.nova-lite-v1:0":[0.064,0.256,0.016],"deepseek.r1-v1:0":[1.35,5.4,1.35],"deepseek.v3-v1:0":[0.58,1.68,0.58],"deepseek.v3.2":[0.62,1.85,0.62],"eu.amazon.nova-2-lite-v1:0":[0.374,3.157,0.0935],"eu.amazon.nova-lite-v1:0":[0.069,0.276,0.01725],"eu.amazon.nova-micro-v1:0":[0.04,0.16,0.01],"eu.amazon.nova-pro-v1:0":[0.92,3.68,0.23],"eu.anthropic.claude-fable-5":[11.0,55.0,1.1],"eu.anthropic.claude-haiku-4-5-20251001-v1:0":[1.1,5.5,0.11],"eu.anthropic.claude-haiku-5-5":[0.11,0.55,0.011],"eu.anthropic.claude-opus-4-5-20251101-v1:0":[5.5,27.5,0.55],"eu.anthropic.claude-opus-4-6-v1":[5.5,27.5,0.55],"eu.anthropic.claude-opus-4-7":[5.5,27.5,0.55],"eu.anthropic.claude-opus-4-8":[5.5,27.5,0.55],"eu.anthropic.claude-opus-5":[5.5,27.5,0.55],"eu.anthropic.claude-opus-5-5":[4.4,22.0,0.22],"eu.anthropic.claude-sonnet-4-20250514-v1:0":[3.0,15.0,0.3],"eu.anthropic.claude-sonnet-4-5-20250929-v1:0":[3.3,16.5,0.33],"eu.anthropic.claude-sonnet-4-6":[3.3,16.5,0.33],"eu.anthropic.claude-sonnet-5":[2.2,11.0,0.22],"eu.anthropic.claude-sonnet-5-5":[2.2,11.0,0.11],"eu.mistral.pixtral-large-2502-v1:0":[2.0,6.0,2.0],"global.amazon.nova-2-lite-v1:0":[0.3,2.5,0.075],"global.anthropic.claude-fable-5":[10.0,50.0,1.0],"global.anthropic.claude-fable-5-1":[10.0,50.0,0.25],"global.anthropic.claude-haiku-4-5-20251001-v1:0":[1.0,5.0,0.1],"global.anthropic.claude-haiku-5-5":[0.1,0.5,0.01],"global.anthropic.claude-opus-4-5-20251101-v1:0":[5.0,25.0,0.5],"global.anthropic.claude-opus-4-6-v1":[5.0,25.0,0.5],"global.anthropic.claude-opus-4-7":[5.0,25.0,0.5],"global.anthropic.claude-opus-4-8":[5.0,25.0,0.5],"global.anthropic.claude-opus-5":[5.0,25.0,0.5],"global.anthropic.claude-opus-5-5":[4.0,20.0,0.2],"global.anthropic.claude-sonnet-4-20250514-v1:0":[3.0,15.0,0.3],"global.anthropic.claude-sonnet-4-5-20250929-v1:0":[3.0,15.0,0.3],"global.anthropic.claude-sonnet-4-6":[3.0,15.0,0.3],"global.anthropic.claude-sonnet-5":[2.0,10.0,0.2],"global.anthropic.claude-sonnet-5-5":[2.0,10.0,0.1],"global.moonshotai.kimi-k3":[3.0,15.0,0.3],"global.openai.gpt-5.6-luna":[0.2,1.2,0.02],"global.openai.gpt-5.6-sol":[4.0,20.0,0.4],"global.openai.gpt-5.6-terra":[2.0,12.0,0.2],"global.openai.gpt-6-astra":[10.0,50.0,1.0],"global.openai.gpt-6-luna":[0.1,0.5,0.01],"global.openai.gpt-6-sol":[2.0,10.0,0.2],"global.openai.gpt-6.1-sol":[2.0,10.0,0.1],"global.xai.grok-4.6":[2.0,6.0,0.5],"global.xai.grok-4.7":[2.0,6.0,0.5],"global.zai.glm-5.3":[1.68,5.28,0.312],"google.gemma-3-12b-it":[0.09,0.29,0.09],"google.gemma-3-27b-it":[0.23,0.38,0.23],"google.gemma-3-4b-it":[0.04,0.08,0.04],"google.gemma-4-26b-a4b":[0.13,0.4,0.13],"google.gemma-4-31b":[0.14,0.4,0.14],"google.gemma-4-e2b":[0.04,0.08,0.04],"in.anthropic.claude-haiku-4-5-20251001-v1:0":[1.1,5.5,0.11],"in.anthropic.claude-opus-5":[5.5,27.5,0.55],"in.anthropic.claude-sonnet-5":[2.2,11.0,0.22],"in.openai.gpt-5.6-luna":[0.22,1.32,0.022],"in.openai.gpt-5.6-terra":[2.2,13.2,0.22],"jp.amazon.nova-2-lite-v1:0":[0.396,3.311,0.099],"jp.anthropic.claude-haiku-4-5-20251001-v1:0":[1.1,5.5,0.11],"jp.anthropic.claude-haiku-5-5":[0.11,0.55,0.011],"jp.anthropic.claude-opus-4-7":[5.5,27.5,0.55],"jp.anthropic.claude-opus-4-8":[5.5,27.5,0.55],"jp.anthropic.claude-opus-5":[5.5,27.5,0.55],"jp.anthropic.claude-opus-5-5":[4.4,22.0,0.22],"jp.anthropic.claude-sonnet-4-5-20250929-v1:0":[3.3,16.5,0.33],"jp.anthropic.claude-sonnet-4-6":[3.3,16.5,0.33],"jp.anthropic.claude-sonnet-5":[2.2,11.0,0.22],"meta.llama3-1-70b-instruct-v1:0":[0.72,0.72,0.72],"meta.llama3-1-8b-instruct-v1:0":[0.22,0.22,0.22],"meta.llama3-3-70b-instruct-v1:0":[0.72,0.72,0.72],"meta.llama4-maverick-17b-instruct-v1:0":[0.24,0.97,0.24],"meta.llama4-scout-17b-instruct-v1:0":[0.17,0.66,0.17],"minimax.minimax-m2":[0.3,1.2,0.3],"minimax.minimax-m2.1":[0.3,1.2,0.3],"minimax.minimax-m2.5":[0.3,1.2,0.3],"mistral.devstral-2-123b":[0.4,2.0,0.4],"mistral.magistral-small-2509":[0.5,1.5,0.5],"mistral.ministral-3-14b-instruct":[0.2,0.2,0.2],"mistral.ministral-3-3b-instruct":[0.1,0.1,0.1],"mistral.ministral-3-8b-instruct":[0.15,0.15,0.15],"mistral.mistral-large-3-675b-instruct":[0.5,1.5,0.5],"mistral.pixtral-large-2502-v1:0":[2.0,6.0,2.0],"mistral.voxtral-mini-3b-2507":[0.04,0.04,0.04],"mistral.voxtral-small-24b-2507":[0.1,0.3,0.1],"moonshot.kimi-k2-thinking":[0.6,2.5,0.6],"moonshotai.kimi-k2.5":[0.6,3.0,0.6],"nvidia.nemotron-nano-12b-v2":[0.2,0.6,0.2],"nvidia.nemotron-nano-3-30b":[0.06,0.24,0.06],"nvidia.nemotron-nano-9b-v2":[0.06,0.23,0.06],"nvidia.nemotron-super-3-120b":[0.15,0.65,0.15],"openai.gpt-5.4":[2.75,16.5,0.275],"openai.gpt-5.5":[5.5,33.0,0.55],"openai.gpt-5.6-luna":[0.22,1.32,0.022],"openai.gpt-5.6-sol":[4.4,22.0,0.44],"openai.gpt-5.6-terra":[2.2,13.2,0.22],"openai.gpt-6-astra":[11.0,55.0,1.1],"openai.gpt-6-luna":[0.11,0.55,0.011],"openai.gpt-6-sol":[2.2,11.0,0.22],"openai.gpt-6.1-sol":[2.2,11.0,0.11],"openai.gpt-oss-120b":[0.15,0.6,0.15],"openai.gpt-oss-120b-1:0":[0.15,0.6,0.15],"openai.gpt-oss-20b":[0.07,0.3,0.07],"openai.gpt-oss-20b-1:0":[0.07,0.3,0.07],"openai.gpt-oss-safeguard-120b":[0.15,0.6,0.15],"openai.gpt-oss-safeguard-20b":[0.07,0.2,0.07],"qwen.qwen3-235b-a22b-2507-v1:0":[0.22,0.88,0.22],"qwen.qwen3-32b-v1:0":[0.15,0.6,0.15],"qwen.qwen3-coder-30b-a3b-v1:0":[0.15,0.6,0.15],"qwen.qwen3-coder-480b-a35b-v1:0":[0.45,1.8,0.45],"qwen.qwen3-coder-next":[0.5,1.2,0.5],"qwen.qwen3-next-80b-a3b":[0.15,1.2,0.15],"qwen.qwen3-vl-235b-a22b":[0.53,2.66,0.53],"us-gov.openai.gpt-oss-120b-1:0":[0.18,0.72,0.18],"us-gov.openai.gpt-oss-20b-1:0":[0.084,0.36,0.084],"us.amazon.nova-2-lite-v1:0":[0.33,2.75,0.0825],"us.amazon.nova-lite-v1:0":[0.06,0.24,0.015],"us.amazon.nova-micro-v1:0":[0.035,0.14,0.00875],"us.amazon.nova-premier-v1:0":[2.5,12.5,0.625],"us.amazon.nova-pro-v1:0":[0.8,3.2,0.2],"us.anthropic.claude-fable-5":[11.0,55.0,1.1],"us.anthropic.claude-fable-5-1":[11.0,55.0,0.275],"us.anthropic.claude-haiku-4-5-20251001-v1:0":[1.1,5.5,0.11],"us.anthropic.claude-haiku-5-5":[0.11,0.55,0.011],"us.anthropic.claude-opus-4-1-20250805-v1:0":[15.0,75.0,1.5],"us.anthropic.claude-opus-4-5-20251101-v1:0":[5.5,27.5,0.55],"us.anthropic.claude-opus-4-6-v1":[5.5,27.5,0.55],"us.anthropic.claude-opus-4-7":[5.5,27.5,0.55],"us.anthropic.claude-opus-4-8":[5.5,27.5,0.55],"us.anthropic.claude-opus-5":[5.5,27.5,0.55],"us.anthropic.claude-opus-5-5":[4.4,22.0,0.22],"us.anthropic.claude-sonnet-4-20250514-v1:0":[3.0,15.0,0.3],"us.anthropic.claude-sonnet-4-5-20250929-v1:0":[3.3,16.5,0.33],"us.anthropic.claude-sonnet-4-6":[3.3,16.5,0.33],"us.anthropic.claude-sonnet-5":[2.2,11.0,0.22],"us.anthropic.claude-sonnet-5-5":[2.2,11.0,0.11],"us.deepseek.r1-v1:0":[1.35,5.4,1.35],"us.meta.llama3-1-70b-instruct-v1:0":[0.72,0.72,0.72],"us.meta.llama3-1-8b-instruct-v1:0":[0.22,0.22,0.22],"us.meta.llama3-3-70b-instruct-v1:0":[0.72,0.72,0.72],"us.meta.llama4-maverick-17b-instruct-v1:0":[0.24,0.97,0.24],"us.meta.llama4-scout-17b-instruct-v1:0":[0.17,0.66,0.17],"us.mistral.pixtral-large-2502-v1:0":[2.0,6.0,2.0],"us.moonshotai.kimi-k3":[3.3,16.5,0.33],"us.openai.gpt-5.6-luna":[0.22,1.32,0.022],"us.openai.gpt-5.6-sol":[4.4,22.0,0.44],"us.openai.gpt-5.6-terra":[2.2,13.2,0.22],"us.openai.gpt-6-astra":[11.0,55.0,1.1],"us.openai.gpt-6-luna":[0.11,0.55,0.011],"us.openai.gpt-6-sol":[2.2,11.0,0.22],"us.openai.gpt-6.1-sol":[2.2,11.0,0.11],"us.writer.palmyra-x4-v1:0":[2.5,10.0,2.5],"us.writer.palmyra-x5-v1:0":[0.6,6.0,0.6],"us.xai.grok-4.6":[2.2,6.6,0.55],"us.xai.grok-4.7":[2.2,6.6,0.55],"us.zai.glm-5.3":[1.848,5.808,0.3432],"writer.palmyra-x4-v1:0":[2.5,10.0,2.5],"writer.palmyra-x5-v1:0":[0.6,6.0,0.6],"xai.grok-4.3":[1.25,2.5,0.2],"xai.grok-4.6":[2.2,6.6,0.55],"zai.glm-4.7":[0.6,2.2,0.6],"zai.glm-4.7-flash":[0.07,0.4,0.07],"zai.glm-5":[1.0,3.2,1.0]},"anthropic":{"claude-fable-5":[10.0,50.0,1.0],"claude-fable-5-1":[10.0,50.0,0.25],"claude-haiku-4-5":[1.0,5.0,0.1],"claude-haiku-4-5-20251001":[1.0,5.0,0.1],"claude-haiku-5-5":[0.1,0.5,0.01],"claude-opus-4-5":[5.0,25.0,0.5],"claude-opus-4-5-20251101":[5.0,25.0,0.5],"claude-opus-4-6":[5.0,25.0,0.5],"claude-opus-4-7":[5.0,25.0,0.5],"claude-opus-4-8":[5.0,25.0,0.5],"claude-opus-5":[5.0,25.0,0.5],"claude-opus-5-5":[4.0,20.0,0.2],"claude-sonnet-4-5":[3.0,15.0,0.3],"claude-sonnet-4-5-20250929":[3.0,15.0,0.3],"claude-sonnet-4-6":[3.0,15.0,0.3],"claude-sonnet-5":[2.0,10.0,0.2],"claude-sonnet-5-5":[2.0,10.0,0.1]},"azure":{"claude-fable-5":[10.0,50.0,1.0],"claude-fable-5-1":[10.0,50.0,0.25],"claude-haiku-4-5":[1.0,5.0,0.1],"claude-haiku-5-5":[0.1,0.5,0.01],"claude-mythos-5":[10.0,50.0,1.0],"claude-opus-4-1":[15.0,75.0,1.5],"claude-opus-4-5":[5.0,25.0,0.5],"claude-opus-4-6":[5.0,25.0,0.5],"claude-opus-4-7":[5.0,25.0,0.5],"claude-opus-4-8":[5.0,25.0,0.5],"claude-opus-5":[5.0,25.0,0.5],"claude-opus-5-5":[4.0,20.0,0.2],"claude-sonnet-4-5":[3.0,15.0,0.3],"claude-sonnet-4-6":[3.0,15.0,0.3],"claude-sonnet-5":[2.0,10.0,0.2],"claude-sonnet-5-5":[2.0,10.0,0.2],"codestral-2501":[0.3,0.9,0.3],"codex-mini":[1.5,6.0,0.375],"cohere-command-a":[2.5,10.0,2.5],"cohere-embed-v-4-0":[0.12,0.0,0.12],"cohere-embed-v3-english":[0.1,0.0,0.1],"cohere-embed-v3-multilingual":[0.1,0.0,0.1],"deepseek-r1":[1.35,5.4,1.35],"deepseek-v3.2":[0.58,1.68,0.58],"deepseek-v3.2-speciale":[0.58,1.68,0.58],"deepseek-v4-flash":[0.19,0.51,0.19],"deepseek-v4-pro":[1.74,3.48,1.74],"gpt-3.5-turbo-0125":[0.5,1.5,0.5],"gpt-3.5-turbo-1106":[1.0,2.0,1.0],"gpt-3.5-turbo-instruct":[1.5,2.0,1.5],"gpt-4-turbo":[10.0,30.0,10.0],"gpt-4-turbo-vision":[10.0,30.0,10.0],"gpt-4.1":[2.0,8.0,0.5],"gpt-4.1-mini":[0.4,1.6,0.1],"gpt-4.1-nano":[0.1,0.4,0.025],"gpt-4o":[2.5,10.0,1.25],"gpt-4o-mini":[0.15,0.6,0.075],"gpt-5":[1.25,10.0,0.13],"gpt-5-codex":[1.25,10.0,0.13],"gpt-5-mini":[0.25,2.0,0.03],"gpt-5-nano":[0.05,0.4,0.01],"gpt-5-pro":[15.0,120.0,15.0],"gpt-5.1":[1.25,10.0,0.125],"gpt-5.1-codex":[1.25,10.0,0.125],"gpt-5.1-codex-max":[1.25,10.0,0.125],"gpt-5.1-codex-mini":[0.25,2.0,0.025],"gpt-5.2":[1.75,14.0,0.125],"gpt-5.2-codex":[1.75,14.0,0.175],"gpt-5.3-codex":[1.75,14.0,0.175],"gpt-5.4":[2.5,15.0,0.25],"gpt-5.4-mini":[0.75,4.5,0.075],"gpt-5.4-nano":[0.2,1.25,0.02],"gpt-5.4-pro":[30.0,180.0,30.0],"gpt-5.5":[5.0,30.0,0.5],"gpt-5.6-luna":[0.2,1.2,0.02],"gpt-5.6-sol":[4.0,20.0,0.5],"gpt-5.6-terra":[2.0,12.0,0.2],"gpt-6-astra":[10.0,50.0,1.0],"gpt-6-luna":[0.1,0.5,0.01],"gpt-6-sol":[2.0,10.0,0.2],"gpt-6.1-sol":[2.0,10.0,0.1],"gpt-chat-latest":[5.0,30.0,0.5],"gpt-image-1":[5.0,40.0,1.25],"gpt-image-1.5":[5.0,32.0,1.25],"gpt-image-2":[5.0,30.0,1.25],"gpt-image-2.5-flare":[5.0,30.0,1.25],"gpt-image-2.5-sunburst":[5.0,30.0,1.25],"grok-4-1-fast-non-reasoning":[0.2,0.5,0.05],"grok-4-1-fast-reasoning":[0.2,0.5,0.05],"grok-4-20-non-reasoning":[2.0,6.0,2.0],"grok-4-20-reasoning":[2.0,6.0,2.0],"grok-4.6":[2.0,6.0,0.5],"kimi-k2.5":[0.6,3.0,0.6],"kimi-k2.6":[0.95,4.0,0.95],"kimi-k2.7-code":[0.95,4.0,0.19],"llama-3.3-70b-instruct":[0.71,0.71,0.71],"llama-4-maverick-17b-128e-instruct-fp8":[0.25,1.0,0.25],"llama-4-scout-17b-16e-instruct":[0.2,0.78,0.2],"ministral-3b":[0.04,0.04,0.04],"mistral-medium-2505":[0.4,2.0,0.4],"mistral-small-2503":[0.1,0.3,0.1],"model-router":[0.14,0.0,0.14],"o1":[15.0,60.0,7.5],"o3":[2.0,8.0,0.5],"o3-mini":[1.1,4.4,0.55],"o4-mini":[1.1,4.4,0.275],"phi-4":[0.125,0.5,0.125],"phi-4-mini":[0.075,0.3,0.075],"phi-4-mini-reasoning":[0.075,0.3,0.075],"phi-4-multimodal":[0.08,0.32,0.08],"phi-4-reasoning":[0.125,0.5,0.125],"phi-4-reasoning-plus":[0.125,0.5,0.125],"text-embedding-3-large":[0.13,0.0,0.13],"text-embedding-3-small":[0.02,0.0,0.02],"text-embedding-ada-002":[0.1,0.0,0.1]},"cerebras":{"gpt-oss-120b":[0.35,0.75,0.35],"qwen-3.8-27b":[0.99,1.49,0.99]},"deepinfra":{"bytedance/seed-2.0-code":[0.5,3.0,0.1],"bytedance/seed-2.0-mini":[0.1,0.4,0.02],"bytedance/seed-2.0-pro":[0.5,3.0,0.1],"deepseek-ai/deepseek-r1-0528":[0.5,2.15,0.35],"deepseek-ai/deepseek-v3":[0.32,0.89,0.32],"deepseek-ai/deepseek-v3-0324":[0.24,0.9,0.135],"deepseek-ai/deepseek-v3.1":[0.25,0.95,0.13],"deepseek-ai/deepseek-v3.2":[0.26,0.38,0.13],"deepseek-ai/deepseek-v4-flash":[0.09,0.18,0.018],"deepseek-ai/deepseek-v4-flash-0731":[0.06,0.18,0.015],"deepseek-ai/deepseek-v4-flash-vision-exp":[0.44,1.32,0.014],"deepseek-ai/deepseek-v4-pro":[1.3,2.6,0.1],"deepseek-ai/deepseek-v4-pro-0813":[1.3,2.6,0.1],"deepseek-ai/deepseek-v4.1-flash":[0.2,0.6,0.006],"google/gemma-3-12b-it":[0.05,0.15,0.05],"google/gemma-3-27b-it":[0.08,0.16,0.08],"google/gemma-3-4b-it":[0.05,0.1,0.05],"google/gemma-4-26b-a4b-it":[0.07,0.34,0.07],"google/gemma-4-31b-it":[0.2,0.4,0.2],"google/gemma-4-e4b-it":[0.02,0.1,0.02],"meta-llama/llama-3.3-70b-instruct-turbo":[0.1,0.32,0.1],"meta-llama/llama-4-maverick-17b-128e-instruct-fp8":[0.2,0.8,0.2],"meta-llama/llama-4-scout-17b-16e-instruct":[0.1,0.3,0.1],"minimaxai/minimax-m2.5":[0.15,1.15,0.03],"minimaxai/minimax-m2.7":[0.25,1.0,0.05],"minimaxai/minimax-m3":[0.28,1.1,0.056],"moonshotai/kimi-k2.5":[0.45,2.25,0.07],"moonshotai/kimi-k2.6":[0.75,3.5,0.15],"moonshotai/kimi-k2.7-code":[0.68,3.4,0.136],"moonshotai/kimi-k3":[2.85,14.25,0.285],"nvidia/llama-3.3-nemotron-super-49b-v1.5":[0.4,0.4,0.4],"nvidia/nemotron-3-nano-30b-a3b":[0.05,0.2,0.025],"nvidia/nemotron-3-nano-omni-30b-a3b-reasoning":[0.2,0.8,0.2],"openai/gpt-oss-120b":[0.037,0.17,0.037],"openai/gpt-oss-20b":[0.03,0.14,0.03],"qwen/qwen3-235b-a22b-instruct-2507":[0.09,0.55,0.09],"qwen/qwen3-30b-a3b":[0.12,0.5,0.12],"qwen/qwen3-32b":[0.08,0.28,0.08],"qwen/qwen3-coder-480b-a35b-instruct-turbo":[0.3,1.0,0.1],"qwen/qwen3-max":[1.2,6.0,0.24],"qwen/qwen3-next-80b-a3b-instruct":[0.09,1.1,0.09],"qwen/qwen3-vl-235b-a22b-instruct":[0.2,0.88,0.11],"qwen/qwen3-vl-30b-a3b-instruct":[0.15,0.6,0.15],"qwen/qwen3.5-122b-a10b":[0.29,2.4,0.29],"qwen/qwen3.5-27b":[0.26,2.6,0.26],"qwen/qwen3.5-35b-a3b":[0.14,1.0,0.05],"qwen/qwen3.5-397b-a17b":[0.45,3.0,0.22],"qwen/qwen3.5-9b":[0.1,0.15,0.1],"qwen/qwen3.6-27b":[0.32,3.2,0.32],"qwen/qwen3.6-35b-a3b":[0.1,0.95,0.1],"qwen/qwen3.7-max":[2.5,7.5,0.5],"qwen/qwen3.8-2.4t-a95b":[2.0,6.0,0.2],"qwen/qwen3.8-27b":[0.2,2.5,0.05],"qwen/qwen3.8-flash":[0.113,0.382,0.0141],"qwen/qwen3.8-max":[1.65,4.951,0.206],"stepfun-ai/step-3.7-flash":[0.2,1.15,0.04],"tencent/hy3":[0.13,0.53,0.033],"tencent/hy4-preview":[0.834,2.501,0.042],"thinkingmachines/inkling":[0.95,4.05,0.16],"thinkingmachines/inkling-small":[0.45,1.2,0.1],"xiaomimimo/mimo-v2.5":[0.14,0.28,0.0028],"xiaomimimo/mimo-v2.5-pro":[1.0,3.0,0.2],"xiaomimimo/mimo-v2.6-flash":[0.14,0.28,0.0028],"xiaomimimo/mimo-v2.6-pro":[0.43,0.87,0.0036],"zai-org/glm-4.6":[0.5,2.0,0.1],"zai-org/glm-4.7":[0.4,1.75,0.08],"zai-org/glm-4.7-flash":[0.06,0.4,0.01],"zai-org/glm-5":[0.6,2.08,0.12],"zai-org/glm-5.1":[1.05,3.5,0.205],"zai-org/glm-5.2":[0.75,2.4,0.14],"zai-org/glm-5.3":[0.9,4.0,0.2],"zai-org/glm-5.3-flash":[0.15,0.5,0.03]},"deepseek":{"deepseek-flash":[0.15,0.6,0.003],"deepseek-v4-flash":[0.15,0.6,0.003],"deepseek-v4-flash-vision-exp":[0.15,0.6,0.003],"deepseek-v4-pro":[0.66,1.98,0.022]},"fireworks-ai":{"accounts/fireworks/models/deepseek-v4p1-flash":[0.3,1.2,0.006],"accounts/fireworks/models/ember-1":[3.0,15.0,0.3],"accounts/fireworks/models/glm-5p3":[1.4,4.4,0.26],"accounts/fireworks/models/glm-5p3-flash":[0.15,0.5,0.03],"accounts/fireworks/models/gpt-oss-120b":[0.15,0.6,0.015],"accounts/fireworks/models/inkling":[1.0,4.05,0.17],"accounts/fireworks/models/kimi-k3":[3.0,15.0,0.3],"accounts/fireworks/models/minimax-m3":[0.3,1.2,0.06],"accounts/fireworks/models/nemotron-3-ultra-nvfp4":[0.6,2.4,0.12],"accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b":[0.05,0.2,0.01],"accounts/fireworks/models/qwen3p8-2p4t-a95b":[2.0,6.0,0.25],"accounts/fireworks/models/qwen3p8-max":[2.0,6.0,0.25],"accounts/fireworks/routers/deepseek-flash-latest":[0.3,1.2,0.006],"accounts/fireworks/routers/glm-5p3-fast":[2.1,6.6,0.39],"accounts/fireworks/routers/glm-fast-latest":[2.1,6.6,0.39],"accounts/fireworks/routers/glm-flash-latest":[0.15,0.5,0.03],"accounts/fireworks/routers/glm-latest":[1.4,4.4,0.26],"accounts/fireworks/routers/kimi-fast-latest":[4.5,22.5,0.45],"accounts/fireworks/routers/kimi-k3-fast":[4.5,22.5,0.45],"accounts/fireworks/routers/kimi-latest":[3.0,15.0,0.3],"accounts/fireworks/routers/minimax-latest":[0.3,1.2,0.06],"accounts/fireworks/routers/qwen-max-latest":[2.0,6.0,0.25]},"github-copilot":{"claude-fable-5":[10.0,50.0,1.0],"claude-fable-5.1":[10.0,50.0,0.25],"claude-haiku-4.5":[1.0,5.0,0.1],"claude-haiku-5.5":[0.1,0.5,0.01],"claude-opus-4.7":[5.0,25.0,0.5],"claude-opus-4.8":[5.0,25.0,0.5],"claude-opus-5":[5.0,25.0,0.5],"claude-opus-5.5":[4.0,20.0,0.2],"claude-sonnet-4.6":[3.0,15.0,0.3],"claude-sonnet-5":[2.0,10.0,0.2],"claude-sonnet-5.5":[2.0,10.0,0.1],"gemini-3.5-flash":[1.5,9.0,0.15],"gemini-3.6-flash":[0.75,3.75,0.075],"gemini-3.7-flash":[0.75,3.75,0.075],"gemini-3.8-flash":[0.75,3.75,0.075],"gpt-5-mini":[0.25,2.0,0.025],"gpt-5.3-codex":[1.75,14.0,0.175],"gpt-5.4":[2.5,15.0,0.25],"gpt-5.4-mini":[0.75,4.5,0.075],"gpt-5.4-nano":[0.2,1.25,0.02],"gpt-5.5":[5.0,30.0,0.5],"gpt-5.6-luna":[0.2,1.2,0.02],"gpt-5.6-sol":[4.0,20.0,0.4],"gpt-5.6-terra":[2.0,12.0,0.2],"gpt-6-astra":[10.0,50.0,1.0],"gpt-6-luna":[0.1,0.5,0.01],"gpt-6-sol":[2.0,10.0,0.2],"gpt-6.1-sol":[2.0,10.0,0.1],"grok-4.5":[2.0,6.0,0.5],"grok-4.6":[2.0,6.0,0.5],"grok-4.7":[2.0,6.0,0.5],"kimi-k2.7-code":[0.95,4.0,0.19],"kimi-k3":[3.0,15.0,0.3],"mai-code-1-flash-picker":[0.75,4.5,0.075],"mai-code-1.1-flash":[0.2,1.2,0.02]},"google":{"deep-research-max-preview-04-2026":[2.0,12.0,0.2],"deep-research-preview-04-2026":[2.0,12.0,0.2],"gemini-2.5-computer-use-preview-10-2025":[1.25,10.0,1.25],"gemini-2.5-flash":[0.3,2.5,0.03],"gemini-2.5-flash-image":[0.3,30.0,0.075],"gemini-2.5-flash-lite":[0.1,0.4,0.01],"gemini-2.5-flash-preview-tts":[0.5,10.0,0.5],"gemini-2.5-pro":[1.25,10.0,0.125],"gemini-2.5-pro-preview-tts":[1.0,20.0,1.0],"gemini-3-flash-preview":[0.5,3.0,0.05],"gemini-3-pro-image":[2.0,120.0,2.0],"gemini-3-pro-image-preview":[2.0,120.0,2.0],"gemini-3.1-flash-image":[0.5,60.0,0.5],"gemini-3.1-flash-image-preview":[0.5,60.0,0.5],"gemini-3.1-flash-lite":[0.25,1.5,0.025],"gemini-3.1-flash-lite-image":[0.25,30.0,0.25],"gemini-3.1-flash-lite-preview":[0.25,1.5,0.025],"gemini-3.1-flash-live-preview":[0.75,4.5,0.75],"gemini-3.1-flash-tts-preview":[1.0,20.0,1.0],"gemini-3.1-pro-preview":[2.0,12.0,0.2],"gemini-3.1-pro-preview-customtools":[2.0,12.0,0.2],"gemini-3.5-flash":[1.5,9.0,0.15],"gemini-3.5-flash-lite":[0.3,2.5,0.03],"gemini-3.5-live-translate-preview":[3.5,21.0,3.5],"gemini-3.6-flash":[0.75,3.75,0.075],"gemini-3.7-flash":[0.75,3.75,0.075],"gemini-3.8-flash":[0.75,3.75,0.075],"gemini-embedding-001":[0.15,0.0,0.15],"gemini-embedding-2":[0.2,0.0,0.2],"gemini-flash-latest":[0.75,3.75,0.075],"gemini-flash-lite-latest":[0.3,2.5,0.03],"gemini-omni-flash-preview":[1.5,17.5,1.5],"lyria-3-clip-preview":[0.0,0.0],"lyria-3-pro-preview":[0.0,0.0]},"google-vertex":{"claude-fable-5-1@default":[10.0,50.0,0.25],"claude-fable-5@default":[10.0,50.0,1.0],"claude-haiku-4-5@20251001":[1.0,5.0,0.1],"claude-haiku-5-5@default":[0.1,0.5,0.01],"claude-opus-4-1@20250805":[15.0,75.0,1.5],"claude-opus-4-5@20251101":[5.0,25.0,0.5],"claude-opus-4-6@default":[5.0,25.0,0.5],"claude-opus-4-7@default":[5.0,25.0,0.5],"claude-opus-4-8@default":[5.0,25.0,0.5],"claude-opus-4@20250514":[15.0,75.0,1.5],"claude-opus-5-5@default":[4.0,20.0,0.2],"claude-opus-5@default":[5.0,25.0,0.5],"claude-sonnet-4-5@20250929":[3.0,15.0,0.3],"claude-sonnet-4-6@default":[3.0,15.0,0.3],"claude-sonnet-4@20250514":[3.0,15.0,0.3],"claude-sonnet-5-5@default":[2.0,10.0,0.1],"claude-sonnet-5@default":[2.0,10.0,0.2],"codestral-2":[0.3,0.9,0.3],"deepseek-ai/deepseek-v3.1-maas":[0.6,1.7,0.06],"deepseek-ai/deepseek-v3.2-maas":[0.56,1.68,0.056],"gemini-2.5-flash":[0.3,2.5,0.03],"gemini-2.5-flash-image":[0.3,30.0,0.3],"gemini-2.5-flash-lite":[0.1,0.4,0.01],"gemini-2.5-flash-tts":[0.5,10.0,0.5],"gemini-2.5-pro":[1.25,10.0,0.125],"gemini-2.5-pro-tts":[1.0,20.0,1.0],"gemini-3-flash-preview":[0.5,3.0,0.05],"gemini-3-pro-image":[2.0,120.0,0.2],"gemini-3.1-flash-image":[0.5,60.0,0.05],"gemini-3.1-flash-lite":[0.25,1.5,0.025],"gemini-3.1-flash-lite-image":[0.25,30.0,0.025],"gemini-3.1-pro-preview":[2.0,12.0,0.2],"gemini-3.1-pro-preview-customtools":[2.0,12.0,0.2],"gemini-3.5-flash":[1.5,9.0,0.15],"gemini-3.5-flash-lite":[0.3,2.5,0.03],"gemini-3.6-flash":[0.75,3.75,0.075],"gemini-3.7-flash":[0.75,3.75,0.075],"gemini-3.8-flash":[0.75,3.75,0.075],"gemini-embedding-001":[0.15,0.0,0.15],"gemini-nano-banana-2.1":[1.5,30.0,0.15],"google/gemma-4-26b-a4b-it-maas":[0.15,0.6,0.015],"meta/llama-3.3-70b-instruct-maas":[0.72,0.72,0.72],"meta/llama-4-maverick-17b-128e-instruct-maas":[0.35,1.15,0.35],"meta/llama-4-scout-17b-16e-instruct-maas":[0.25,0.7,0.25],"mistral-medium-3":[0.4,2.0,0.4],"mistral-small-2503":[0.1,0.3,0.1],"moonshotai/kimi-k2-thinking-maas":[0.6,2.5,0.06],"openai/gpt-oss-120b-maas":[0.09,0.36,0.09],"openai/gpt-oss-20b-maas":[0.07,0.25,0.007],"qwen/qwen3-235b-a22b-instruct-2507-maas":[0.22,0.88,0.22],"xai/grok-4.1-fast-non-reasoning":[0.2,0.5,0.05],"xai/grok-4.1-fast-reasoning":[0.2,0.5,0.05],"xai/grok-4.20-non-reasoning":[1.25,2.5,0.2],"xai/grok-4.20-reasoning":[1.25,2.5,0.2],"xai/grok-4.3":[1.25,2.5,0.2],"xai/grok-4.6":[2.0,6.0,0.5],"xai/grok-4.7":[2.0,6.0,0.5],"zai-org/glm-4.7-maas":[0.6,2.2,0.06],"zai-org/glm-5-maas":[1.0,3.2,0.1],"zai-org/glm-5.2-maas":[1.4,4.4,0.14]},"groq":{"allam-2-7b":[0.0,0.0],"llama-3.1-8b-instant":[0.05,0.08,0.05],"llama-3.3-70b-versatile":[0.59,0.79,0.59],"meta-llama/llama-prompt-guard-2-22m":[0.03,0.03,0.03],"meta-llama/llama-prompt-guard-2-86m":[0.04,0.04,0.04],"openai/gpt-oss-120b":[0.15,0.6,0.075],"openai/gpt-oss-20b":[0.075,0.3,0.0375],"openai/gpt-oss-safeguard-20b":[0.075,0.3,0.075],"qwen/qwen3.6-27b":[0.6,3.0,0.3],"qwen/qwen3.8-27b":[0.8,4.0,0.8]},"meta":{"muse-spark-1.1":[1.25,4.25,0.15],"muse-spark-1.2":[1.25,4.25,0.15],"muse-spark-1.2-contributor":[0.1,0.2,0.002],"muse-spark-1.3":[1.25,4.25,0.15],"muse-spark-1.3-contributor":[0.1,0.2,0.002]},"minimax":{"minimax-m2":[0.3,1.2,0.3],"minimax-m2.1":[0.3,1.2,0.03],"minimax-m2.5":[0.3,1.2,0.03],"minimax-m2.5-highspeed":[0.6,2.4,0.03],"minimax-m2.7":[0.3,1.2,0.06],"minimax-m2.7-highspeed":[0.6,2.4,0.06],"minimax-m3":[0.3,1.2,0.06]},"mistral":{"codestral-2508":[0.3,0.9,0.03],"codestral-latest":[0.3,0.9,0.03],"devstral-2512":[0.4,2.0,0.4],"devstral-latest":[0.4,2.0,0.4],"devstral-medium-2507":[0.4,2.0,0.4],"devstral-medium-latest":[0.4,2.0,0.4],"devstral-small-2505":[0.1,0.3,0.1],"devstral-small-2507":[0.1,0.3,0.1],"glm-5-2":[1.4,4.4,0.14],"labs-devstral-small-2512":[0.0,0.0],"labs-leanstral-1-5-1":[0.0,0.0],"magistral-medium-latest":[2.0,5.0,2.0],"ministral-14b-2512":[0.2,0.2,0.02],"ministral-3b-2512":[0.1,0.1,0.01],"ministral-3b-latest":[0.04,0.04,0.04],"ministral-8b-2512":[0.15,0.15,0.015],"ministral-8b-latest":[0.1,0.1,0.1],"mistral-embed":[0.1,0.0,0.1],"mistral-large-2411":[2.0,6.0,2.0],"mistral-large-2512":[0.5,1.5,0.05],"mistral-large-4":[0.68,2.09,0.07],"mistral-large-latest":[0.5,1.5,0.05],"mistral-medium-2505":[0.4,2.0,0.4],"mistral-medium-2508":[0.4,2.0,0.4],"mistral-medium-2604":[1.5,7.5,0.15],"mistral-medium-latest":[1.5,7.5,0.15],"mistral-nemo":[0.15,0.15,0.15],"mistral-small-2506":[0.1,0.3,0.1],"mistral-small-2603":[0.15,0.6,0.015],"mistral-small-latest":[0.15,0.6,0.015],"open-mistral-7b":[0.25,0.25,0.25],"open-mistral-nemo":[0.15,0.15,0.15],"open-mixtral-8x22b":[2.0,6.0,2.0],"open-mixtral-8x7b":[0.7,0.7,0.7],"pixtral-12b":[0.15,0.15,0.15],"pixtral-large-latest":[2.0,6.0,2.0],"voxtral-small-2507":[0.1,0.4,0.1],"voxtral-small-latest":[0.1,0.3,0.1],"zai-glm-5-2":[1.4,4.4,0.14],"zai-glm-5-3":[1.4,4.4,0.14]},"moonshotai":{"kimi-k2.6":[0.95,4.0,0.16],"kimi-k2.7-code":[0.95,4.0,0.19],"kimi-k2.7-code-highspeed":[1.9,8.0,0.38],"kimi-k3":[3.0,15.0,0.3]},"openai":{"gpt-3.5-turbo":[0.5,1.5],"gpt-4":[30.0,60.0,30.0],"gpt-4-turbo":[10.0,30.0,10.0],"gpt-4.1":[2.0,8.0,0.5],"gpt-4.1-mini":[0.4,1.6,0.1],"gpt-4.1-nano":[0.1,0.4,0.025],"gpt-4o":[2.5,10.0,1.25],"gpt-4o-2024-05-13":[5.0,15.0,5.0],"gpt-4o-2024-08-06":[2.5,10.0,1.25],"gpt-4o-2024-11-20":[2.5,10.0,1.25],"gpt-4o-mini":[0.15,0.6,0.075],"gpt-5":[1.25,10.0,0.125],"gpt-5-mini":[0.25,2.0,0.025],"gpt-5-nano":[0.05,0.4,0.005],"gpt-5-pro":[15.0,120.0,15.0],"gpt-5.1":[1.25,10.0,0.125],"gpt-5.2":[1.75,14.0,0.175],"gpt-5.2-chat-latest":[1.75,14.0,0.175],"gpt-5.2-pro":[21.0,168.0,21.0],"gpt-5.3-chat-latest":[1.75,14.0,0.175],"gpt-5.3-codex":[1.75,14.0,0.175],"gpt-5.3-codex-spark":[1.75,14.0,0.175],"gpt-5.4":[2.5,15.0,0.25],"gpt-5.4-mini":[0.75,4.5,0.075],"gpt-5.4-nano":[0.2,1.25,0.02],"gpt-5.4-pro":[30.0,180.0,30.0],"gpt-5.5":[5.0,30.0,0.5],"gpt-5.5-pro":[30.0,180.0,30.0],"gpt-5.6":[4.0,20.0,0.4],"gpt-5.6-luna":[0.2,1.2,0.02],"gpt-5.6-sol":[4.0,20.0,0.4],"gpt-5.6-terra":[2.0,12.0,0.2],"gpt-6-astra":[10.0,50.0,1.0],"gpt-6-luna":[0.1,0.5,0.01],"gpt-6-sol":[2.0,10.0,0.2],"gpt-6.1-sol":[2.0,10.0,0.1],"gpt-daybreak-blue-latest":[4.0,20.0,0.4],"gpt-daybreak-red-latest":[12.5,75.0,1.25],"gpt-image-2":[5.0,30.0,1.25],"gpt-realtime-2.1":[4.0,24.0,0.4],"o1":[15.0,60.0,7.5],"o1-pro":[150.0,600.0,150.0],"o3":[2.0,8.0,0.5],"o3-mini":[1.1,4.4,0.55],"o3-pro":[20.0,80.0,20.0],"o4-mini":[1.1,4.4,0.275],"text-embedding-3-large":[0.13,0.0,0.13],"text-embedding-3-small":[0.02,0.0,0.02],"text-embedding-ada-002":[0.1,0.0,0.1]},"openrouter":{"aion-labs/aion-2.0":[0.8,1.6,0.2],"aion-labs/aion-3.0":[3.0,6.0,0.75],"aion-labs/aion-3.0-mini":[0.7,1.4,0.18],"aion-labs/aion-3.5":[3.0,6.0,0.75],"aion-labs/aion-3.5-mini":[0.7,1.4,0.18],"aion-labs/aion-rp-llama-3.1-8b":[0.8,1.6,0.8],"amazon/nova-2-lite-v1":[0.3,2.5,0.3],"amazon/nova-lite-v1":[0.06,0.24,0.06],"amazon/nova-micro-v1":[0.035,0.14,0.035],"amazon/nova-premier-v1":[2.5,12.5,0.625],"amazon/nova-pro-v1":[0.8,3.2,0.8],"anthracite-org/magnum-v4-72b":[2.5,5.0,2.5],"anthropic/claude-fable-5":[10.0,50.0,1.0],"anthropic/claude-fable-5.1":[10.0,50.0,0.25],"anthropic/claude-haiku-4.5":[1.0,5.0,0.1],"anthropic/claude-haiku-5.5":[0.1,0.5,0.01],"anthropic/claude-opus-4.1":[15.0,75.0,1.5],"anthropic/claude-opus-4.5":[5.0,25.0,0.5],"anthropic/claude-opus-4.6":[5.0,25.0,0.5],"anthropic/claude-opus-4.7":[5.0,25.0,0.5],"anthropic/claude-opus-4.8":[5.0,25.0,0.5],"anthropic/claude-opus-5":[5.0,25.0,0.5],"anthropic/claude-opus-5.5":[4.0,20.0,0.2],"anthropic/claude-sonnet-4":[3.0,15.0,0.3],"anthropic/claude-sonnet-4.5":[3.0,15.0,0.3],"anthropic/claude-sonnet-4.6":[3.0,15.0,0.3],"anthropic/claude-sonnet-5":[2.0,10.0,0.2],"anthropic/claude-sonnet-5.5":[2.0,10.0,0.1],"apodex/apodex-1.1-mini:free":[0.0,0.0],"arcee-ai/trinity-large-thinking":[0.25,0.8,0.06],"bytedance-seed/seed-1.6":[0.25,2.0,0.25],"bytedance-seed/seed-1.6-flash":[0.075,0.3,0.075],"bytedance-seed/seed-2-1-turbo":[0.5,2.5,0.5],"bytedance-seed/seed-2.0-code":[0.5,3.0,0.5],"bytedance-seed/seed-2.0-lite":[0.25,2.0,0.25],"bytedance-seed/seed-2.0-mini":[0.1,0.4,0.1],"bytedance/ui-tars-1.5-7b":[0.1,0.2,0.1],"cognitivecomputations/dolphin-mistral-24b-venice-edition":[0.2,0.9,0.2],"cohere/command-a":[2.5,10.0,2.5],"cohere/command-a-plus":[0.3,1.5,0.15],"cohere/command-r-08-2024":[0.15,0.6,0.15],"cohere/command-r-plus-08-2024":[2.5,10.0,2.5],"cohere/command-r7b-12-2024":[0.0375,0.15,0.0375],"cohere/north-mini-code:free":[0.0,0.0],"deepseek/deepseek-chat":[0.32,0.89,0.32],"deepseek/deepseek-chat-v3-0324":[0.29,1.14,0.11],"deepseek/deepseek-chat-v3.1":[0.25,0.95,0.13],"deepseek/deepseek-r1":[0.7,2.5,0.7],"deepseek/deepseek-r1-0528":[0.5,2.15,0.35],"deepseek/deepseek-v3.1-terminus":[0.27,1.0,0.27],"deepseek/deepseek-v3.2":[0.259,0.42,0.135],"deepseek/deepseek-v3.2-exp":[0.27,0.41,0.27],"deepseek/deepseek-v4-flash":[0.0075,1.28,0.0075],"deepseek/deepseek-v4-flash-0731":[0.0062,1.28,0.0062],"deepseek/deepseek-v4-flash-vision-exp":[0.2156,0.6468,0.00686],"deepseek/deepseek-v4-pro":[0.2088,0.4176,0.0174],"deepseek/deepseek-v4-pro-0813":[0.66,1.98,0.022],"deepseek/deepseek-v4.1-flash":[0.3,1.2,0.006],"dots-studio/dots-3-note-preview:free":[0.0,0.0],"fireworks/ember-1":[3.0,15.0,0.3],"google/gemini-2.5-flash":[0.3,2.5,0.03],"google/gemini-2.5-flash-image":[0.3,2.5,0.03],"google/gemini-2.5-flash-lite":[0.1,0.4,0.01],"google/gemini-2.5-pro":[1.25,10.0,0.125],"google/gemini-2.5-pro-preview":[1.25,10.0,0.125],"google/gemini-3-flash-preview":[0.5,3.0,0.05],"google/gemini-3-pro-image":[2.0,12.0,0.2],"google/gemini-3-pro-image-preview":[2.0,12.0,0.2],"google/gemini-3.1-flash-image":[0.5,3.0,0.5],"google/gemini-3.1-flash-image-preview":[0.5,3.0,0.5],"google/gemini-3.1-flash-lite":[0.25,1.5,0.025],"google/gemini-3.1-flash-lite-image":[0.25,1.5,0.25],"google/gemini-3.1-flash-lite-preview":[0.25,1.5,0.025],"google/gemini-3.1-pro-preview":[2.0,12.0,0.2],"google/gemini-3.1-pro-preview-customtools":[2.0,12.0,0.2],"google/gemini-3.5-flash":[1.5,9.0,0.15],"google/gemini-3.5-flash-lite":[0.3,2.5,0.03],"google/gemini-3.6-flash":[0.75,3.75,0.075],"google/gemini-3.7-flash":[0.75,3.75,0.075],"google/gemini-3.8-flash":[0.75,3.75,0.075],"google/gemini-nano-banana-2.1":[1.5,7.5,1.5],"google/gemma-2-27b-it":[0.65,0.65,0.65],"google/gemma-3-12b-it":[0.05,0.15,0.05],"google/gemma-3-27b-it":[0.08,0.45,0.04],"google/gemma-3-4b-it":[0.05,0.1,0.05],"google/gemma-4-26b-a4b-it":[0.0675,0.225,0.0375],"google/gemma-4-26b-a4b-it:free":[0.0,0.0],"google/gemma-4-31b-it":[0.09,0.34,0.05],"google/gemma-4-31b-it:free":[0.0,0.0],"google/lyria-3-clip-preview":[0.0,0.0],"google/lyria-3-pro-preview":[0.0,0.0],"gryphe/mythomax-l2-13b":[0.08,0.11,0.08],"ibm-granite/granite-4.0-h-micro":[0.017,0.112,0.017],"ibm-granite/granite-4.2-8b":[0.06,0.25,0.015],"inception/mercury-2":[0.25,0.75,0.025],"inception/mercury-2.5":[0.04,0.15,0.004],"inclusionai/ling-3.0-flash":[0.021,0.063,0.0042],"inclusionai/ling-3.0-flash-fin":[0.042,0.1232,0.0084],"inclusionai/ling-3.0-flash-sante":[0.042,0.1232,0.0084],"inclusionai/ling-3.0-flash-vl":[0.021,0.0616,0.0042],"inclusionai/ling-3.1-flash":[0.0,0.0],"inference-net/schematron-v2-small":[0.05,0.23,0.05],"inference-net/schematron-v2-turbo":[0.03,0.15,0.03],"liquid/lfm-2.5-2.6b:free":[0.0,0.0],"mancer/weaver":[0.4,0.75,0.4],"meituan/longcat-2.0":[0.3,1.2,0.006],"meta-llama/llama-3.1-70b-instruct":[0.4,0.4,0.4],"meta-llama/llama-3.1-8b-instruct":[0.05,0.08,0.025],"meta-llama/llama-3.2-1b-instruct":[0.027,0.201,0.027],"meta-llama/llama-3.2-3b-instruct":[0.05,0.33,0.05],"meta-llama/llama-3.3-70b-instruct":[0.22,0.5,0.11],"meta-llama/llama-4-maverick":[0.1875,0.6525,0.05],"meta-llama/llama-4-scout":[0.1,0.3,0.1],"meta-llama/llama-guard-4-12b":[0.18,0.18,0.18],"meta/muse-glimmer-30b":[0.3,1.2,0.04],"meta/muse-spark-1.1":[1.25,4.25,0.15],"meta/muse-spark-1.2":[1.25,4.25,0.15],"meta/muse-spark-1.2-contributor":[0.1,0.2,0.002],"meta/muse-spark-1.3":[1.25,4.25,0.15],"meta/muse-spark-1.3-contributor":[0.1,0.2,0.002],"microsoft/phi-4":[0.07,0.14,0.07],"microsoft/wizardlm-2-8x22b":[0.62,0.62,0.62],"minimax/minimax-01":[0.2,1.1,0.2],"minimax/minimax-m1":[0.55,2.2,0.55],"minimax/minimax-m2":[0.3,1.2,0.3],"minimax/minimax-m2-her":[0.3,1.2,0.03],"minimax/minimax-m2.1":[0.3,1.2,0.03],"minimax/minimax-m2.5":[0.27,1.08,0.027],"minimax/minimax-m2.7":[0.21,0.84,0.042],"minimax/minimax-m3":[0.3,1.2,0.06],"mistralai/codestral-2508":[0.3,0.9,0.03],"mistralai/devstral-2512":[0.4,2.0,0.04],"mistralai/ministral-14b-2512":[0.2,0.2,0.02],"mistralai/ministral-3b-2512":[0.1,0.1,0.01],"mistralai/ministral-8b-2512":[0.15,0.15,0.015],"mistralai/mistral-large":[2.0,6.0,0.2],"mistralai/mistral-large-2407":[2.0,6.0,0.2],"mistralai/mistral-large-2512":[0.5,1.5,0.05],"mistralai/mistral-large-4-0":[0.68,2.09,0.07],"mistralai/mistral-medium-3":[0.4,2.0,0.04],"mistralai/mistral-medium-3-5":[1.5,7.5,1.5],"mistralai/mistral-medium-3.1":[0.4,2.0,0.04],"mistralai/mistral-nemo":[0.029,0.03,0.029],"mistralai/mistral-saba":[0.2,0.6,0.02],"mistralai/mistral-small-24b-instruct-2501":[0.05,0.08,0.05],"mistralai/mistral-small-2603":[0.15,0.6,0.015],"mistralai/mistral-small-3.1-24b-instruct":[0.351,0.555,0.351],"mistralai/mistral-small-3.2-24b-instruct":[0.09375,0.25,0.09375],"mistralai/mixtral-8x22b-instruct":[2.0,6.0,0.2],"mistralai/voxtral-small-24b-2507":[0.1,0.3,0.01],"moonshotai/kimi-k2":[0.57,2.3,0.57],"moonshotai/kimi-k2-0905":[0.6,2.5,0.6],"moonshotai/kimi-k2-thinking":[0.6,2.5,0.15],"moonshotai/kimi-k2.5":[0.45,2.25,0.07],"moonshotai/kimi-k2.6":[0.4344,2.45,0.1077],"moonshotai/kimi-k2.7-code":[0.6712,3.35,0.18],"moonshotai/kimi-k3":[0.8,13.5,0.5],"morph/morph-v3-fast":[0.8,1.2,0.8],"morph/morph-v3-large":[0.9,1.9,0.9],"nex-agi/nex-n2.5-mini":[0.025,0.1,0.0025],"nex-agi/nex-n2.5-pro":[0.075,0.25,0.015],"nousresearch/hermes-3-llama-3.1-405b":[1.0,1.0,1.0],"nousresearch/hermes-3-llama-3.1-70b":[0.7,0.7,0.7],"nousresearch/hermes-4-405b":[1.0,3.0,1.0],"nvidia/nemotron-3-nano-30b-a3b":[0.06,0.24,0.06],"nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free":[0.0,0.0],"nvidia/nemotron-3-super-120b-a12b":[0.08,0.45,0.08],"nvidia/nemotron-3-super-120b-a12b:free":[0.0,0.0],"nvidia/nemotron-3-ultra-550b-a55b":[0.5,2.2,0.1],"nvidia/nemotron-3-ultra-550b-a55b:free":[0.0,0.0],"nvidia/nemotron-3.5-content-safety":[0.2,0.2,0.2],"nvidia/nemotron-3.5-content-safety:free":[0.0,0.0],"nvidia/nemotron-3.5-lightning":[0.0469,0.134,0.02345],"nvidia/nemotron-3.5-lightning:free":[0.0,0.0],"openai/gpt-3.5-turbo":[0.5,1.5,0.5],"openai/gpt-3.5-turbo-0613":[1.0,2.0,1.0],"openai/gpt-3.5-turbo-16k":[3.0,4.0,3.0],"openai/gpt-3.5-turbo-instruct":[1.5,2.0,1.5],"openai/gpt-4":[30.0,60.0,30.0],"openai/gpt-4-turbo":[10.0,30.0,10.0],"openai/gpt-4.1":[2.0,8.0,0.5],"openai/gpt-4.1-mini":[0.4,1.6,0.1],"openai/gpt-4.1-nano":[0.1,0.4,0.025],"openai/gpt-4o":[2.5,10.0,1.25],"openai/gpt-4o-2024-05-13":[5.0,15.0,5.0],"openai/gpt-4o-2024-08-06":[2.5,10.0,1.25],"openai/gpt-4o-2024-11-20":[2.5,10.0,1.25],"openai/gpt-4o-mini":[0.15,0.6,0.075],"openai/gpt-4o-mini-2024-07-18":[0.15,0.6,0.075],"openai/gpt-5":[1.25,10.0,0.125],"openai/gpt-5-image":[10.0,10.0,1.25],"openai/gpt-5-image-mini":[2.5,2.0,0.25],"openai/gpt-5-mini":[0.25,2.0,0.025],"openai/gpt-5-nano":[0.05,0.4,0.005],"openai/gpt-5-pro":[15.0,120.0,15.0],"openai/gpt-5.1":[1.25,10.0,0.125],"openai/gpt-5.1-codex":[1.25,10.0,0.13],"openai/gpt-5.1-codex-max":[1.25,10.0,0.125],"openai/gpt-5.1-codex-mini":[0.25,2.0,0.03],"openai/gpt-5.2":[1.75,14.0,0.175],"openai/gpt-5.2-chat":[1.75,14.0,0.175],"openai/gpt-5.2-codex":[1.75,14.0,0.175],"openai/gpt-5.2-pro":[21.0,168.0,21.0],"openai/gpt-5.3-codex":[1.75,14.0,0.175],"openai/gpt-5.4":[2.5,15.0,0.25],"openai/gpt-5.4-image-2":[8.0,15.0,2.0],"openai/gpt-5.4-mini":[0.75,4.5,0.075],"openai/gpt-5.4-nano":[0.2,1.25,0.02],"openai/gpt-5.4-pro":[30.0,180.0,30.0],"openai/gpt-5.5":[5.0,30.0,0.5],"openai/gpt-5.5-pro":[30.0,180.0,30.0],"openai/gpt-5.6-luna":[0.2,1.2,0.02],"openai/gpt-5.6-luna-pro":[0.2,1.2,0.02],"openai/gpt-5.6-sol":[2.0,10.0,0.2],"openai/gpt-5.6-sol-pro":[2.0,10.0,0.2],"openai/gpt-5.6-terra":[2.0,12.0,0.2],"openai/gpt-5.6-terra-pro":[2.0,12.0,0.2],"openai/gpt-6-astra":[10.0,50.0,1.0],"openai/gpt-6-astra-pro":[10.0,50.0,1.0],"openai/gpt-6-luna":[0.1,0.5,0.01],"openai/gpt-6-luna-pro":[0.1,0.5,0.01],"openai/gpt-6-sol":[2.0,10.0,0.2],"openai/gpt-6-sol-pro":[2.0,10.0,0.2],"openai/gpt-6.1-sol":[2.0,10.0,0.1],"openai/gpt-6.1-sol-pro":[2.0,10.0,0.1],"openai/gpt-audio":[2.5,10.0,2.5],"openai/gpt-audio-mini":[0.6,2.4,0.6],"openai/gpt-chat-latest":[5.0,30.0,0.5],"openai/gpt-oss-120b":[0.037,0.17,0.037],"openai/gpt-oss-20b":[0.018,0.09,0.009],"openai/gpt-oss-safeguard-20b":[0.075,0.3,0.0375],"openai/o1":[15.0,60.0,7.5],"openai/o1-pro":[150.0,600.0,150.0],"openai/o3":[2.0,8.0,0.5],"openai/o3-mini":[1.1,4.4,0.55],"openai/o3-mini-high":[1.1,4.4,0.55],"openai/o3-pro":[20.0,80.0,20.0],"openai/o4-mini":[1.1,4.4,0.275],"openai/o4-mini-high":[1.1,4.4,0.275],"openrouter/free":[0.0,0.0],"perceptron/perceptron-mk1":[0.15,1.5,0.15],"perceptron/perceptron-mk1.5":[0.15,1.5,0.15],"perplexity/sonar":[1.0,1.0,1.0],"perplexity/sonar-deep-research":[2.0,8.0,2.0],"perplexity/sonar-pro":[3.0,15.0,3.0],"perplexity/sonar-pro-search":[3.0,15.0,3.0],"perplexity/sonar-reasoning-pro":[2.0,8.0,2.0],"poolside/laguna-s-2.1":[0.09,0.18,0.009],"poolside/laguna-s-2.1:free":[0.0,0.0],"poolside/laguna-xs-2.1":[0.06,0.12,0.03],"poolside/laguna-xs-2.1:free":[0.0,0.0],"prism-ml/ternary-bonsai-2-27b":[0.075,0.5,0.0375],"qwen/qwen-2.5-72b-instruct":[0.36,0.4,0.36],"qwen/qwen-2.5-7b-instruct":[0.1,0.2,0.1],"qwen/qwen-2.5-coder-32b-instruct":[0.66,1.0,0.66],"qwen/qwen-plus":[0.26,0.78,0.052],"qwen/qwen2.5-vl-72b-instruct":[0.8,1.0,0.4],"qwen/qwen3-14b":[0.12,0.24,0.12],"qwen/qwen3-235b-a22b-2507":[0.09,0.55,0.09],"qwen/qwen3-235b-a22b-thinking-2507":[0.45,3.5,0.45],"qwen/qwen3-30b-a3b":[0.12,0.5,0.12],"qwen/qwen3-30b-a3b-instruct-2507":[0.1,0.3,0.1],"qwen/qwen3-32b":[0.08,0.28,0.08],"qwen/qwen3-coder":[0.3,1.0,0.1],"qwen/qwen3-coder-30b-a3b-instruct":[0.07,0.28,0.07],"qwen/qwen3-coder-flash":[0.195,0.975,0.039],"qwen/qwen3-coder-next":[0.12,0.8,0.07],"qwen/qwen3-next-80b-a3b-instruct":[0.1,1.1,0.07],"qwen/qwen3-next-80b-a3b-thinking":[0.15,1.2,0.15],"qwen/qwen3-vl-235b-a22b-instruct":[0.21,1.9,0.1],"qwen/qwen3-vl-30b-a3b-instruct":[0.15,0.6,0.15],"qwen/qwen3-vl-30b-a3b-thinking":[0.29,1.0,0.29],"qwen/qwen3-vl-8b-instruct":[0.25,0.75,0.12],"qwen/qwen3.5-122b-a10b":[0.26,2.08,0.26],"qwen/qwen3.5-27b":[0.26,2.6,0.26],"qwen/qwen3.5-35b-a3b":[0.08,0.75,0.04],"qwen/qwen3.5-397b-a17b":[0.55,3.5,0.225],"qwen/qwen3.5-9b":[0.1,0.15,0.1],"qwen/qwen3.5-flash-02-23":[0.065,0.26,0.065],"qwen/qwen3.5-plus-02-15":[0.26,1.56,0.26],"qwen/qwen3.5-plus-20260420":[0.3,1.8,0.3],"qwen/qwen3.6-27b":[0.32,3.2,0.32],"qwen/qwen3.6-35b-a3b":[0.15,1.0,0.05],"qwen/qwen3.6-flash":[0.1875,1.125,0.1875],"qwen/qwen3.6-plus":[0.325,1.95,0.325],"qwen/qwen3.7-flash":[0.03,0.13,0.006],"qwen/qwen3.7-max":[1.475,4.425,0.295],"qwen/qwen3.7-plus":[0.32,1.28,0.064],"qwen/qwen3.8-2.4t-a95b":[2.0,6.0,0.25],"qwen/qwen3.8-27b":[0.425,2.55,0.085],"qwen/qwen3.8-flash":[0.15,0.47,0.016],"qwen/qwen3.8-max-0902":[2.0,6.0,0.25],"qwen/qwen3.8-max-prime":[4.0,12.0,0.5],"qwen/qwen3.8-omni-flash":[0.15,0.47,0.016],"rekaai/reka-edge":[0.1,0.1,0.1],"rekaai/reka-flash-3":[0.1,0.2,0.1],"relace/relace-apply-3":[0.85,1.25,0.85],"relace/relace-search":[1.0,3.0,1.0],"sakana/fugu-max":[2.0,6.0,0.25],"sakana/fugu-ultra":[5.0,30.0,0.5],"sakana/fugu-ultra-v2":[5.0,30.0,0.5],"sakana/sakana-namazu":[0.95,4.0,0.15],"sao10k/l3-lunaris-8b":[0.04,0.05,0.04],"sao10k/l3.1-euryale-70b":[0.85,0.85,0.85],"sao10k/l3.3-euryale-70b":[0.65,0.75,0.65],"stepfun/step-3.5-flash":[0.1,0.3,0.1],"stepfun/step-3.7-flash":[0.2,1.15,0.04],"stepfun/step-5-preview":[1.0,2.7,0.05],"tencent/hunyuan-a13b-instruct":[0.14,0.57,0.14],"tencent/hy-mt2-1.8b":[0.044,0.177,0.044],"tencent/hy-mt2-30b-a3b":[0.074,0.295,0.074],"tencent/hy-mt2-7b":[0.074,0.295,0.074],"tencent/hy3":[0.0825,0.33,0.020625],"tencent/hy3-preview":[0.18,0.6,0.06],"tencent/hy4-preview":[0.7506,2.2509,0.0378],"thedrummer/cydonia-24b-v4.1":[0.3,0.5,0.15],"thedrummer/skyfall-36b-v2":[0.55,0.8,0.25],"thedrummer/unslopnemo-12b":[0.4,0.4,0.4],"thinkingmachines/inkling":[1.0,4.05,0.17],"thinkingmachines/inkling-small":[0.45,1.2,0.1],"thinkingmachines/inkling-small:free":[0.0,0.0],"thinkingmachines/inkling:free":[0.0,0.0],"unbiased/pareto":[2.5,7.5,0.25],"unbiased/pareto-26.10-preview":[0.8,3.2,0.03],"undi95/remm-slerp-l2-13b":[0.35,0.65,0.35],"upstage/solar-mini4":[0.05,0.2,0.005],"upstage/solar-pro-3":[0.15,0.6,0.015],"upstage/solar-pro4":[0.09,0.36,0.018],"writer/palmyra-x5":[0.6,6.0,0.6],"x-ai/grok-4.20":[1.25,2.5,0.2],"x-ai/grok-4.20-multi-agent":[1.25,2.5,0.2],"x-ai/grok-4.3":[1.25,2.5,0.2],"x-ai/grok-4.5":[2.0,6.0,0.3],"x-ai/grok-4.6":[2.0,6.0,0.5],"x-ai/grok-4.7":[2.0,6.0,0.5],"x-ai/grok-build-0.1":[1.0,2.0,0.2],"xiaomi/mimo-v2.5":[0.14,0.28,0.0028],"xiaomi/mimo-v2.5-pro":[0.435,0.87,0.0036],"xiaomi/mimo-v2.6-flash":[0.14,0.28,0.0028],"xiaomi/mimo-v2.6-pro":[0.435,0.87,0.0036],"xiaomi/mimo-v2.6-pro-ultraspeed":[4.35,8.7,0.036],"z-ai/glm-4.5":[0.6,2.2,0.11],"z-ai/glm-4.5-air":[0.13,0.85,0.025],"z-ai/glm-4.5v":[0.6,1.8,0.11],"z-ai/glm-4.6":[0.5,2.0,0.1],"z-ai/glm-4.6v":[0.3,0.9,0.055],"z-ai/glm-4.7":[0.6,2.2,0.11],"z-ai/glm-4.7-flash":[0.0605,0.4,0.0605],"z-ai/glm-5":[0.6,1.92,0.12],"z-ai/glm-5-turbo":[1.2,4.0,0.24],"z-ai/glm-5.1":[0.966,3.036,0.1794],"z-ai/glm-5.2":[0.06,6.0,0.059],"z-ai/glm-5.3":[0.05,6.0,0.049],"z-ai/glm-5.3-flash":[0.15,0.5,0.03],"z-ai/glm-5.3-flashx":[0.37,1.25,0.09],"z-ai/glm-5.3-prime":[2.8,8.8,0.56],"z-ai/glm-5v-turbo":[1.2,4.0,0.24],"~anthropic/claude-fable-latest":[10.0,50.0,0.25],"~anthropic/claude-haiku-latest":[0.1,0.5,0.01],"~anthropic/claude-opus-latest":[4.0,20.0,0.2],"~anthropic/claude-sonnet-latest":[2.0,10.0,0.1],"~deepseek/deepseek-flash-latest":[0.016,0.6,0.005],"~deepseek/deepseek-pro-latest":[0.14256,0.42768,0.004536],"~deepseek/deepseek-v4-flash-latest":[0.00496,0.009528,0.00496],"~google/gemini-flash-latest":[0.75,3.75,0.075],"~google/gemini-pro-latest":[2.0,12.0,0.2],"~moonshotai/kimi-latest":[0.8,13.5,0.5],"~openai/gpt-astra-latest":[10.0,50.0,1.0],"~openai/gpt-luna-latest":[0.1,0.5,0.01],"~openai/gpt-mini-latest":[0.75,4.5,0.075],"~openai/gpt-sol-latest":[2.0,10.0,0.1],"~openai/gpt-terra-latest":[2.0,12.0,0.2],"~x-ai/grok-latest":[2.0,6.0,0.5],"~z-ai/glm-flash-latest":[0.032,0.083071,0.01],"~z-ai/glm-latest":[0.05,6.0,0.049]},"perplexity":{"sonar":[1.0,1.0,1.0],"sonar-deep-research":[2.0,8.0,2.0],"sonar-pro":[3.0,15.0,3.0],"sonar-reasoning-pro":[2.0,8.0,2.0]},"togetherai":{"deepseek-ai/deepseek-r1":[3.0,7.0,3.0],"deepseek-ai/deepseek-v3":[1.25,1.25,1.25],"deepseek-ai/deepseek-v3-1":[0.6,1.7,0.6],"deepseek-ai/deepseek-v4-flash-0731":[0.14,0.28,0.03],"deepseek-ai/deepseek-v4-pro-0813":[1.32,3.96,0.13],"deepseek-ai/deepseek-v4.1-flash":[0.3,1.2,0.006],"essentialai/rnj-1-instruct":[0.15,0.15,0.15],"liquidai/lfm2-24b-a2b":[0.03,0.12,0.03],"meta-llama/llama-3.3-70b-instruct-turbo":[1.04,1.04,1.04],"minimaxai/minimax-m2.5":[0.3,1.2,0.06],"minimaxai/minimax-m2.7":[0.3,1.2,0.06],"minimaxai/minimax-m3":[0.3,1.2,0.06],"moonshotai/kimi-k3":[3.0,15.0,0.3],"nvidia/nemotron-3-ultra-550b-a55b":[0.6,3.6,0.2],"openai/gpt-oss-120b":[0.15,0.6,0.15],"qwen/qwen2.5-7b-instruct-turbo":[0.3,0.3,0.3],"qwen/qwen3-235b-a22b-instruct-2507-tput":[0.2,0.6,0.2],"qwen/qwen3-coder-480b-a35b-instruct-fp8":[2.0,2.0,2.0],"qwen/qwen3-coder-next-fp8":[0.5,1.2,0.5],"qwen/qwen3.5-397b-a17b":[0.6,3.6,0.35],"qwen/qwen3.5-9b":[0.17,0.25,0.17],"qwen/qwen3.6-plus":[0.5,3.0,0.5],"qwen/qwen3.7-max":[1.25,3.75,0.125],"thinkingmachines/inkling":[1.0,4.05,0.17],"zai-org/glm-5":[1.0,3.2,1.0],"zai-org/glm-5.1":[1.4,4.4,0.26],"zai-org/glm-5.2":[1.4,4.4,0.26],"zai-org/glm-5.3":[1.4,4.4,0.26],"zai-org/glm-5.3-flash":[0.15,0.5,0.03]},"xai":{"grok-4.20-0309-non-reasoning":[1.25,2.5,0.2],"grok-4.20-0309-reasoning":[1.25,2.5,0.2],"grok-4.20-multi-agent-0309":[1.25,2.5,0.2],"grok-4.3":[1.25,2.5,0.2],"grok-4.5":[2.0,6.0,0.3],"grok-4.6":[2.0,6.0,0.5],"grok-4.7":[2.0,6.0,0.5],"grok-build-0.1":[1.0,2.0,0.2]}}

/** Hermes provider slug -> models.dev provider id. */
const PROVIDER_ALIASES = {
  'github-copilot': 'github-copilot',
  copilot: 'github-copilot',
  'copilot-acp': 'github-copilot',
  claude: 'anthropic',
  'claude-code': 'anthropic',
  anthropic: 'anthropic',
  openai: 'openai',
  codex: 'openai',
  gemini: 'google',
  'google-gemini': 'google',
  google: 'google',
  vertex: 'google-vertex',
  grok: 'xai',
  xai: 'xai',
  deepseek: 'deepseek',
  kimi: 'moonshotai',
  moonshot: 'moonshotai',
  bedrock: 'amazon-bedrock',
  azure: 'azure',
  groq: 'groq',
  mistral: 'mistral',
  together: 'togetherai',
  openrouter: 'openrouter'
}

/** Candidate model ids for a slug: as-is, tail after '/', and dot/dash swaps. */
function modelAliases(model) {
  const base = String(model).toLowerCase().trim()
  const tail = base.includes('/') ? base.split('/').pop() : base
  const out = new Set([base, tail])
  for (const v of [base, tail]) {
    out.add(v.replace(/\./g, '-'))
    out.add(v.replace(/-(\d)/g, '.$1'))
  }
  return [...out].filter(Boolean)
}

function tableRates(table, names) {
  if (!table) return null
  for (const n of names) {
    const r = table[n]
    if (Array.isArray(r)) return { cache: r[2] ?? r[0], input: r[0], output: r[1] ?? 0 }
  }
  return null
}

/**
 * Bundled models.dev lookup. `own` is true only when the hit came from the
 * table of the provider actually serving the model; any other provider's row
 * is a borrowed price and must be labelled as such.
 */
function bundledLookup(model, provider) {
  if (!model) return null
  const names = modelAliases(model)
  const slug = String(provider || '').toLowerCase().trim()
  const preferred = slug ? PROVIDER_ALIASES[slug] || slug : ''
  if (preferred) {
    const own = tableRates(FALLBACK_RATES[preferred], names)
    if (own) return { own: true, rates: own, source: preferred }
  }
  for (const id of Object.keys(FALLBACK_RATES).sort()) {
    if (id === preferred) continue
    const hit = tableRates(FALLBACK_RATES[id], names)
    if (hit) return { own: false, rates: hit, source: id }
  }
  return null
}

/** Same identity rule as the app's catalogProviderMatches: slug, name or alias. */
function providerMatches(row, provider) {
  if (!row || !provider) return false
  const want = String(provider).toLowerCase()
  const eq = v => typeof v === 'string' && v.toLowerCase() === want
  return eq(row.slug) || eq(row.name) || (Array.isArray(row.aliases) && row.aliases.some(eq))
}

/** Pull the pricing entry for a model out of a model.options payload. */
function findPricing(payload, model, provider) {
  if (!payload || !Array.isArray(payload.providers) || !model) return null
  const rows = payload.providers
  const want = String(model)
  const tail = want.includes('/') ? want.split('/').pop() : want

  const pick = row => {
    const p = row && row.pricing
    if (!p || typeof p !== 'object') return null
    if (p[want]) return { row, entry: p[want] }
    for (const key of Object.keys(p)) {
      if (key === tail || (key.includes('/') && key.split('/').pop() === tail)) return { row, entry: p[key] }
    }
    return null
  }

  const ownRow = provider ? rows.find(r => providerMatches(r, provider)) : null
  if (ownRow) {
    const hit = pick(ownRow)
    if (hit) return { ...hit, ownProvider: true }
  }
  // A foreign row listing the same model id. Its rates are THAT provider's
  // (nous and github-copilot both carry claude-opus-5 at different prices).
  for (const row of rows) {
    if (row === ownRow) continue
    const hit = pick(row)
    if (hit) return { ...hit, ownProvider: false }
  }
  return null
}

/** {input,output,cache} $/Mtok, or null when the catalog knows nothing. */
function toRates(entry) {
  if (!entry) return null
  const rIn = parseRate(entry.input)
  const rOut = parseRate(entry.output)
  if (rIn == null && rOut == null) return null
  const input = rIn ?? 0
  const output = rOut ?? 0
  const cache = parseRate(entry.cache) ?? input
  return { input, output, cache }
}

function rateKey(provider, model) {
  return `${String(provider || '').toLowerCase()}|${model}`
}

/**
 * Resolve the rates for (model, provider). Order:
 *   1. live catalog row of the serving provider          -> 'live'
 *   2. rates remembered from an earlier live hit there    -> 'remembered'
 *   3. bundled models.dev table of the serving provider   -> 'bundled'
 *   4. anything else (another provider's catalog/table)   -> 'foreign' (+ slug)
 * When the serving provider is unknown, 1–3 are impossible and every price is
 * borrowed: `providerUnknown` lets the UI say so instead of implying a match.
 */
function resolveRates({ model, provider, payload, remembered }) {
  const p = String(provider || '').trim()
  const base = { foreignSlug: null, provider: p || null, providerUnknown: !p }
  if (!model) return { ...base, origin: 'none', rates: null }

  const found = findPricing(payload, model, p || null)
  if (p) {
    const live = found && found.ownProvider ? toRates(found.entry) : null
    if (live) return { ...base, origin: 'live', rates: live }
    const saved = remembered && remembered[rateKey(p, model)]
    if (validRates(saved)) return { ...base, origin: 'remembered', rates: saved }
    const own = bundledLookup(model, p)
    if (own && own.own) return { ...base, origin: 'bundled', rates: own.rates }
  }
  const foreignLive = found && !found.ownProvider ? toRates(found.entry) : null
  if (foreignLive) return { ...base, foreignSlug: found.row.slug || '?', origin: 'foreign', rates: foreignLive }
  const borrowed = bundledLookup(model, p || null)
  if (borrowed) return { ...base, foreignSlug: borrowed.source, origin: 'foreign', rates: borrowed.rates }
  return { ...base, origin: 'none', rates: null }
}

/**
 * Hermes' CanonicalUsage splits prompt = input + cache_read + cache_write, so
 * bill each stream at its own rate (cache writes have no separate catalog
 * rate; they go at the input rate).
 */
function costOf(bucket, rates) {
  if (!bucket || !rates) return null
  const parts = {
    input: (num(bucket.input) * rates.input) / M,
    cacheRead: (num(bucket.cacheRead) * rates.cache) / M,
    cacheWrite: (num(bucket.cacheWrite) * rates.input) / M,
    output: (num(bucket.output) * rates.output) / M
  }
  return { parts, total: parts.input + parts.cacheRead + parts.cacheWrite + parts.output }
}

/** What cache reads saved versus paying the full input rate for them. */
function cacheSavings(cacheRead, rates) {
  if (!rates) return null
  return (num(cacheRead) * Math.max(0, rates.input - rates.cache)) / M
}

/**
 * UsageStats -> the token streams the ledger tracks.
 *
 * The gateway's `_get_usage` sends `input` (session_input_tokens, falling back
 * to session_prompt_tokens), `prompt` (= input + cache_read + cache_write) and
 * a ROUNDED `cache_hit_pct` that is present only when cache_read > 0. Raw
 * cache_read / cache_write are honoured when a producer sends them.
 *
 *   - raw cache fields present        -> exact.
 *   - prompt > input, no hit%         -> the gap is all cache WRITES (exact:
 *                                        hit% is omitted only when reads = 0).
 *   - prompt > input, hit% present    -> reads ≈ prompt × hit%, capped at the
 *                                        gap; the rest are writes. ESTIMATED.
 *   - prompt == input, hit% present   -> input fell back to prompt; split it by
 *                                        hit%. ESTIMATED.
 * `input` is never reduced twice: the gap already excludes fresh input.
 */
function readUsage(u) {
  const input = num(u.input)
  const prompt = num(u.prompt)
  const rawHit = Number(u.cache_hit_pct)
  const hitPct = u.cache_hit_pct != null && Number.isFinite(rawHit) ? Math.max(0, Math.min(100, rawHit)) : null
  const base = { calls: num(u.calls), output: num(u.output) }

  const hasRaw = u.cache_read != null || u.cache_write != null
  if (hasRaw) {
    const cacheRead = num(u.cache_read)
    const cacheWrite = num(u.cache_write)
    const cached = cacheRead + cacheWrite
    // `input` carries the whole prompt when the provider had no split.
    const fresh = prompt && input === prompt && input >= cached ? input - cached : input
    return { ...base, cacheEstimated: false, cacheRead, cacheWrite, input: fresh }
  }

  if (prompt > input) {
    const gap = prompt - input
    if (hitPct == null) return { ...base, cacheEstimated: false, cacheRead: 0, cacheWrite: gap, input }
    const cacheRead = Math.min(gap, Math.round((prompt * hitPct) / 100))
    return { ...base, cacheEstimated: true, cacheRead, cacheWrite: gap - cacheRead, input }
  }

  if (prompt && hitPct != null && hitPct > 0) {
    const cacheRead = Math.min(prompt, Math.round((prompt * hitPct) / 100))
    return { ...base, cacheEstimated: true, cacheRead, cacheWrite: 0, input: prompt - cacheRead }
  }

  return { ...base, cacheEstimated: false, cacheRead: 0, cacheWrite: 0, input }
}

/** Prompt-cache hit rate of a bucket, in percent (null without prompt tokens). */
function hitPctOf(b) {
  const prompt = num(b.input) + num(b.cacheRead) + num(b.cacheWrite)
  return prompt ? (num(b.cacheRead) / prompt) * 100 : null
}

/* ----------------------------------------------------------------- ledger */

/**
 * v2 shape:
 *   days[YYYY-MM-DD][bucketKey] = Bucket   (bucketKey = profile+provider+model)
 *   snapshots[sid::model]       = last cumulative reading (+ costUsd, at)
 *   rates[provider|model]       = last live catalog rates for that route
 *   legacyRates[model]          = v1's provider-less remembered rates
 *   sessions[storedSessionId]   = Bucket + firstAt/lastAt — a conversation's running
 *                                 total that survives app/gateway restarts
 *   since                       = first day this ledger has data for
 */
function emptyLedger() {
  return { v: LEDGER_VERSION, days: {}, legacyRates: {}, rates: {}, sessions: {}, since: null, snapshots: {} }
}

function bucketKey(profile, provider, model, legacy) {
  return JSON.stringify([profile || '', provider || '', model, legacy ? 1 : 0])
}

function newBucket({ legacy = false, model, profile = '', provider = '' }) {
  return {
    cacheEstimated: false,
    cacheRead: 0,
    cacheWrite: 0,
    calls: 0,
    cost: 0,
    input: 0,
    legacy,
    model,
    output: 0,
    pricedTokens: 0,
    profile,
    provider,
    saved: 0,
    sources: {},
    unpricedTokens: 0
  }
}

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** v1 stored tokens only, keyed by model, and re-priced them on every read. */
function migrateV1(raw, now) {
  const led = emptyLedger()
  const at = now ?? Date.now()
  for (const [date, models] of Object.entries(isObj(raw.days) ? raw.days : {})) {
    if (!isObj(models)) continue
    const day = {}
    for (const [model, b] of Object.entries(models)) {
      if (!isObj(b)) continue
      const nb = newBucket({ legacy: true, model })
      nb.input = num(b.input)
      nb.output = num(b.output)
      nb.cacheRead = num(b.cacheRead)
      nb.cacheWrite = num(b.cacheWrite)
      nb.calls = num(b.calls)
      nb.cost = null
      day[bucketKey('', '', model, true)] = nb
    }
    if (Object.keys(day).length) led.days[date] = day
  }
  for (const [k, s] of Object.entries(isObj(raw.snapshots) ? raw.snapshots : {})) {
    if (isObj(s)) led.snapshots[k] = { ...s, at }
  }
  for (const [model, r] of Object.entries(isObj(raw.rates) ? raw.rates : {})) {
    if (validRates(r)) led.legacyRates[model] = r
  }
  led.since = Object.keys(led.days).sort()[0] || null
  return led
}

function normalizeV2(raw) {
  if (!isObj(raw) || raw.v !== LEDGER_VERSION) return null
  return {
    v: LEDGER_VERSION,
    days: isObj(raw.days) ? raw.days : {},
    legacyRates: isObj(raw.legacyRates) ? raw.legacyRates : {},
    rates: isObj(raw.rates) ? raw.rates : {},
    sessions: isObj(raw.sessions) ? raw.sessions : {},
    since: typeof raw.since === 'string' ? raw.since : null,
    snapshots: isObj(raw.snapshots) ? raw.snapshots : {}
  }
}

/** -> { ledger, migrated } from a ctx.storage-like `{ get(key, fallback) }`. */
function readStoredLedger(store, now) {
  if (!store) return { ledger: emptyLedger(), migrated: false }
  const v2 = normalizeV2(store.get(LEDGER_KEY, null))
  if (v2) return { ledger: v2, migrated: false }
  const v1 = store.get(LEGACY_LEDGER_KEY, null)
  if (isObj(v1) && v1.v === 1) return { ledger: migrateV1(v1, now), migrated: true }
  return { ledger: emptyLedger(), migrated: false }
}

function pruneDays(days, now) {
  const cutoff = daysAgoKey(KEEP_DAYS - 1, now)
  const out = {}
  for (const k of Object.keys(days)) if (k >= cutoff) out[k] = days[k]
  return out
}

function pruneSessions(sessions, now) {
  const cutoff = now - KEEP_DAYS * 86_400_000
  const fresh = Object.entries(sessions).filter(([, s]) => isObj(s) && num(s.lastAt) >= cutoff)
  if (fresh.length > MAX_SESSIONS) fresh.sort((a, b) => num(b[1].lastAt) - num(a[1].lastAt)).length = MAX_SESSIONS
  return Object.fromEntries(fresh)
}

/** Add one priced delta to a bucket (copy-on-write). */
function addDelta(prevBucket, init, { costDelta, cur, delta, deltaTokens, resolved, source }) {
  const b = prevBucket ? { ...prevBucket, sources: { ...prevBucket.sources } } : newBucket(init)
  b.input += delta.input
  b.output += delta.output
  b.cacheRead += delta.cacheRead
  b.cacheWrite += delta.cacheWrite
  b.calls += delta.calls
  if (cur.cacheEstimated && delta.cacheRead) b.cacheEstimated = true
  if (costDelta != null) {
    b.cost += costDelta
    b.pricedTokens += deltaTokens
    b.sources[source] = num(b.sources[source]) + deltaTokens
    if (source === 'foreign' && resolved.foreignSlug) b.foreignSlug = resolved.foreignSlug
  } else {
    b.unpricedTokens += deltaTokens
  }
  if (resolved.rates) b.saved += cacheSavings(delta.cacheRead, resolved.rates)
  return b
}

function pruneSnapshots(snaps, now) {
  const fresh = Object.entries(snaps).filter(([, s]) => isObj(s) && now - num(s.at) <= SNAPSHOT_TTL_MS)
  if (fresh.length > MAX_SNAPSHOTS) fresh.sort((a, b) => num(b[1].at) - num(a[1].at)).length = MAX_SNAPSHOTS
  return Object.fromEntries(fresh)
}

/**
 * Fold one session's cumulative counters into the ledger (pure).
 *
 * Counters are cumulative per LIVE agent and reset on restart, /new and
 * /reset, so we diff against the last snapshot for session+model and add only
 * the delta; a counter that went backwards is a fresh run, adopted whole.
 * The delta is priced NOW, with the rates of the route that served it, and
 * the dollars are stored — history never re-prices.
 *
 * Returns the same object when nothing changed.
 */
function applyUsage(led, { now = Date.now(), payload = null, profile = '', provider = '', sessionId, storedId = '', usage }) {
  if (!sessionId || !usage) return led
  const model = String(usage.model || '').trim()
  if (!model) return led

  const cur = readUsage(usage)
  if (!tokensOf(cur)) return led

  const gatewayCost =
    typeof usage.cost_usd === 'number' && Number.isFinite(usage.cost_usd) && usage.cost_usd > 0 ? usage.cost_usd : null
  const snapKey = `${sessionId}::${model}`
  const prev = led.snapshots[snapKey]
  const restarted =
    !prev ||
    cur.input < num(prev.input) ||
    cur.output < num(prev.output) ||
    cur.cacheRead < num(prev.cacheRead) ||
    cur.cacheWrite < num(prev.cacheWrite) ||
    cur.calls < num(prev.calls)

  const delta = restarted
    ? cur
    : {
        cacheRead: cur.cacheRead - num(prev.cacheRead),
        cacheWrite: cur.cacheWrite - num(prev.cacheWrite),
        calls: cur.calls - num(prev.calls),
        input: cur.input - num(prev.input),
        output: cur.output - num(prev.output)
      }
  const deltaTokens = tokensOf(delta)
  // Nothing new — don't churn storage on every mid-turn tick.
  if (!deltaTokens && !delta.calls) return led

  const resolved = resolveRates({ model, payload, provider, remembered: led.rates })
  let costDelta = null
  let source = 'none'
  const prevGateway = prev && typeof prev.costUsd === 'number' ? prev.costUsd : null
  if (gatewayCost != null && (restarted || (prevGateway != null && gatewayCost >= prevGateway))) {
    costDelta = restarted ? gatewayCost : gatewayCost - prevGateway
    source = 'gateway'
  } else if (resolved.rates) {
    costDelta = costOf(delta, resolved.rates).total
    source = resolved.origin
  }

  const day = dayKey(now)
  const key = bucketKey(profile, provider, model, false)
  const days = { ...led.days }
  const forDay = { ...(days[day] || {}) }
  const change = { costDelta, cur, delta, deltaTokens, resolved, source }
  const b = addDelta(forDay[key], { model, profile, provider }, change)
  forDay[key] = b
  days[day] = forDay

  const rates =
    resolved.origin === 'live' && provider ? { ...led.rates, [rateKey(provider, model)]: resolved.rates } : led.rates
  const snapshots = pruneSnapshots({ ...led.snapshots, [snapKey]: { ...cur, at: now, costUsd: gatewayCost } }, now)
  const pruned = pruneDays(days, now)
  const since = led.since && led.since <= day ? led.since : Object.keys(pruned).sort()[0] || day

  let sessions = led.sessions || {}
  if (storedId) {
    const prevS = sessions[storedId]
    const s = addDelta(prevS, { model, profile, provider }, change)
    // The pane shows the conversation's latest route.
    s.model = model
    s.profile = profile
    s.provider = provider
    s.firstAt = prevS ? num(prevS.firstAt) || now : now
    s.lastAt = now
    sessions = pruneSessions({ ...sessions, [storedId]: s }, now)
  }

  return { ...led, days: pruned, rates, sessions, since, snapshots }
}

/** Rates for a legacy (v1, provider-less) bucket: its remembered rates, else a clearly borrowed price. */
function legacyPricer(payload, legacyRates) {
  return model => {
    const saved = legacyRates && legacyRates[model]
    if (validRates(saved)) return { origin: 'remembered', rates: saved }
    return resolveRates({ model, payload, provider: '', remembered: null })
  }
}

/**
 * Sum buckets over the days matching `filter`, one row per
 * profile+provider+model, plus totals for the range.
 */
function summarize(led, filter, priceLegacy) {
  const rows = {}
  for (const [date, buckets] of Object.entries(led.days)) {
    if (!filter(date) || !isObj(buckets)) continue
    for (const [key, b] of Object.entries(buckets)) {
      if (!isObj(b)) continue
      const r = rows[key] || (rows[key] = { ...newBucket(b), cost: b.legacy ? null : 0 })
      for (const f of ['input', 'output', 'cacheRead', 'cacheWrite', 'calls', 'pricedTokens', 'unpricedTokens', 'saved']) {
        r[f] += num(b[f])
      }
      if (!b.legacy) r.cost += num(b.cost)
      if (b.cacheEstimated) r.cacheEstimated = true
      if (b.foreignSlug) r.foreignSlug = b.foreignSlug
      for (const [s, n] of Object.entries(isObj(b.sources) ? b.sources : {})) r.sources[s] = num(r.sources[s]) + num(n)
    }
  }

  const totals = {
    cacheEstimated: false,
    cost: 0,
    foreignTokens: 0,
    known: false,
    legacyTokens: 0,
    prompt: 0,
    read: 0,
    saved: 0,
    unpricedTokens: 0
  }
  const list = Object.values(rows).map(r => {
    if (r.legacy) {
      const priced = priceLegacy ? priceLegacy(r.model) : null
      r.legacyOrigin = priced ? priced.origin : 'none'
      if (priced && priced.rates) {
        r.cost = costOf(r, priced.rates).total
        r.saved = cacheSavings(r.cacheRead, priced.rates)
        r.foreignSlug = priced.foreignSlug || null
      } else {
        r.unpricedTokens = tokensOf(r)
      }
      totals.legacyTokens += tokensOf(r)
    } else if (!r.pricedTokens) {
      r.cost = null
    }
    if (r.cost != null) {
      totals.cost += r.cost
      totals.known = true
    }
    totals.saved += num(r.saved)
    totals.read += num(r.cacheRead)
    totals.prompt += num(r.input) + num(r.cacheRead) + num(r.cacheWrite)
    totals.unpricedTokens += num(r.unpricedTokens)
    totals.foreignTokens += num(r.sources.foreign) + (r.legacy && r.legacyOrigin === 'foreign' ? tokensOf(r) : 0)
    if (r.cacheEstimated) totals.cacheEstimated = true
    return r
  })
  list.sort((a, b) => num(b.cost) - num(a.cost) || tokensOf(b) - tokensOf(a))
  totals.hitPct = totals.prompt ? (totals.read / totals.prompt) * 100 : null
  return { rows: list, totals }
}

const RANGES = {
  today: () => {
    const t = dayKey()
    return d => d === t
  },
  week: () => {
    const since = daysAgoKey(6)
    return d => d >= since
  },
  month: () => {
    const p = dayKey().slice(0, 7)
    return d => d.startsWith(p)
  },
  all: () => () => true
}

/* ----------------------------------------------------------------- export */

/** CSV cell: quoted when needed, and neutralised against spreadsheet formula injection. */
function csvCell(v) {
  if (v == null) return ''
  let s = String(v)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const CSV_COLUMNS = [
  'date', 'profile', 'provider', 'model', 'input', 'output', 'cache_read', 'cache_write', 'calls',
  'cost_usd', 'cost_basis', 'priced_tokens', 'unpriced_tokens', 'cache_saved_usd', 'cache_estimated'
]

function costBasis(b) {
  if (b.legacy) return 'legacy-unsettled'
  const keys = Object.keys(b.sources || {}).filter(k => num(b.sources[k]))
  return keys.sort().join('+') || 'none'
}

function ledgerCsv(led) {
  const lines = [CSV_COLUMNS.join(',')]
  for (const date of Object.keys(led.days).sort()) {
    const buckets = Object.values(led.days[date] || {}).sort((a, b) => String(a.model).localeCompare(String(b.model)))
    for (const b of buckets) {
      lines.push(
        [
          date, b.profile || '', b.provider || '', b.model, num(b.input), num(b.output), num(b.cacheRead),
          num(b.cacheWrite), num(b.calls), b.legacy || !num(b.pricedTokens) ? '' : Number(num(b.cost).toFixed(6)),
          costBasis(b), num(b.pricedTokens), num(b.unpricedTokens), b.legacy ? '' : Number(num(b.saved).toFixed(6)),
          b.cacheEstimated ? 'yes' : 'no'
        ]
          .map(csvCell)
          .join(',')
      )
    }
  }
  return `${lines.join('\r\n')}\r\n`
}

/* ---------------------------------------------------------------- runtime */

/** Live mirror of the persisted ledger so React re-renders on every commit. */
const $ledger = atom(emptyLedger())
const $range = atom('today')
/** Last storage write failure (null when the latest write succeeded). */
const $storageError = atom(null)
let storage = null
/** ctx.os (curated OS door) — absent on older app builds. */
let osApi = null

function saveLedger(next) {
  $ledger.set(next)
  if (!storage) return
  try {
    storage.set(LEDGER_KEY, next)
    if ($storageError.get()) $storageError.set(null)
  } catch (err) {
    const message = String((err && err.message) || err)
    if (!$storageError.get()) {
      try {
        host.notify({ kind: 'warning', message: `Token & Cost Meter: ledger not saved (${message})` })
      } catch {
        /* notify is best-effort */
      }
    }
    $storageError.set(message)
  }
}

function catalogQuery(sessionId) {
  return {
    queryFn: () => host.request('model.options', sessionId ? { session_id: sessionId } : {}),
    queryKey: [ID, 'model-options', sessionId || 'global'],
    retry: 1,
    staleTime: CATALOG_STALE_MS
  }
}

/** The session's model.options payload (cached; stale data beats none on error). */
async function getCatalog(sessionId) {
  const q = catalogQuery(sessionId)
  try {
    return await queryClient.fetchQuery(q)
  } catch {
    return queryClient.getQueryData(q.queryKey) ?? null
  }
}

/**
 * Owner profile of a session. Exact for the focused chat; other sessions fall
 * back to the gateway socket's profile (the SDK exposes no per-session owner).
 */
function profileFor(sessionId) {
  try {
    if (sessionId && sessionId === host.state.focusedSessionId.get()) {
      return host.state.focusedSessionProfile.get() || host.state.profile.get() || ''
    }
    return host.state.profile.get() || ''
  } catch {
    return ''
  }
}

/**
 * Live (runtime) session id -> durable stored session id. Runtime ids change
 * every time a conversation is resumed; stored ids don't, so per-conversation
 * totals are keyed by the latter. Learned whenever a session is focused.
 */
const storedIds = new Map()

function learnStoredId() {
  try {
    const sid = host.state.focusedSessionId.get()
    const stored = host.state.focusedStoredSessionId.get()
    if (sid && stored) storedIds.set(sid, stored)
  } catch {
    /* older hosts: no stored id, per-conversation totals just stay empty */
  }
}

function storedIdFor(sessionId) {
  learnStoredId()
  return storedIds.get(sessionId) || ''
}

/** Per-session serial queue: readings for one session commit in arrival order. */
const chains = new Map()

function enqueueUsage(sessionId, usage) {
  if (!sessionId || !usage) return null
  const snapshot = { ...usage }
  const profile = profileFor(sessionId)
  const storedId = storedIdFor(sessionId)
  const prev = chains.get(sessionId) || Promise.resolve()
  const run = prev
    .then(async () => {
      const payload = await getCatalog(sessionId)
      const provider = payload && typeof payload.provider === 'string' ? payload.provider : ''
      const led = $ledger.get()
      const next = applyUsage(led, { payload, profile, provider, sessionId, storedId, usage: snapshot })
      if (next !== led) saveLedger(next)
    })
    .catch(err => console.warn(`[${ID}] usage not recorded:`, err))
  chains.set(sessionId, run)
  run.finally(() => {
    if (chains.get(sessionId) === run) chains.delete(sessionId)
  })
  return run
}

async function writeClipboard(text) {
  try {
    if (osApi && typeof osApi.writeClipboard === 'function' && (await osApi.writeClipboard(text))) return true
  } catch {
    /* fall through */
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the desktop bridge */
  }
  try {
    const bridge = typeof window !== 'undefined' && window.hermesDesktop
    if (bridge && typeof bridge.writeClipboard === 'function') {
      await bridge.writeClipboard(text)
      return true
    }
  } catch {
    /* no clipboard */
  }
  return false
}

async function exportLedger(kind, t) {
  const led = $ledger.get()
  const text =
    kind === 'csv' ? ledgerCsv(led) : JSON.stringify({ exportedAt: new Date().toISOString(), ledger: led }, null, 2)
  if (kind === 'json-copy') {
    const ok = await writeClipboard(text)
    host.notify({ kind: ok ? 'success' : 'error', message: ok ? t('copied') : t('exportFailed') })
    return
  }
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `token-cost-ledger-${dayKey()}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  } catch {
    const ok = await writeClipboard(text)
    host.notify({ kind: ok ? 'info' : 'error', message: ok ? t('csvCopied') : t('exportFailed') })
  }
}

/* ------------------------------------------------------------- side pane */

/**
 * Side-pane placement. Docked as a tab beside the core Files pane, so it shares
 * that zone and the title bar's right-sidebar toggle shows/hides it like Files.
 * The dock is only a first-adoption hint: if Files is absent, the host falls
 * back to any right-placed zone, and a user's own drag is kept on later boots.
 */
const PANE_DATA = { placement: 'right', width: '268px', dock: { pane: 'files', pos: 'center' } }

/* ---------------------------------------------------------------- routing */

/** Last app route that wasn't the ledger page — where "close" goes back to. */
let returnTo = null

function currentRoute() {
  return (typeof window !== 'undefined' && window.location.hash.slice(1)) || '/'
}

function isLedgerRoute(route) {
  return route === LEDGER_ROUTE || route.startsWith(`${LEDGER_ROUTE}?`) || route.startsWith(`${LEDGER_ROUTE}/`)
}

function rememberRoute() {
  const route = currentRoute()
  if (!isLedgerRoute(route)) returnTo = route
}

/** Entering the page from anywhere: the route we LEFT is the one to return to. */
function onHashChange(e) {
  const old = e && typeof e.oldURL === 'string' && e.oldURL.includes('#') ? e.oldURL.split('#').slice(1).join('#') || '/' : null
  if (old && !isLedgerRoute(old) && isLedgerRoute(currentRoute())) returnTo = old
  else rememberRoute()
}

function openLedger() {
  rememberRoute()
  host.navigate(LEDGER_ROUTE)
}

function closeLedger() {
  const target = returnTo && !isLedgerRoute(returnTo) ? returnTo : '/'
  host.navigate(target)
}

/* ------------------------------------------------------------------ hooks */

const $none = atom(null)

/** The focused session's live numbers, priced with ITS provider's catalog. */
function useLive() {
  const sessionId = useValue(host.state.focusedSessionId)
  const storedId = useValue(host.state.focusedStoredSessionId || $none)
  const rawUsage = useValue(host.state.focusedUsage)
  const stateModel = useValue(host.state.model)
  const led = useValue($ledger)
  const { data: payload, error, isLoading } = useQuery({ ...catalogQuery(sessionId), refetchInterval: 15 * 60 * 1000 })

  // After a restart the host seeds the focused session with an all-zero usage
  // object; treat that as "nothing yet" so the UI falls back to the ledger.
  const usage =
    rawUsage && (num(rawUsage.input) || num(rawUsage.output) || num(rawUsage.total) || num(rawUsage.calls))
      ? rawUsage
      : null

  const provider = payload && typeof payload.provider === 'string' ? payload.provider : ''
  const model = (usage && usage.model) || (payload && payload.model) || stateModel || ''
  const resolved = resolveRates({ model, payload, provider, remembered: led.rates })
  const bucket = usage ? readUsage(usage) : null
  const computed = costOf(bucket, resolved.rates)
  const backendCost =
    usage && typeof usage.cost_usd === 'number' && usage.cost_usd > 0 ? usage.cost_usd : null

  const gatewayHit = usage && typeof usage.cache_hit_pct === 'number' ? usage.cache_hit_pct : null

  // The conversation's recorded total (all runs, survives restarts). It is
  // written on every usage tick, so while a run is live it already includes
  // it; prefer it whenever it exists and isn't behind the live counters.
  const hist = storedId && led.sessions ? led.sessions[storedId] : null
  if (hist && tokensOf(hist) && (!bucket || tokensOf(hist) >= tokensOf(bucket))) {
    const kinds = Object.keys(hist.sources || {}).filter(k => num(hist.sources[k]))
    const histSource = !hist.pricedTokens ? 'none' : kinds.length === 1 ? kinds[0] : 'mixed'
    const histModel = hist.model || model
    const histRates = usage ? resolved : resolveRates({ model: histModel, payload, provider: hist.provider || provider, remembered: led.rates })
    return {
      bucket: hist,
      cacheHitPct: hitPctOf(hist),
      cost: hist.pricedTokens ? hist.cost : null,
      costSource: histSource,
      foreignSlug: hist.foreignSlug || resolved.foreignSlug,
      fromHistory: !usage,
      model: (usage && usage.model) || histModel,
      partial: num(hist.unpricedTokens) > 0 && num(hist.pricedTokens) > 0,
      pricingError: error ? String(error.message || error) : null,
      pricingLoading: isLoading,
      provider: provider || hist.provider || null,
      providerUnknown: !(provider || hist.provider),
      rates: histRates.rates,
      saved: hist.saved,
      sinceAt: hist.firstAt,
      usage
    }
  }

  return {
    bucket,
    cacheHitPct: gatewayHit != null ? gatewayHit : bucket ? hitPctOf(bucket) : null,
    cost: backendCost != null ? backendCost : computed ? computed.total : null,
    costSource: backendCost != null ? 'gateway' : computed ? resolved.origin : 'none',
    foreignSlug: resolved.foreignSlug,
    model,
    pricingError: error ? String(error.message || error) : null,
    pricingLoading: isLoading,
    provider: provider || null,
    providerUnknown: !provider,
    rates: resolved.rates,
    saved: bucket && resolved.rates ? cacheSavings(bucket.cacheRead, resolved.rates) : null,
    usage
  }
}

/** Ledger summary for a range, legacy rows priced against the global catalog. */
function useSummary(range) {
  const led = useValue($ledger)
  const { data: payload } = useQuery(catalogQuery(null))
  return summarize(led, RANGES[range](), legacyPricer(payload, led.legacyRates))
}

/* --------------------------------------------------------------------- UI */

function fmtDate(ms) {
  const d = new Date(num(ms))
  if (Number.isNaN(d.getTime())) return '—'
  const p2 = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

function sourceLabel(t, origin, foreignSlug, providerUnknown) {
  if (origin === 'foreign') return providerUnknown ? t('src_unconfirmed', foreignSlug || '?') : t('src_foreign', foreignSlug || '?')
  return t(`src_${origin}`)
}

function Chip() {
  const t = usePluginI18n(ID)
  const live = useLive()
  const today = useSummary('today').totals
  const open = openLedger
  const todayText = today.known ? `${t('today')} ${fmtUsd(today.cost)}${today.unpricedTokens ? '+' : ''}` : null

  if (!live.bucket) {
    return jsx(Tip, {
      label: t('chipTipIdle'),
      children: jsx('button', {
        className: cn(
          'inline-flex h-full items-center px-1.5 text-[0.6875rem] transition-colors',
          'text-(--ui-text-quaternary) hover:bg-(--chrome-action-hover) hover:text-foreground'
        ),
        onClick: open,
        type: 'button',
        children: todayText || t('idle')
      })
    })
  }

  const warn = live.costSource === 'foreign' || live.costSource === 'none'
  return jsx(Tip, {
    label: t(
      'chipTip',
      live.model || '—',
      sourceLabel(t, live.costSource, live.foreignSlug, live.providerUnknown),
      fmtUsd(today.cost),
      live.cacheHitPct != null ? `${Math.round(live.cacheHitPct)}%` : '—',
      live.saved != null ? `${live.bucket && live.bucket.cacheEstimated ? '≈' : ''}${fmtUsd(live.saved)}` : '—'
    ),
    children: jsxs('button', {
      className: cn(
        'inline-flex h-full items-center gap-1.5 px-1.5 text-[0.6875rem] transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      onClick: open,
      type: 'button',
      children: [
        jsx('span', { children: `${fmtTokens(live.bucket.input)}↑ ${fmtTokens(live.bucket.output)}↓` }),
        jsx('span', { className: 'text-(--ui-text-quaternary)', children: '·' }),
        jsx('span', {
          className: live.cost == null ? 'text-(--ui-text-quaternary)' : warn ? 'text-(--ui-warning)' : 'text-(--ui-accent)',
          children: live.cost == null ? t('noPrice') : `${warn ? '⚠ ' : ''}${fmtUsd(live.cost)}`
        }),
        live.cacheHitPct != null
          ? jsx('span', { className: 'text-(--ui-text-quaternary)', children: `· ⚡${Math.round(live.cacheHitPct)}%` })
          : null,
        todayText ? jsx('span', { className: 'text-(--ui-text-quaternary)', children: `· ${todayText}` }) : null
      ].filter(Boolean)
    })
  })
}

/** Thin proportional bar: cached (accent) vs fresh (muted) prompt tokens. */
function CacheBar({ pct }) {
  const clamped = Math.max(0, Math.min(100, pct))
  return jsx('div', {
    className: 'h-1 w-full overflow-hidden rounded-full bg-(--ui-fill-tertiary)',
    children: jsx('div', {
      className: 'h-full rounded-full bg-(--ui-accent) transition-[width] duration-500',
      style: { width: `${clamped}%` }
    })
  })
}

function Row({ dim, label, value }) {
  return jsxs('div', {
    className: 'flex items-baseline justify-between gap-3 tabular-nums',
    children: [
      jsx('span', { className: 'min-w-0 truncate text-(--ui-text-tertiary)', children: label }),
      jsx('span', { className: cn('shrink-0', dim && 'text-(--ui-text-quaternary)'), children: value })
    ]
  })
}

function Section({ children, title }) {
  return jsxs('div', {
    className: 'flex flex-col gap-1',
    children: [
      jsx('div', { className: 'text-[0.625rem] tracking-wide text-(--ui-text-quaternary) uppercase', children: title }),
      jsx('div', { className: 'flex flex-col gap-0.5 text-xs', children })
    ]
  })
}

function Note({ children, warn }) {
  return jsx('div', {
    className: cn('text-[0.6875rem] leading-relaxed', warn ? 'text-(--ui-warning)' : 'text-(--ui-text-quaternary)'),
    children
  })
}

/** Caveats for a range summary — shown wherever a total is shown. */
function rangeNotes(t, totals, storageError) {
  const notes = []
  if (storageError) notes.push(jsx(Note, { warn: true, children: t('storageError', storageError) }, 'st'))
  if (totals.unpricedTokens) notes.push(jsx(Note, { warn: true, children: t('unpricedNote', fmtTokens(totals.unpricedTokens)) }, 'up'))
  if (totals.foreignTokens) notes.push(jsx(Note, { warn: true, children: t('foreignNote', fmtTokens(totals.foreignTokens)) }, 'fo'))
  if (totals.legacyTokens) notes.push(jsx(Note, { children: t('legacyNote', fmtTokens(totals.legacyTokens)) }, 'lg'))
  if (totals.cacheEstimated) notes.push(jsx(Note, { children: t('cacheEstNote') }, 'ce'))
  return notes
}

/** Right-hand pane: the focused session only. Range totals live on the ledger page. */
function Meter() {
  const t = usePluginI18n(ID)
  const live = useLive()
  const storageError = useValue($storageError)
  const sections = []

  if (live.bucket) {
    const u = live.usage
    const b = live.bucket
    const approx = b.cacheEstimated ? '≈' : ''
    const warn = live.costSource === 'foreign' || live.costSource === 'none'
    sections.push(
      jsxs(
        'div',
        {
          className: 'flex flex-col gap-2',
          children: [
            jsxs('div', {
              className: 'flex items-center justify-between gap-2',
              children: [
                jsx('div', { className: 'truncate text-sm font-medium', children: live.model || '—' }),
                jsx(Tip, {
                  label: live.provider ? t('providerTip', live.provider) : t('providerUnknownTip'),
                  children: jsx(Badge, { variant: 'muted', children: live.provider || t('providerUnknown') })
                })
              ]
            }),
            jsxs('div', {
              className: 'flex flex-wrap items-baseline gap-x-2',
              children: [
                jsx('div', {
                  className: 'text-2xl font-semibold tabular-nums text-(--ui-accent)',
                  children: live.cost == null ? '—' : fmtUsd(live.cost)
                }),
                jsx('span', {
                  className: cn('text-[0.625rem]', warn ? 'text-(--ui-warning)' : 'text-(--ui-text-quaternary)'),
                  children: sourceLabel(t, live.costSource, live.foreignSlug, live.providerUnknown)
                })
              ]
            }),
            jsx(Section, {
              title: t('sessionTokens'),
              children: [
                jsx(Row, { label: t('input'), value: `${approx}${fmtTokens(b.input)}` }, 'i'),
                jsx(Row, { label: t('output'), value: fmtTokens(b.output) }, 'o'),
                b.cacheRead ? jsx(Row, { dim: true, label: t('cacheRead'), value: `${approx}${fmtTokens(b.cacheRead)}` }, 'cr') : null,
                b.cacheWrite ? jsx(Row, { dim: true, label: t('cacheWrite'), value: `${approx}${fmtTokens(b.cacheWrite)}` }, 'cw') : null,
                jsx(Row, { label: t('total'), value: fmtTokens(tokensOf(b)) }, 'tt'),
                jsx(Row, { dim: true, label: t('calls'), value: String(b.calls ?? 0) }, 'c'),
                u && typeof u.context_percent === 'number'
                  ? jsx(Row, {
                      dim: true,
                      label: t('context'),
                      value: `${Math.round(u.context_percent)}% · ${fmtTokens(u.context_used)}/${fmtTokens(u.context_max)}`
                    }, 'ctx')
                  : null
              ].filter(Boolean)
            }),
            live.sinceAt
              ? jsx(Note, { children: t(live.fromHistory ? 'historyNote' : 'cumulativeNote', fmtDate(live.sinceAt)) }, 'hist')
              : null,
            live.partial ? jsx(Note, { warn: true, children: t('unpricedNote', fmtTokens(b.unpricedTokens)) }, 'up') : null,
            live.cacheHitPct != null
              ? jsx(Section, {
                  title: t('cacheTitle'),
                  children: [
                    jsx(Row, { label: t('hitRate'), value: `${Math.round(live.cacheHitPct)}%` }, 'hr'),
                    jsx('div', { className: 'py-1', children: jsx(CacheBar, { pct: live.cacheHitPct }) }, 'bar'),
                    live.saved != null ? jsx(Row, { label: t('saved'), value: `${approx}${fmtUsd(live.saved)}` }, 'sv') : null,
                    b.cacheEstimated ? jsx(Note, { children: t('cacheEstNote') }, 'est') : null
                  ].filter(Boolean)
                })
              : null,
            live.rates
              ? jsx(Section, {
                  title: t('rates'),
                  children: [
                    jsx(Row, { dim: true, label: t('input'), value: `$${live.rates.input}` }, 'ri'),
                    jsx(Row, { dim: true, label: t('output'), value: `$${live.rates.output}` }, 'ro'),
                    jsx(Row, { dim: true, label: t('cacheRead'), value: `$${live.rates.cache}` }, 'rc')
                  ]
                })
              : jsx(Note, {
                  children: live.pricingLoading ? t('loadingPrice') : live.pricingError || t('noPriceLong')
                })
          ].filter(Boolean)
        },
        'live'
      )
    )
  } else {
    sections.push(jsx(Note, { children: t('empty') }, 'live'))
  }

  if (storageError) sections.push(jsx(Note, { warn: true, children: t('storageError', storageError) }, 'st'))

  return jsx('div', { className: 'flex h-full flex-col gap-3 overflow-auto p-3', children: sections })
}

/* -------------------------------------------------------------- full page */

function rowBasis(t, r) {
  if (r.legacy) return t('basisLegacy')
  const kinds = Object.keys(r.sources).filter(k => num(r.sources[k]))
  if (!kinds.length) return t('src_none')
  if (kinds.length > 1) return t('basisMixed')
  return kinds[0] === 'foreign' ? t('src_foreign', r.foreignSlug || '?') : t(`src_${kinds[0]}`)
}

function LedgerPage() {
  const t = usePluginI18n(ID)
  const led = useValue($ledger)
  const range = useValue($range)
  const storageError = useValue($storageError)
  const { rows, totals } = useSummary(range)
  const dayCount = Object.keys(led.days).length

  // Esc closes the page, unless the user is typing somewhere.
  useEffect(() => {
    const onKey = e => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const el = e.target
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
      if (document.querySelector('[role="dialog"]')) return
      closeLedger()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const cells = r => {
    const pct = hitPctOf(r)
    const approx = r.cacheEstimated ? '≈' : ''
    const warn = r.legacy ? r.legacyOrigin === 'foreign' : num(r.sources.foreign) || r.unpricedTokens
    return [
      jsxs('td', {
        className: 'py-1.5 pr-3',
        children: [
          jsx('div', { children: r.model }),
          jsx('div', {
            className: 'text-[0.625rem] text-(--ui-text-quaternary)',
            children: [r.profile, r.provider || (r.legacy ? null : t('providerUnknown'))].filter(Boolean).join(' · ') || null
          })
        ]
      }),
      jsx('td', { className: 'py-1.5 pr-3 text-right tabular-nums', children: `${approx}${fmtTokens(r.input)}` }),
      jsx('td', { className: 'py-1.5 pr-3 text-right tabular-nums', children: fmtTokens(r.output) }),
      jsx('td', { className: 'py-1.5 pr-3 text-right tabular-nums text-(--ui-text-tertiary)', children: `${approx}${fmtTokens(r.cacheRead)}` }),
      jsx('td', { className: 'py-1.5 pr-3 text-right tabular-nums text-(--ui-text-tertiary)', children: String(r.calls) }),
      jsx('td', { className: 'py-1.5 pr-3 text-right tabular-nums', children: pct == null ? '—' : `${approx}${Math.round(pct)}%` }),
      jsx('td', { className: 'py-1.5 pr-3 text-right tabular-nums text-(--ui-accent)', children: r.saved ? `${approx}${fmtUsd(r.saved)}` : '—' }),
      jsxs('td', {
        className: 'py-1.5 text-right tabular-nums',
        children: [
          jsx('div', { children: r.cost == null ? '—' : `${r.unpricedTokens && r.cost != null ? '≥' : ''}${fmtUsd(r.cost)}` }),
          jsx('div', {
            className: cn('text-[0.625rem]', warn ? 'text-(--ui-warning)' : 'text-(--ui-text-quaternary)'),
            children: rowBasis(t, r)
          })
        ]
      })
    ]
  }

  const head = ['modelCol', 'input', 'output', 'cacheRead', 'calls', 'hitRate', 'saved', 'cost'].map((k, i) =>
    jsx('th', {
      className: cn('pb-1.5 font-medium text-(--ui-text-quaternary)', i === 0 ? 'pr-3 text-left' : 'pr-3 text-right', k === 'cost' && 'pr-0'),
      children: t(k)
    }, k)
  )

  return jsxs('div', {
    className: 'mx-auto flex w-full max-w-3xl flex-col gap-4 p-6',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center justify-between gap-3',
        children: [
          jsx('h1', { className: 'text-base font-semibold', children: t('pageTitle') }),
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx(SegmentedControl, {
                onChange: v => $range.set(v),
                options: ['today', 'week', 'month', 'all'].map(id => ({ id, label: t(`range_${id}`) })),
                value: range
              }),
              jsx(Tip, {
                label: t('closeTip'),
                children: jsx(Button, {
                  'aria-label': t('close'),
                  onClick: closeLedger,
                  size: 'icon-sm',
                  variant: 'ghost',
                  children: jsx(Codicon, { name: 'close' })
                })
              })
            ]
          })
        ]
      }),
      jsxs('div', {
        className: 'flex flex-wrap items-baseline gap-2',
        children: [
          jsx('div', {
            className: 'text-3xl font-semibold tabular-nums text-(--ui-accent)',
            children: totals.known ? `${totals.unpricedTokens ? '≥' : ''}${fmtUsd(totals.cost)}` : '—'
          }),
          jsx('span', { className: 'text-xs text-(--ui-text-quaternary)', children: t('grandHint') })
        ]
      }),
      jsx('div', {
        className: 'text-xs text-(--ui-text-tertiary)',
        children: led.since ? t('coverage', led.since, dayCount, KEEP_DAYS) : t('coverageNone')
      }),
      totals.hitPct != null
        ? jsxs('div', {
            className: 'flex flex-col gap-1.5',
            children: [
              jsxs('div', {
                className: 'flex items-baseline justify-between text-xs text-(--ui-text-tertiary)',
                children: [
                  jsx('span', { children: `${t('hitRate')} ${totals.cacheEstimated ? '≈' : ''}${Math.round(totals.hitPct)}%` }),
                  jsx('span', { children: `${t('savedTotal')} ${totals.cacheEstimated ? '≈' : ''}${fmtUsd(totals.saved)}` })
                ]
              }),
              jsx(CacheBar, { pct: totals.hitPct })
            ]
          })
        : null,
      ...rangeNotes(t, totals, storageError),
      rows.length
        ? jsxs('table', {
            className: 'w-full text-xs',
            children: [
              jsx('thead', { children: jsx('tr', { children: head }) }),
              jsx('tbody', {
                children: rows.map((r, i) =>
                  jsx('tr', { className: 'border-b border-(--ui-stroke-secondary) align-top', children: cells(r) }, `${i}`)
                )
              })
            ]
          })
        : jsx('div', {
            className: 'rounded-md border border-(--ui-stroke-secondary) p-6 text-center text-xs text-(--ui-text-quaternary)',
            children: t('noLedger')
          }),
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2',
        children: [
          jsx(Button, { disabled: !dayCount, onClick: () => exportLedger('csv', t), size: 'sm', variant: 'outline', children: t('exportCsv') }),
          jsx(Button, { disabled: !dayCount, onClick: () => exportLedger('json-copy', t), size: 'sm', variant: 'ghost', children: t('copyJson') })
        ]
      }),
      jsx('p', { className: 'text-[0.6875rem] leading-relaxed text-(--ui-text-quaternary)', children: t('disclaimer') })
    ].filter(Boolean)
  })
}

/* ------------------------------------------------------------------- i18n */

const I18N = {
  en: {
    basisLegacy: 'pre-1.0 data · at current rates',
    basisMixed: 'mixed rate sources',
    cacheEstNote: '≈ Cached volume is derived from the gateway’s rounded hit rate; the cache split and savings are estimates.',
    cacheRead: 'Cache read',
    cacheTitle: 'Prompt cache',
    cacheWrite: 'Cache write',
    close: 'Close',
    closeTip: 'Close (Esc)',
    calls: 'Calls',
    chipTip: (model, source, today, hit, saved) =>
      `${model} — cost ${source}. Today ${today}. Cache hit ${hit}, saved ${saved} this session. Click for details.`,
    chipTipIdle: 'Token & cost ledger — click for details',
    context: 'Context',
    copied: 'Ledger JSON copied to the clipboard.',
    copyJson: 'Copy JSON',
    cost: 'Cost',
    coverage: (since, n, keep) => `Recorded since ${since} · ${n} day(s) with usage · daily totals kept ${keep} days`,
    coverageNone: 'Nothing recorded yet.',
    csvCopied: 'Download unavailable — CSV copied to the clipboard instead.',
    disclaimer:
      'Estimates. Costs are settled when usage is recorded, from the serving provider’s catalog $/Mtok (or the bundled models.dev table), not a billing API; subscription routes (Copilot, Nous credits) bill differently. The ledger is stored locally and only records usage seen while the plugin was running.',
    empty: 'No usage recorded for this conversation yet — it appears after the next reply.',
    historyNote: d => `Conversation total since ${d}, across restarts. New replies keep adding to it.`,
    cumulativeNote: d => `Conversation total since ${d}, including earlier runs.`,
    exportCsv: 'Export CSV',
    exportFailed: 'Export failed.',
    foreignNote: n => `⚠ ${n} tokens were priced with another provider’s rates — they may not match your route.`,
    grandHint: 'estimated, settled at record time',
    hitRate: 'Hit rate',
    idle: 'tokens —',
    input: 'Input',
    legacyNote: n => `${n} tokens come from the pre-1.0 ledger, which stored no provider or price; they are estimated at current rates and may change.`,
    loadingPrice: 'Loading pricing…',
    modelCol: 'Model',
    navLabel: 'Tokens & Cost',
    noLedger: 'Nothing recorded in this range. Usage is folded in as turns complete.',
    noPrice: 'n/a',
    noPriceLong: 'No rate for this model in the provider catalog or the bundled models.dev table. Run scripts/gen-rates.py to refresh it.',
    output: 'Output',
    pageTitle: 'Token & Cost Ledger',
    providerTip: slug => `Serving provider: ${slug}`,
    providerUnknown: 'provider ?',
    providerUnknownTip: 'The serving provider could not be confirmed — any price shown is borrowed.',
    range_all: 'All recorded',
    range_month: 'This month',
    range_today: 'Today',
    range_week: '7 days',
    rates: 'Rates ($/Mtok)',
    saved: 'Saved',
    savedTotal: 'Saved by cache',
    sessionTokens: 'This session',
    src_bundled: 'estimated from models.dev rates',
    src_foreign: slug => `⚠ rates borrowed from ${slug} — may not match your route`,
    src_gateway: 'reported by gateway',
    src_live: 'computed from catalog pricing',
    src_none: 'pricing unavailable',
    src_mixed: 'mixed pricing sources',
    src_remembered: 'remembered catalog rates',
    src_unconfirmed: slug => `⚠ provider unconfirmed — rates borrowed from ${slug}`,
    storageError: msg => `⚠ The ledger could not be saved (${msg}). New usage is kept only until Hermes restarts.`,
    today: 'today',
    total: 'Total',
    unpricedNote: n => `${n} tokens had no known rate and are not in the total (shown as ≥).`
  },
  zh: {
    basisLegacy: '1.0 前旧数据 · 按现价估算',
    basisMixed: '多种价格来源',
    cacheEstNote: '≈ 缓存量由网关取整后的命中率推算，缓存拆分与节省额均为估算。',
    cacheRead: '缓存读取',
    cacheTitle: '提示词缓存',
    cacheWrite: '缓存写入',
    close: '关闭',
    closeTip: '关闭（Esc）',
    calls: '调用',
    chipTip: (model, source, today, hit, saved) =>
      `${model} — 费用${source}。今日 ${today}。缓存命中 ${hit}，本次会话节省 ${saved}。点击查看明细。`,
    chipTipIdle: '令牌与花费账本 — 点击查看明细',
    context: '上下文',
    copied: '账本 JSON 已复制到剪贴板。',
    copyJson: '复制 JSON',
    cost: '花费',
    coverage: (since, n, keep) => `自 ${since} 起记录 · 有用量的天数 ${n} · 按日汇总保留 ${keep} 天`,
    coverageNone: '尚无记录。',
    csvCopied: '无法下载，已改为把 CSV 复制到剪贴板。',
    disclaimer:
      '仅为估算。金额在记录用量时按实际承载线路的目录单价（或内置 models.dev 价格表）结算，并非账单接口；订阅制线路（Copilot、Nous 额度等）的实际计费不同。账本保存在本地，且只记录插件运行期间观察到的用量。',
    empty: '这个会话还没有记录到用量，下一次回复后会显示。',
    historyNote: d => `自 ${d} 起的会话累计（重启后保留），继续对话会接着累加。`,
    cumulativeNote: d => `自 ${d} 起的会话累计，包含之前的运行。`,
    exportCsv: '导出 CSV',
    exportFailed: '导出失败。',
    foreignNote: n => `⚠ 有 ${n} 令牌借用了其他供应商的价格，可能与你的线路不符。`,
    grandHint: '估算值，记录时结算',
    hitRate: '命中率',
    idle: '令牌 —',
    input: '输入',
    legacyNote: n => `有 ${n} 令牌来自 2.0 之前的账本，当时没有记录供应商和价格，现按当前单价估算，数值可能变化。`,
    loadingPrice: '正在加载价格…',
    modelCol: '模型',
    navLabel: '令牌与花费',
    noLedger: '该区间没有记录。每轮对话结束后会自动累加。',
    noPrice: '无',
    noPriceLong: '供应商目录与内置 models.dev 价格表中都没有该模型。可运行 scripts/gen-rates.py 刷新价格表。',
    output: '输出',
    pageTitle: '令牌与花费账本',
    providerTip: slug => `实际承载线路：${slug}`,
    providerUnknown: '供应商未知',
    providerUnknownTip: '无法确认实际承载的供应商——显示的价格均为借用。',
    range_all: '全部记录',
    range_month: '本月',
    range_today: '今日',
    range_week: '近 7 天',
    rates: '单价（$/百万令牌）',
    saved: '已节省',
    savedTotal: '缓存节省',
    sessionTokens: '本次会话',
    src_bundled: '按 models.dev 单价估算',
    src_foreign: slug => `⚠ 借用了 ${slug} 的价格，可能与你的线路不符`,
    src_gateway: '来自网关',
    src_live: '按目录价格计算',
    src_none: '价格不可用',
    src_mixed: '多种计价来源',
    src_remembered: '历史目录价格',
    src_unconfirmed: slug => `⚠ 供应商未确认，借用了 ${slug} 的价格`,
    storageError: msg => `⚠ 账本保存失败（${msg}）。新用量只保留到 Hermes 重启前。`,
    today: '今日',
    total: '合计',
    unpricedNote: n => `有 ${n} 令牌没有可用单价，未计入总额（显示为 ≥）。`
  }
}

/* --------------------------------------------------------------- register */

export default {
  id: ID,
  name: 'Token & Cost Meter',
  description: 'Live token usage and model-aware cost, with a persistent per-day ledger.',
  register(ctx) {
    storage = ctx.storage
    osApi = ctx.os || null
    const { ledger, migrated } = readStoredLedger(ctx.storage)
    $ledger.set(ledger)
    if (migrated) saveLedger(ledger)
    $range.set(ctx.storage.get('range', 'today'))
    ctx.onDispose($range.listen(v => ctx.storage.set('range', v)))
    ctx.onDispose(() => {
      storage = null
      osApi = null
      chains.clear()
      storedIds.clear()
    })

    ctx.i18n.register(I18N)

    // Remember where the user came from however they reach the page
    // (status chip, sidebar nav, palette), so "close" returns there.
    rememberRoute()
    window.addEventListener('hashchange', onHashChange)
    ctx.onDispose(() => window.removeEventListener('hashchange', onHashChange))

    // --- ledger intake -------------------------------------------------
    // message.complete carries the authoritative final usage of a turn;
    // session.usage is the mid-turn tick (applyUsage no-ops on a zero delta).
    const intake = event => {
      const usage = event && event.payload && event.payload.usage
      if (usage && event.session_id) enqueueUsage(event.session_id, usage)
    }
    ctx.onEvent('message.complete', intake)
    ctx.onEvent('session.usage', intake)
    learnStoredId()
    if (host.state.focusedStoredSessionId) {
      ctx.onDispose(host.state.focusedSessionId.listen(learnStoredId))
      ctx.onDispose(host.state.focusedStoredSessionId.listen(learnStoredId))
    }

    // Safety net: fold the focused session's live numbers on a slow timer.
    ctx.setInterval(() => {
      const sid = host.state.focusedSessionId.get()
      const usage = host.state.focusedUsage.get()
      if (sid && usage) enqueueUsage(sid, usage)
    }, 30_000)

    // --- UI ------------------------------------------------------------
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'tokens & cost',
      data: PANE_DATA,
      render: () => jsx(Meter, {})
    })
    ctx.register({ id: 'chip', area: 'statusBar.right', order: 120, render: () => jsx(Chip, {}) })
    ctx.register({
      id: 'page',
      area: 'routes',
      title: 'Token & Cost Ledger',
      data: { path: LEDGER_ROUTE },
      render: () => jsx(LedgerPage, {})
    })
    ctx.register({
      id: 'nav',
      area: 'sidebar.nav',
      data: { codicon: 'graph', label: 'Tokens & Cost', path: LEDGER_ROUTE }
    })
  }
}

/** Pure internals, exported for the node test-suite (the host only reads `default`). */
export const __test = {
  PANE_DATA,
  applyUsage,
  bundledLookup,
  csvCell,
  daysAgoKey,
  dayKey,
  emptyLedger,
  enqueueUsage,
  findPricing,
  closeLedger,
  isLedgerRoute,
  ledgerCsv,
  onHashChange,
  openLedger,
  legacyPricer,
  migrateV1,
  readStoredLedger,
  readUsage,
  resolveRates,
  summarize,
  $ledger
}
