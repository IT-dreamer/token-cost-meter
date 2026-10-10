/**
 * token-cost-meter — live token usage + model-aware USD cost, with a
 * persistent local ledger that survives restarting Hermes.
 *
 * Live  : host.state.focusedUsage (streamed UsageStats, no RPC)
 * Prices: host.request('model.options') -> pricing[model] = {input,output,cache}
 *         as "$/Mtok" strings ("free", "" = unknown). Last-known rates are
 *         persisted so costs still render when the catalog is unreachable.
 * Ledger: ctx.storage (namespaced persistence). The gateway's in-memory session
 *         counters reset on restart, so we fold them into per-day / per-model
 *         totals as they arrive, using per-session delta snapshots.
 */

import {
  atom,
  Badge,
  cn,
  host,
  SegmentedControl,
  Tip,
  usePluginI18n,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'token-cost-meter'
const LEDGER_KEY = 'ledger.v1'
const KEEP_DAYS = 120

/* ------------------------------------------------------------------ utils */

/** "$3.00" | "3.00" | "free" | "" | "?" -> number ($ per 1M tokens) or null */
function parseRate(text) {
  if (text == null) return null
  const s = String(text).trim()
  if (!s || s === '?') return null
  if (s.toLowerCase() === 'free') return 0
  const n = Number.parseFloat(s.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : null
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
  const d = ts ? new Date(ts) : new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

const EMPTY_BUCKET = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 })

/* ---------------------------------------------------------------- pricing */

/**
 * Bundled fallback rates, generated from the models.dev catalog by
 * scripts/gen-rates.py in this folder (the desktop plugin loader forbids
 * relative imports, so the table is inlined).
 *
 * WHY this exists: Hermes only fetches LIVE pricing for openrouter / nous /
 * ai-gateway / novita / deepinfra / fireworks / kilocode
 * (hermes_cli/models_pricing.py::_PRICING_FETCHERS). Every other provider —
 * notably subscription/OAuth routes like github-copilot — gets `pricing: {}`
 * in `model.options`, so without this table the pane says "pricing
 * unavailable" even though models.dev knows the rates.
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

/** Look the model up in the bundled table. Prefers the active provider. */
function fallbackRates(model, provider) {
  if (!model) return null
  const names = modelAliases(model)
  const slug = String(provider || '').toLowerCase()
  const preferred = PROVIDER_ALIASES[slug] || slug

  const fromTable = table => {
    if (!table) return null
    for (const n of names) {
      const r = table[n]
      if (r) return { cache: r[2] ?? r[0], input: r[0], output: r[1] }
    }
    return null
  }

  const own = fromTable(FALLBACK_RATES[preferred])
  if (own) return own
  for (const id of Object.keys(FALLBACK_RATES)) {
    const hit = fromTable(FALLBACK_RATES[id])
    if (hit) return hit
  }
  return null
}

/** Pull the pricing entry for a model out of a model.options payload. */
function findPricing(payload, model, provider) {
  if (!payload || !Array.isArray(payload.providers) || !model) return null
  const rows = payload.providers
  const want = String(model)
  const prefer = provider ? String(provider).toLowerCase() : null

  const pick = row => {
    const p = row && row.pricing
    if (!p) return null
    if (p[want]) return { row, entry: p[want] }
    const tail = want.includes('/') ? want.split('/').pop() : want
    for (const key of Object.keys(p)) {
      if (key === tail || (key.includes('/') && key.split('/').pop() === tail)) {
        return { row, entry: p[key] }
      }
    }
    return null
  }

  if (prefer) {
    const hit = pick(rows.find(r => String(r.slug || '').toLowerCase() === prefer))
    if (hit) return { ...hit, ownProvider: true }
  }
  // A foreign row that happens to list the same model id. Its rates are that
  // provider's, NOT the active one's (nous and github-copilot both carry
  // claude-opus-5 at different prices), so flag it instead of passing it off
  // as the current provider.
  for (const row of rows) {
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

/**
 * Hermes' CanonicalUsage splits prompt = input + cache_read + cache_write, so
 * bill each stream at its own rate (cache writes have no separate catalog
 * rate; they go at the input rate).
 */
function costOf(bucket, rates) {
  if (!bucket || !rates) return null
  const M = 1_000_000
  const parts = {
    input: (num(bucket.input) * rates.input) / M,
    cacheRead: (num(bucket.cacheRead) * rates.cache) / M,
    cacheWrite: (num(bucket.cacheWrite) * rates.input) / M,
    output: (num(bucket.output) * rates.output) / M
  }
  return { parts, total: parts.input + parts.cacheRead + parts.cacheWrite + parts.output }
}

/**
 * Cache economics for a bucket.
 *
 * `prompt = input + cacheRead + cacheWrite` in Hermes' CanonicalUsage, so the
 * hit rate is cacheRead over the whole prompt side. Savings is what those
 * cached tokens would have cost at the full input rate minus what they
 * actually cost at the cache rate; cache writes are a surcharge only when the
 * provider prices them above input (we bill them at the input rate, so they
 * are neutral here and excluded).
 */
function cacheStats(bucket, rates) {
  if (!bucket) return null
  const read = num(bucket.cacheRead)
  const write = num(bucket.cacheWrite)
  const prompt = num(bucket.input) + read + write
  if (!prompt) return null

  const hitPct = (read / prompt) * 100
  let saved = null
  let wouldHaveCost = null
  if (rates) {
    const M = 1_000_000
    wouldHaveCost = (read * rates.input) / M
    saved = wouldHaveCost - (read * rates.cache) / M
  }
  return { hitPct, prompt, read, saved, wouldHaveCost, write }
}

/**
 * UsageStats -> the five numbers the ledger tracks.
 *
 * The gateway's `_get_usage` (tui_gateway/server.py) does NOT send raw
 * cache_read/cache_write counts — only a rounded `cache_hit_pct`, and only
 * when there were cache reads. But it does send both `input` (which is
 * session_input_tokens, falling back to session_prompt_tokens) and `prompt`
 * (session_prompt_tokens = input + cache_read + cache_write).
 *
 * So we recover the cached volume two ways, in order:
 *   1. prompt - input, when the provider splits them (exact);
 *   2. prompt * cache_hit_pct, when input already equals prompt (derived).
 * Cache writes are not separable from this payload and stay 0 — they bill at
 * the input rate anyway, so the cost total is unaffected.
 */
function readUsage(u) {
  const input = num(u.input)
  const prompt = num(u.prompt)
  const hitPct = typeof u.cache_hit_pct === 'number' ? u.cache_hit_pct : null

  let cacheRead = num(u.cache_read)
  let fresh = input
  if (!cacheRead && prompt) {
    if (prompt > input) {
      cacheRead = prompt - input
    } else if (hitPct != null && hitPct > 0) {
      cacheRead = Math.round((prompt * hitPct) / 100)
      fresh = Math.max(0, prompt - cacheRead)
    }
  }
  if (cacheRead && fresh === input && input >= cacheRead) fresh = input - cacheRead

  return {
    calls: num(u.calls),
    cacheRead,
    cacheWrite: num(u.cache_write),
    input: fresh,
    output: num(u.output)
  }
}

/* ----------------------------------------------------------------- ledger */

function emptyLedger() {
  return { v: 1, days: {}, snapshots: {}, rates: {} }
}

/** Live mirror of the persisted ledger so React re-renders on every commit. */
const $ledger = atom(emptyLedger())
const $range = atom('today')
let storage = null

function loadLedger() {
  if (!storage) return emptyLedger()
  const raw = storage.get(LEDGER_KEY, null)
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return emptyLedger()
  return {
    v: 1,
    days: raw.days && typeof raw.days === 'object' ? raw.days : {},
    snapshots: raw.snapshots && typeof raw.snapshots === 'object' ? raw.snapshots : {},
    rates: raw.rates && typeof raw.rates === 'object' ? raw.rates : {}
  }
}

function saveLedger(next) {
  $ledger.set(next)
  if (storage) {
    try {
      storage.set(LEDGER_KEY, next)
    } catch {
      /* quota / private mode — the in-memory mirror still works this session */
    }
  }
}

function prune(days) {
  const keys = Object.keys(days).sort()
  if (keys.length <= KEEP_DAYS) return days
  const keep = new Set(keys.slice(-KEEP_DAYS))
  const out = {}
  for (const k of keys) if (keep.has(k)) out[k] = days[k]
  return out
}

/**
 * Fold one session's cumulative counters into the ledger.
 *
 * The counters are cumulative per LIVE agent and reset to 0 on restart, /new
 * and /reset, so we diff against the last snapshot for that session+model and
 * add only the delta. A counter that went backwards means a fresh run: adopt
 * the new reading whole.
 */
function commitUsage(sessionId, usage) {
  if (!sessionId || !usage) return
  const model = String(usage.model || '').trim()
  if (!model) return

  const now = readUsage(usage)
  if (!now.input && !now.output && !now.cacheRead && !now.cacheWrite) return

  const led = $ledger.get()
  const snapKey = `${sessionId}::${model}`
  const prev = led.snapshots[snapKey]
  const restarted =
    !prev ||
    now.input < num(prev.input) ||
    now.output < num(prev.output) ||
    now.cacheRead < num(prev.cacheRead) ||
    now.calls < num(prev.calls)

  const delta = restarted
    ? now
    : {
        input: now.input - num(prev.input),
        output: now.output - num(prev.output),
        cacheRead: now.cacheRead - num(prev.cacheRead),
        cacheWrite: now.cacheWrite - num(prev.cacheWrite),
        calls: now.calls - num(prev.calls)
      }

  // Nothing new — don't churn storage on every mid-turn tick.
  if (!delta.input && !delta.output && !delta.cacheRead && !delta.cacheWrite && !delta.calls) return

  const day = dayKey()
  const days = { ...led.days }
  const forDay = { ...(days[day] || {}) }
  const b = { ...(forDay[model] || EMPTY_BUCKET()) }
  b.input += delta.input
  b.output += delta.output
  b.cacheRead += delta.cacheRead
  b.cacheWrite += delta.cacheWrite
  b.calls += delta.calls
  forDay[model] = b
  days[day] = forDay

  saveLedger({ ...led, days: prune(days), snapshots: { ...led.snapshots, [snapKey]: now } })
}

/** Remember catalog rates so a restart (or an offline app) still costs. */
function rememberRates(model, rates) {
  if (!model || !rates) return
  const led = $ledger.get()
  const old = led.rates[model]
  if (old && old.input === rates.input && old.output === rates.output && old.cache === rates.cache) return
  saveLedger({ ...led, rates: { ...led.rates, [model]: rates } })
}

/** Sum buckets over the days matching `filter`, per model. */
function aggregate(days, filter) {
  const out = {}
  for (const [date, models] of Object.entries(days)) {
    if (!filter(date)) continue
    for (const [model, b] of Object.entries(models)) {
      const acc = out[model] || (out[model] = EMPTY_BUCKET())
      acc.input += num(b.input)
      acc.output += num(b.output)
      acc.cacheRead += num(b.cacheRead)
      acc.cacheWrite += num(b.cacheWrite)
      acc.calls += num(b.calls)
    }
  }
  return out
}

const RANGES = {
  today: () => {
    const t = dayKey()
    return d => d === t
  },
  week: () => {
    const since = dayKey(Date.now() - 6 * 86_400_000)
    return d => d >= since
  },
  month: () => {
    const p = dayKey().slice(0, 7)
    return d => d.startsWith(p)
  },
  all: () => () => true
}

function sortModels(totals) {
  return Object.keys(totals).sort(
    (a, b) => totals[b].input + totals[b].output - (totals[a].input + totals[a].output)
  )
}

/* ------------------------------------------------------------------ hooks */

function usePricingPayload() {
  return useQuery({
    queryKey: [ID, 'model-options'],
    queryFn: () => host.request('model.options', {}),
    staleTime: 10 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
    retry: 1
  })
}

/** Rate resolver: live catalog first, remembered rates as the fallback. */
function useRateLookup() {
  const { data: payload, error, isLoading } = usePricingPayload()
  const led = useValue($ledger)

  const lookup = (model, provider) => {
    if (!model) return { providerSlug: null, rates: null, remembered: false }
    // 1. live catalog, but ONLY from the provider actually serving the model.
    //    Hermes fetches live pricing for just 7 providers; a model id that also
    //    exists on one of them (nous lists 856 models, incl. claude-opus-5)
    //    must not lend its rates to the route you are really on.
    const found = findPricing(payload, model, provider)
    const live = found && found.ownProvider ? toRates(found.entry) : null
    if (live) {
      rememberRates(model, live)
      return { origin: 'live', providerSlug: found.row.slug, rates: live, remembered: false }
    }
    // 2. rates remembered from an earlier live hit on this provider
    const saved = led.rates[model]
    if (saved) return { origin: 'remembered', providerSlug: provider || null, rates: saved, remembered: true }
    // 3. bundled models.dev table — the path that covers copilot & friends
    const bundled = fallbackRates(model, provider)
    if (bundled) return { origin: 'bundled', providerSlug: provider || null, rates: bundled, remembered: false }
    // 4. last resort: a foreign provider's rates, clearly labelled as such
    const foreign = toRates(found && found.entry)
    if (foreign) {
      return { foreignSlug: found.row.slug, origin: 'foreign', providerSlug: provider || null, rates: foreign, remembered: false }
    }
    return { origin: 'none', providerSlug: provider || null, rates: null, remembered: false }
  }

  return {
    error: error ? String(error.message || error) : null,
    loading: isLoading,
    lookup,
    providerHint: payload && payload.provider ? payload.provider : null
  }
}

/** The focused session's live numbers. */
function useLive() {
  const rawUsage = useValue(host.state.focusedUsage)
  // After a restart the host seeds the focused session with an all-zero usage
  // object (the gateway's counters live in process memory). Treat that as
  // "nothing yet" so the UI falls back to the persisted ledger instead of
  // advertising a live $0.00.
  const usage =
    rawUsage && (num(rawUsage.input) || num(rawUsage.output) || num(rawUsage.total) || num(rawUsage.calls))
      ? rawUsage
      : null
  const stateModel = useValue(host.state.model)
  const { error, loading, lookup, providerHint } = useRateLookup()

  const model = (usage && usage.model) || stateModel || ''
  const { foreignSlug, origin, providerSlug, rates, remembered } = lookup(model, providerHint)
  const bucket = usage ? readUsage(usage) : null
  const computed = costOf(bucket, rates)
  const cache = cacheStats(bucket, rates)
  const backendCost =
    usage && typeof usage.cost_usd === 'number' && usage.cost_usd > 0 ? usage.cost_usd : null

  return {
    bucket,
    cache,
    // The gateway's own rounded figure wins when present — it sees every call,
    // including ones that never reached the focused usage snapshot.
    cacheHitPct:
      usage && typeof usage.cache_hit_pct === 'number'
        ? usage.cache_hit_pct
        : cache
          ? cache.hitPct
          : null,
    computed,
    cost: backendCost != null ? backendCost : computed ? computed.total : null,
    costSource:
      backendCost != null
        ? 'gateway'
        : computed
          ? origin === 'bundled'
            ? 'bundled'
            : origin === 'foreign'
              ? 'foreign'
              : 'pricing'
          : 'none',
    foreignSlug,
    model,
    pricingError: error,
    pricingLoading: loading,
    providerSlug,
    rates,
    remembered,
    usage
  }
}

/** Total cost of an aggregated range, using whatever rates we can resolve. */
function rangeCost(totals, lookup) {
  let sum = 0
  let saved = 0
  let read = 0
  let prompt = 0
  let known = false
  for (const [model, b] of Object.entries(totals)) {
    const { rates } = lookup(model, null)
    const c = costOf(b, rates)
    if (c) {
      sum += c.total
      known = true
    }
    const cache = cacheStats(b, rates)
    if (cache) {
      read += cache.read
      prompt += cache.prompt
      if (cache.saved != null) saved += cache.saved
    }
  }
  return { hitPct: prompt ? (read / prompt) * 100 : null, known, saved, sum }
}

/* --------------------------------------------------------------------- UI */

function Chip() {
  const t = usePluginI18n(ID)
  const live = useLive()
  const led = useValue($ledger)
  const { lookup } = useRateLookup()
  const today = rangeCost(aggregate(led.days, RANGES.today()), lookup)

  const open = () => host.navigate('/token-cost')

  if (!live.usage) {
    return jsx(Tip, {
      label: t('chipTipIdle'),
      children: jsx('button', {
        className: cn(
          'inline-flex h-full items-center px-1.5 text-[0.6875rem] transition-colors',
          'text-(--ui-text-quaternary) hover:bg-(--chrome-action-hover) hover:text-foreground'
        ),
        onClick: open,
        type: 'button',
        children: today.known ? `${t('today')} ${fmtUsd(today.sum)}` : t('idle')
      })
    })
  }

  const label = `${fmtTokens(live.usage.input)}↑ ${fmtTokens(live.usage.output)}↓`

  return jsx(Tip, {
    label: t(
      'chipTip',
      live.model || '—',
      t(`src_${live.costSource}`),
      fmtUsd(today.sum),
      live.cacheHitPct != null ? `${Math.round(live.cacheHitPct)}%` : '—',
      live.cache && live.cache.saved != null ? fmtUsd(live.cache.saved) : '—'
    ),
    children: jsxs('button', {
      className: cn(
        'inline-flex h-full items-center gap-1.5 px-1.5 text-[0.6875rem] transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      onClick: open,
      type: 'button',
      children: [
        jsx('span', { children: label }),
        jsx('span', { className: 'text-(--ui-text-quaternary)', children: '·' }),
        jsx('span', {
          className: live.cost == null ? 'text-(--ui-text-quaternary)' : 'text-(--ui-accent)',
          children: live.cost == null ? t('noPrice') : fmtUsd(live.cost)
        }),
        live.cacheHitPct != null
          ? jsx('span', {
              className: 'text-(--ui-text-quaternary)',
              children: `· ⚡${Math.round(live.cacheHitPct)}%`
            })
          : null,
        today.known
          ? jsxs('span', {
              className: 'text-(--ui-text-quaternary)',
              children: ['· ', t('today'), ' ', fmtUsd(today.sum)]
            })
          : null
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
      jsx('div', {
        className: 'text-[0.625rem] tracking-wide text-(--ui-text-quaternary) uppercase',
        children: title
      }),
      jsx('div', { className: 'flex flex-col gap-0.5 text-xs', children })
    ]
  })
}

/** Right-hand pane: live session on top, persisted totals below. */
function Meter() {
  const t = usePluginI18n(ID)
  const live = useLive()
  const led = useValue($ledger)
  const { lookup } = useRateLookup()

  const sections = []

  if (live.usage) {
    const u = live.usage
    const b = live.bucket || { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }
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
                live.providerSlug
                  ? jsx(Tip, {
                      label: t('providerTip', live.providerSlug),
                      children: jsx(Badge, { variant: 'muted', children: live.providerSlug })
                    })
                  : null
              ].filter(Boolean)
            }),
            jsxs('div', {
              className: 'flex items-baseline gap-2',
              children: [
                jsx('div', {
                  className: 'text-2xl font-semibold tabular-nums text-(--ui-accent)',
                  children: live.cost == null ? '—' : fmtUsd(live.cost)
                }),
                jsx('span', {
                  className: cn(
                    'text-[0.625rem]',
                    live.costSource === 'foreign' ? 'text-(--ui-warning)' : 'text-(--ui-text-quaternary)'
                  ),
                  children:
                    (live.costSource === 'foreign'
                      ? t('src_foreign', live.foreignSlug || '?')
                      : t(`src_${live.costSource}`)) + (live.remembered ? ` · ${t('cachedRates')}` : '')
                })
              ]
            }),
            jsx(Section, {
              title: t('sessionTokens'),
              children: [
                jsx(Row, { label: t('input'), value: fmtTokens(b.input) }, 'i'),
                jsx(Row, { label: t('output'), value: fmtTokens(b.output) }, 'o'),
                b.cacheRead
                  ? jsx(Row, { dim: true, label: t('cacheRead'), value: fmtTokens(b.cacheRead) }, 'cr')
                  : null,
                b.cacheWrite
                  ? jsx(Row, { dim: true, label: t('cacheWrite'), value: fmtTokens(b.cacheWrite) }, 'cw')
                  : null,
                jsx(Row, { label: t('total'), value: fmtTokens(u.total) }, 'tt'),
                jsx(Row, { dim: true, label: t('calls'), value: String(u.calls ?? 0) }, 'c'),
                typeof u.context_percent === 'number'
                  ? jsx(
                      Row,
                      {
                        dim: true,
                        label: t('context'),
                        value: `${Math.round(u.context_percent)}% · ${fmtTokens(u.context_used)}/${fmtTokens(u.context_max)}`
                      },
                      'ctx'
                    )
                  : null
              ].filter(Boolean)
            }),
            live.cache
              ? jsx(Section, {
                  title: t('cacheTitle'),
                  children: [
                    jsx(
                      'div',
                      {
                        className: 'flex items-baseline justify-between gap-3 tabular-nums',
                        children: [
                          jsx('span', { className: 'text-(--ui-text-tertiary)', children: t('hitRate') }),
                          jsx('span', {
                            className: 'font-medium text-(--ui-accent)',
                            children: `${Math.round(live.cacheHitPct ?? 0)}%`
                          })
                        ]
                      },
                      'hr'
                    ),
                    jsx('div', { className: 'py-1', children: jsx(CacheBar, { pct: live.cacheHitPct ?? 0 }) }, 'bar'),
                    jsx(
                      Row,
                      {
                        dim: true,
                        label: t('cachedVsFresh'),
                        value: `${fmtTokens(live.cache.read)} / ${fmtTokens(live.cache.prompt - live.cache.read)}`
                      },
                      'cvf'
                    ),
                    live.cache.saved != null
                      ? jsx(
                          Row,
                          {
                            label: t('saved'),
                            value: `${fmtUsd(live.cache.saved)} (${t('ofWould')} ${fmtUsd(live.cache.wouldHaveCost)})`
                          },
                          'sv'
                        )
                      : null
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
              : jsx('div', {
                  className: 'text-xs text-(--ui-text-quaternary)',
                  children: live.pricingLoading
                    ? t('loadingPrice')
                    : live.pricingError || t('noPriceLong')
                })
          ].filter(Boolean)
        },
        'live'
      )
    )
  } else {
    sections.push(
      jsx('div', { className: 'text-xs text-(--ui-text-quaternary)', children: t('empty') }, 'live')
    )
  }

  for (const range of ['today', 'week', 'month']) {
    const totals = aggregate(led.days, RANGES[range]())
    const models = sortModels(totals)
    if (!models.length) continue

    const rows = models.map(model => {
      const c = costOf(totals[model], lookup(model, null).rates)
      return jsx(
        Row,
        {
          label: model,
          value: `${fmtTokens(totals[model].input + totals[model].output)} · ${c ? fmtUsd(c.total) : '—'}`
        },
        model
      )
    })
    rows.push(jsx(Row, { label: t('subtotal'), value: fmtUsd(rangeCost(totals, lookup).sum) }, '__sum'))

    sections.push(jsx(Section, { title: t(`range_${range}`), children: rows }, range))
  }

  return jsx('div', { className: 'flex h-full flex-col gap-3 overflow-auto p-3', children: sections })
}

/* -------------------------------------------------------------- full page */

function LedgerPage() {
  const t = usePluginI18n(ID)
  const led = useValue($ledger)
  const range = useValue($range)
  const { lookup } = useRateLookup()

  const totals = aggregate(led.days, RANGES[range]())
  const models = sortModels(totals)
  const grand = rangeCost(totals, lookup)

  const rows = models.map(model => {
    const b = totals[model]
    const { rates, remembered } = lookup(model, null)
    const c = costOf(b, rates)
    const cache = cacheStats(b, rates)

    return jsxs(
      'tr',
      {
        className: 'border-b border-(--ui-stroke-secondary)',
        children: [
          jsxs('td', {
            className: 'py-1.5 pr-3',
            children: [
              jsx('span', { children: model }),
              remembered
                ? jsx('span', {
                    className: 'ml-1.5 text-[0.625rem] text-(--ui-text-quaternary)',
                    children: t('cachedRates')
                  })
                : null
            ].filter(Boolean)
          }),
          jsx('td', { className: 'py-1.5 pr-3 text-right tabular-nums', children: fmtTokens(b.input) }),
          jsx('td', { className: 'py-1.5 pr-3 text-right tabular-nums', children: fmtTokens(b.output) }),
          jsx('td', {
            className: 'py-1.5 pr-3 text-right tabular-nums text-(--ui-text-tertiary)',
            children: fmtTokens(b.cacheRead)
          }),
          jsx('td', {
            className: 'py-1.5 pr-3 text-right tabular-nums text-(--ui-text-tertiary)',
            children: String(b.calls)
          }),
          jsx('td', {
            className: 'py-1.5 pr-3 text-right tabular-nums',
            children: cache ? `${Math.round(cache.hitPct)}%` : '—'
          }),
          jsx('td', {
            className: 'py-1.5 pr-3 text-right tabular-nums text-(--ui-accent)',
            children: cache && cache.saved != null ? fmtUsd(cache.saved) : '—'
          }),
          jsx('td', { className: 'py-1.5 text-right tabular-nums', children: c ? fmtUsd(c.total) : '—' })
        ]
      },
      model
    )
  })

  const head = ['modelCol', 'input', 'output', 'cacheRead', 'calls', 'hitRate', 'saved', 'cost'].map((k, i) =>
    jsx(
      'th',
      {
        className: cn(
          'pb-1.5 font-medium text-(--ui-text-quaternary)',
          i === 0 ? 'pr-3 text-left' : 'pr-3 text-right',
          k === 'cost' && 'pr-0'
        ),
        children: t(k)
      },
      k
    )
  )

  return jsxs('div', {
    className: 'mx-auto flex w-full max-w-3xl flex-col gap-4 p-6',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center justify-between gap-3',
        children: [
          jsx('h1', { className: 'text-base font-semibold', children: t('pageTitle') }),
          jsx(SegmentedControl, {
            onChange: v => $range.set(v),
            options: [
              { id: 'today', label: t('range_today') },
              { id: 'week', label: t('range_week') },
              { id: 'month', label: t('range_month') },
              { id: 'all', label: t('range_all') }
            ],
            value: range
          })
        ]
      }),

      jsxs('div', {
        className: 'flex items-baseline gap-2',
        children: [
          jsx('div', {
            className: 'text-3xl font-semibold tabular-nums text-(--ui-accent)',
            children: grand.known ? fmtUsd(grand.sum) : '—'
          }),
          jsx('span', { className: 'text-xs text-(--ui-text-quaternary)', children: t('grandHint') })
        ]
      }),

      grand.hitPct != null
        ? jsxs('div', {
            className: 'flex flex-col gap-1.5',
            children: [
              jsxs('div', {
                className: 'flex items-baseline justify-between text-xs',
                children: [
                  jsxs('span', {
                    className: 'text-(--ui-text-tertiary)',
                    children: [t('hitRate'), ' ', jsx('span', {
                      className: 'font-medium text-(--ui-accent)',
                      children: `${Math.round(grand.hitPct)}%`
                    })]
                  }),
                  jsxs('span', {
                    className: 'text-(--ui-text-tertiary)',
                    children: [t('savedTotal'), ' ', jsx('span', {
                      className: 'font-medium text-(--ui-accent)',
                      children: fmtUsd(grand.saved)
                    })]
                  })
                ]
              }),
              jsx(CacheBar, { pct: grand.hitPct })
            ]
          })
        : null,

      models.length
        ? jsxs('table', {
            className: 'w-full text-xs',
            children: [
              jsx('thead', { children: jsx('tr', { children: head }) }),
              jsx('tbody', { children: rows })
            ]
          })
        : jsx('div', {
            className:
              'rounded-md border border-(--ui-stroke-secondary) p-6 text-center text-xs text-(--ui-text-quaternary)',
            children: t('noLedger')
          }),

      jsx('p', {
        className: 'text-[0.6875rem] leading-relaxed text-(--ui-text-quaternary)',
        children: t('disclaimer')
      })
    ]
  })
}

