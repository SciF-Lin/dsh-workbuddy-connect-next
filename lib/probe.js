/**
 * Reasoning-effort probe protocol, ported from the original plugin's plan:
 *
 * 1. baseline (no `reasoning_effort`) proves the model/credential/request shape;
 * 2. sentinel (a fresh impossible value) proves the upstream validates the field
 *    at all — a model that accepts the sentinel accepts anything;
 * 3. only then sweep canonical levels.
 *
 * The result is an observation ("the upstream accepted these spellings"), never
 * a claim about how the model thinks.
 *
 * @module dsh-workbuddy-connect-next/probe
 */
import { randomBytes } from 'node:crypto'

/** Canonical values a sweep tests, fixed order; `off` is never probed. */
export const PROBE_EFFORT_CANDIDATES = ['low', 'medium', 'high', 'xhigh', 'max']

/** Prompt used by every probe request; carries nothing user-specific. */
export const PROBE_PROMPT = 'ping'

/** Default per-request ceiling. */
export const PROBE_REQUEST_TIMEOUT_MS = 30_000

/** Upstream "this effort is unsupported" codes, per endpoint. */
const INVALID_EFFORT_CODES = {
  cn: new Set(['invalid_reasoning_effort', 'invalid_parameter_value']),
  global: new Set(['invalid_reasoning_effort', 'model_param_invalid', 'invalid_parameter_value']),
}

/** Default sentinel: unmistakably non-canonical and unique per call. */
export function randomSentinel() {
  return `probe_sentinel_${randomBytes(12).toString('hex')}`
}

function isEffortRejection(attempt, region) {
  const codes = INVALID_EFFORT_CODES[region] ?? INVALID_EFFORT_CODES.cn
  return attempt.status === 400 && attempt.errorCode !== undefined && codes.has(attempt.errorCode)
}

function isAcceptance(attempt) {
  return attempt.status === 200 && attempt.streamed === true
}

function unknownReason(stage, attempt) {
  const code = attempt.errorCode === undefined ? '' : ` (${attempt.errorCode})`
  const detail = attempt.detail === undefined ? '' : `: ${attempt.detail}`
  return `${stage} status ${attempt.status}${code}${detail}`
}

/**
 * Probe one model.
 *
 * @param options.send - `(effort|undefined, signal) => Promise<ProbeAttempt>`.
 * @param options.region - `'cn' | 'global'`, selects the rejection vocabulary.
 * @returns `{validation, efforts, requests, reason?}`.
 */
export async function probeModel(options) {
  const sentinel = options.sentinel ?? randomSentinel
  const candidates = options.candidates ?? PROBE_EFFORT_CANDIDATES
  const timeoutMs = options.timeoutMs ?? PROBE_REQUEST_TIMEOUT_MS
  const region = options.region ?? 'cn'
  let requests = 0

  const attempt = async (effort) => {
    requests += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await options.send(effort, controller.signal)
    } catch (error) {
      return { status: 0, streamed: false, detail: `transport error: ${String(error)}` }
    } finally {
      clearTimeout(timer)
    }
  }

  const baseline = await attempt(undefined)
  if (!isAcceptance(baseline)) {
    return { validation: 'unknown', efforts: [], requests, reason: unknownReason('baseline', baseline) }
  }

  const sentinelAttempt = await attempt(sentinel())
  if (isAcceptance(sentinelAttempt)) {
    // The upstream took a value that cannot exist: per-level answers would be
    // false positives, so stop rather than spend more requests.
    return { validation: 'non-validating', efforts: [], requests }
  }
  if (!isEffortRejection(sentinelAttempt, region)) {
    return { validation: 'unknown', efforts: [], requests, reason: unknownReason('sentinel', sentinelAttempt) }
  }

  const accepted = []
  for (const effort of candidates) {
    const levelAttempt = await attempt(effort)
    if (isAcceptance(levelAttempt)) {
      accepted.push(effort)
      continue
    }
    if (isEffortRejection(levelAttempt, region)) continue
    // A non-decisive answer mid-sweep makes the partial list meaningless.
    return {
      validation: 'unknown',
      efforts: [],
      requests,
      reason: unknownReason(`level ${effort}`, levelAttempt),
    }
  }
  return { validation: 'validating', efforts: accepted, requests }
}

/** Stable fingerprint of the catalog facts a probe result was measured against. */
export function fingerprintModel(model) {
  const input = JSON.stringify({
    id: model.id,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    declared: model.reasoning?.efforts ?? [],
    defaultEffort: model.reasoning?.defaultEffort ?? null,
  })
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}