/* --------------------------------------------------------------- register */

export default {
  id: ID,
  name: 'Token & Cost Meter',
  description: 'Live token usage and model-aware cost, with a persistent per-day ledger.',
  register(ctx) {
    storage = ctx.storage
    $ledger.set(loadLedger())
    $range.set(ctx.storage.get('range', 'today'))
    ctx.onDispose($range.listen(v => ctx.storage.set('range', v)))

    ctx.i18n.register({
      en: {
        cacheRead: 'Cache read',
        cacheWrite: 'Cache write',
        cacheTitle: 'Prompt cache',
        cachedRates: 'cached rates',
        cachedVsFresh: 'Cached / fresh',
        calls: 'Calls',
        chipTip: (model, source, today, hit, saved) =>
          `${model} — cost ${source}. Today ${today}. Cache hit ${hit}, saved ${saved} this session. Click for details.`,
        chipTipIdle: 'Token & cost ledger — click for details',
        context: 'Context',
        cost: 'Cost',
        disclaimer:
          'Estimates. Costs come from the provider catalog’s $/Mtok rates, not a billing API; subscription routes (Copilot, Nous credits) may bill differently. The ledger is stored locally by this plugin and only records usage seen while the plugin was running.',
        empty: 'No live session usage — send a message.',
        grandHint: 'estimated, from catalog $/Mtok',
        hitRate: 'Hit rate',
        idle: 'tokens —',
        input: 'Input',
        loadingPrice: 'Loading pricing…',
        modelCol: 'Model',
        navLabel: 'Tokens & Cost',
        noLedger: 'Nothing recorded yet. Usage is folded in as turns complete.',
        noPrice: 'n/a',
        noPriceLong: 'No rate for this model in the provider catalog or the bundled models.dev table. Run scripts/gen-rates.py to refresh it.',
        ofWould: 'of', 
        output: 'Output',
        pageTitle: 'Token & Cost Ledger',
        paneTitle: 'tokens & cost',
        range_all: 'All time',
        range_month: 'This month',
        range_today: 'Today',
        range_week: '7 days',
        rates: 'Rates ($/Mtok)',
        saved: 'Saved',
        savedTotal: 'Saved by cache',
        sessionTokens: 'This session',
        providerTip: slug => `Active provider: ${slug} — the route serving this model`,
        src_bundled: 'estimated from models.dev rates',
        src_foreign: slug => `⚠ rates borrowed from ${slug} — may not match your route`,
        src_gateway: 'reported by gateway',
        src_none: 'pricing unavailable',
        src_pricing: 'computed from catalog pricing',
        subtotal: 'Subtotal',
        today: 'today',
        total: 'Total'
      },
      zh: {
        cacheRead: '缓存读取',
        cacheTitle: '提示词缓存',
        cacheWrite: '缓存写入',
        cachedRates: '历史价格',
        cachedVsFresh: '缓存 / 新增',
        calls: '调用',
        chipTip: (model, source, today, hit, saved) =>
          `${model} — 费用${source}。今日 ${today}。缓存命中 ${hit}，本次会话节省 ${saved}。点击查看明细。`,
        chipTipIdle: '令牌与花费账本 — 点击查看明细',
        context: '上下文',
        cost: '花费',
        disclaimer:
          '仅为估算。金额按供应商目录的 $/百万令牌 单价计算，并非账单接口；订阅制路由（Copilot、Nous 额度等）的实际计费可能不同。账本由本插件保存在本地，且只记录插件运行期间观察到的用量。',
        empty: '当前会话暂无用量 — 先发一条消息。',
        grandHint: '按目录单价估算',
        hitRate: '命中率',
        idle: '令牌 —',
        input: '输入',
        loadingPrice: '正在加载价格…',
        modelCol: '模型',
        navLabel: '令牌与花费',
        noLedger: '尚无记录。每轮对话结束后会自动累加。',
        noPrice: '无',
        noPriceLong: '供应商目录与内置 models.dev 价格表中都没有该模型。可运行 scripts/gen-rates.py 刷新价格表。',
        ofWould: '原价',
        output: '输出',
        pageTitle: '令牌与花费账本',
        paneTitle: '令牌与花费',
        range_all: '全部',
        range_month: '本月',
        range_today: '今日',
        range_week: '近 7 天',
        rates: '单价（$/百万令牌）',
        saved: '已节省',
        savedTotal: '缓存节省',
        sessionTokens: '本次会话',
        providerTip: slug => `当前供应商：${slug} —— 实际承载该模型的线路`,
        src_bundled: '按 models.dev 单价估算',
        src_foreign: slug => `⚠ 借用了 ${slug} 的价格，可能与你的线路不符`,
        src_gateway: '来自网关',
        src_none: '价格不可用',
        src_pricing: '按目录价格计算',
        subtotal: '小计',
        today: '今日',
        total: '合计'
      }
    })

    // --- ledger intake -------------------------------------------------
    // message.complete carries the authoritative final usage of a turn;
    // session.usage is the mid-turn tick (cheap — commitUsage no-ops on a zero
    // delta and only touches storage when something actually moved).
    const intake = event => {
      const usage = event && event.payload && event.payload.usage
      if (usage && event.session_id) commitUsage(event.session_id, usage)
    }
    ctx.onEvent('message.complete', intake)
    ctx.onEvent('session.usage', intake)

    // Safety net: fold the focused session's live numbers on a slow timer so a
    // turn that ends without a usable event still lands in the ledger.
    ctx.setInterval(() => {
      const sid = host.state.focusedSessionId.get()
      const usage = host.state.focusedUsage.get()
      if (sid && usage) commitUsage(sid, usage)
    }, 30_000)

    // --- UI ------------------------------------------------------------
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'tokens & cost',
      data: { placement: 'right', width: '268px' },
      render: () => jsx(Meter, {})
    })

    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 120,
      render: () => jsx(Chip, {})
    })

    ctx.register({
      id: 'page',
      area: 'routes',
      title: 'Token & Cost Ledger',
      data: { path: '/token-cost' },
      render: () => jsx(LedgerPage, {})
    })

    ctx.register({
      id: 'nav',
      area: 'sidebar.nav',
      data: { codicon: 'graph', label: 'Tokens & Cost', path: '/token-cost' }
    })
  }
}
