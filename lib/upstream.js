/**
 * WorkBuddy upstream HTTP client: request shaping, streaming SSE decoding, and
 * the few response documents this plugin needs (catalog, token refresh).
 *
 * The upstream is OpenAI-chat-compatible, so the Harness request is projected
 * onto `messages`/`tools` and the stream is decoded from
 * `chat.completion.chunk` frames.
 *
 * @module dsh-workbuddy-connect-next/upstream
 */
import { randomUUID } from 'node:crypto'

const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const GLOBAL_BASE = 'https://www.workbuddy.ai'

/** CLI-shaped identity used for the CN catalog and token refresh. */
const CLI_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/** The concrete effort spellings WorkBuddy accepts on the wire. */
export const EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max']

/** Region for a login domain; an empty domain means CN. */
export function regionOf(domain) {
  const lowered = String(domain ?? '').trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  return 'cn'
}

function chatBase(credential) {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_CHAT_BASE
}

function billingBase(credential) {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

function originOf(credential) {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

/** Desktop-identity User-Agent for chat requests. */
function chatUserAgent(appVersion) {
  const version = appVersion && /^\d+\.\d+\.\d+/u.test(appVersion) ? appVersion : '5.8.3'
  return `WorkBuddy/${version} WorkBuddy/${version}`
}

/** Headers every upstream request shares. */
function commonHeaders(credential, userAgent) {
  const origin = originOf(credential)
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': origin,
    'Referer': `${origin}/`,
    'User-Agent': userAgent,
  }
}

/** Chat headers, including the desktop identity and conversation channel trio. */
function chatHeaders(credential, appVersion) {
  const headers = {
    ...commonHeaders(credential, chatUserAgent(appVersion)),
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${credential.accessToken}`,
    ...(credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid }),
    ...(credential.enterpriseId === undefined
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId }),
    ...(credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain }),
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': appVersion ?? '5.8.3',
    'X-Product': 'SaaS',
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': randomUUID(),
    'X-Conversation-Message-ID': randomUUID(),
  }
  return headers
}

/** Billing/catalog headers for the CN product document. */
function catalogHeaders(credential, userAgent) {
  const headers = {
    ...commonHeaders(credential, userAgent),
    'Authorization': `Bearer ${credential.accessToken}`,
  }
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== undefined) {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

/** Extract a user-facing message from an upstream JSON error body. */
export function extractDisplayErrorMessage(body) {
  const trimmed = String(body ?? '').trim()
  if (!trimmed.startsWith('{')) return undefined
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const display = parsed.displayMsg
  if (typeof display === 'object' && display !== null) {
    if (typeof display.zh === 'string' && display.zh.trim() !== '') return display.zh.trim()
    if (typeof display.en === 'string' && display.en.trim() !== '') return display.en.trim()
  }
  if (typeof parsed.msg === 'string' && parsed.msg.trim() !== '') return parsed.msg.trim()
  return undefined
}

/** Map an HTTP status + body to a Harness error code. */
export function classifyFailure(status, body) {
  const text = String(body ?? '')
  const lower = text.toLowerCase()
  const has = markers => markers.some(marker => lower.includes(marker.toLowerCase()) || text.includes(marker))
  if (status === 401) return { code: 'AUTH', message: 'WorkBuddy session is no longer valid; sign in again in the WorkBuddy app' }
  if (status === 402) return { code: 'QUOTA', message: 'WorkBuddy credits are insufficient for this request' }
  if (has(['insufficient credit', 'no credit', 'credit exhausted', 'credits exhausted', 'out of credit',
    'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough', 'not enough credit',
    '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分'])) {
    return { code: 'QUOTA', message: 'WorkBuddy credits are insufficient for this request' }
  }
  if (status === 403 || has(['offline user session not found', '12153'])) {
    return { code: 'AUTH', message: 'WorkBuddy session is no longer valid; sign in again in the WorkBuddy app' }
  }
  if (status === 429) return { code: 'RATE_LIMIT', message: 'WorkBuddy is rate limiting this account; retry shortly' }
  if (status === 400) {
    const detail = extractDisplayErrorMessage(text) ?? text.slice(0, 400)
    return { code: 'INVALID_REQUEST', message: `WorkBuddy rejected the request: ${detail}` }
  }
  if (status === 404) return { code: 'SERVER', message: 'WorkBuddy upstream route was not found (transient)' }
  if (status >= 500) {
    const detail = extractDisplayErrorMessage(text)
    return { code: 'SERVER', message: `WorkBuddy upstream error${detail === undefined ? '' : `: ${detail}`}` }
  }
  const detail = extractDisplayErrorMessage(text) ?? (text === '' ? '' : `: ${text.slice(0, 300)}`)
  return { code: `HTTP_${status}`, message: `WorkBuddy upstream returned HTTP ${status}${detail}` }
}

/** Build a Harness-shaped failure error (code/status carried as properties). */
export function upstreamError(code, message, status, retryAfterMs) {
  const error = new Error(message)
  error.code = code
  if (status !== undefined) error.status = status
  // The runtime keeps a plain Error's code out of the normalized failure
  // unless it also carries a `failure` snapshot; populate one so AUTH /
  // QUOTA / RATE_LIMIT stay actionable for retry, banners, and compaction.
  error.failure = {
    message,
    code,
    ...(Number.isSafeInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? { providerRetryAfterMs: retryAfterMs } : {}),
  }
  return error
}

/** Normalize image bytes into an OpenAI `image_url` data URL part. */
export function imagePart(mediaType, data) {
  return {
    type: 'image_url',
    image_url: { url: `data:${mediaType};base64,${Buffer.from(data).toString('base64')}` },
  }
}

function textOf(blocks) {
  const out = []
  for (const block of blocks ?? []) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text !== '') out.push(block.text)
  }
  return out.join('')
}

/**
 * Project Harness request messages onto the upstream's OpenAI chat shape.
 *
 * @param options - the Harness GenerateOptions.
 * @param resolveImage - async (ref) => {mediaType, data} | undefined.
 * @returns the wire body.
 */
export async function buildChatBody(options, resolveImage) {
  const messages = []
  if (typeof options.system === 'string' && options.system.trim() !== '') {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages ?? []) {
    if (message === undefined || message === null) continue
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message.content)
      if (text !== '') messages.push({ role: 'system', content: text })
      continue
    }
    if (message.role === 'user') {
      const parts = []
      for (const block of message.content ?? []) {
        if (block.type === 'text') {
          if (typeof block.text === 'string' && block.text !== '') parts.push({ type: 'text', text: block.text })
        } else if (block.type === 'image') {
          const resolved = await resolveImage?.(block.attachment)
          if (resolved !== undefined) parts.push(imagePart(resolved.mediaType, resolved.data))
        }
        // file and tool-change blocks are projected to text by the runtime
      }
      if (parts.length === 0) continue
      const onlyText = parts.every(part => part.type === 'text')
      messages.push(onlyText
        ? { role: 'user', content: parts.map(part => part.text).join('') }
        : { role: 'user', content: parts })
      continue
    }
    if (message.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: String(message.toolCallId ?? ''),
        content: textOf(message.content),
      })
      continue
    }
    if (message.role === 'assistant') {
      const text = textOf(message.content)
      const calls = (message.content ?? [])
        .filter(block => block.type === 'tool-call')
        .map(block => ({
          id: String(block.id ?? ''),
          type: 'function',
          function: { name: String(block.name ?? ''), arguments: String(block.arguments ?? '{}') },
        }))
      if (text === '' && calls.length === 0) continue
      messages.push({
        role: 'assistant',
        content: text === '' ? null : text,
        ...(calls.length === 0 ? {} : { tool_calls: calls }),
      })
    }
  }
  const body = {
    model: options.model,
    messages,
    stream: true,
  }
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop
  const effort = options.reasoningEffort
  if (typeof effort === 'string' && effort !== '' && effort !== 'off') body.reasoning_effort = effort
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    }))
    body.tool_choice = 'auto'
  }
  return body
}

/**
 * POST one chat request. Returns the raw Response; the caller decodes SSE.
 *
 * @param credential - resolved WorkBuddy credential.
 * @param body - wire body from {@link buildChatBody}.
 * @param options - `{appVersion, signal}`.
 */
export async function requestChat(credential, body, options = {}) {
  const region = regionOf(credential.domain)
  const headers = chatHeaders(credential, options.appVersion)
  let response
  try {
    response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(region === 'global' ? ensureSystemFirst(body) : body),
      redirect: 'error',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    if (options.signal?.aborted) throw upstreamError('ABORTED', 'WorkBuddy request aborted')
    throw upstreamError('TRANSPORT', `WorkBuddy transport failed: ${String(error)}`)
  }
  if (!response.ok) {
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    const classified = classifyFailure(response.status, text)
    throw upstreamError(classified.code, classified.message, response.status)
  }
  return response
}

/** The international gateway requires the first message to be a system prompt. */
function ensureSystemFirst(body) {
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length === 0) return body
  if (messages[0]?.role === 'system') return body
  return { ...body, messages: [{ role: 'system', content: 'You are a helpful assistant.' }, ...messages] }
}

/**
 * Decode the upstream SSE body into OpenAI chunk objects, honoring `[DONE]`.
 * Heartbeat comments (`: heartbeat`) are ignored, and a partial trailing line
 * is retained until the next read.
 */
export async function* readSseJson(response, signal) {
  if (response.body === null) throw upstreamError('EMPTY_RESPONSE', 'WorkBuddy returned no response body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) throw upstreamError('ABORTED', 'WorkBuddy request aborted')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, '')
        buffer = buffer.slice(newline + 1)
        if (line === '' || line.startsWith(':')) continue
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return
        if (payload === '') continue
        let chunk
        try {
          chunk = JSON.parse(payload)
        } catch {
          throw upstreamError('MALFORMED_RESPONSE', 'WorkBuddy stream contained invalid JSON')
        }
        const error = chunk?.error
        if (typeof error === 'object' && error !== null) {
          const message = typeof error.message === 'string' ? error.message : 'WorkBuddy stream reported an error'
          throw upstreamError(typeof error.code === 'string' ? error.code : 'SERVER', message)
        }
        yield chunk
      }
    }
    // Flush a final frame that arrived without a trailing newline.
    const tail = buffer.trim()
    if (tail.startsWith('data:') && tail.slice(5).trim() !== '[DONE]') {
      try {
        yield JSON.parse(tail.slice(5).trim())
      } catch {
        // ignore an incomplete tail
      }
    }
  } finally {
    try { await reader.cancel() } catch { /* already closed */ }
  }
}

/** POST the refresh endpoint and return the new token material. */
export async function refreshCredential(credential) {
  const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
    method: 'POST',
    headers: {
      ...commonHeaders(credential, CLI_UA),
      'X-Refresh-Token': credential.refreshToken,
      'X-Auth-Refresh-Source': 'workbuddy',
      ...(credential.enterpriseId === undefined ? {} : { 'X-Enterprise-Id': credential.enterpriseId }),
    },
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })
  const text = await response.text()
  let document
  try {
    document = JSON.parse(text)
  } catch {
    throw new Error(`WorkBuddy token refresh returned non-JSON (http ${response.status})`)
  }
  if (!response.ok || (typeof document.code === 'number' && document.code !== 0)) {
    throw new Error(`WorkBuddy token refresh failed (http ${response.status}): ${String(document.msg ?? '').slice(0, 200)}`)
  }
  const data = typeof document.data === 'object' && document.data !== null ? document.data : {}
  const accessToken = typeof data.accessToken === 'string' ? data.accessToken : ''
  if (accessToken === '') throw new Error('WorkBuddy token refresh returned no accessToken')
  return {
    accessToken,
    ...(typeof data.refreshToken === 'string' && data.refreshToken !== '' ? { refreshToken: data.refreshToken } : {}),
    ...(typeof data.expiresIn === 'number' && data.expiresIn > 0 ? { expiresInSec: data.expiresIn } : {}),
    ...(typeof data.domain === 'string' && data.domain !== '' ? { domain: data.domain } : {}),
  }
}

/**
 * Fetch the product model catalog (`/v3/config`).
 *
 * The document the gateway returns depends on the User-Agent: the CLI identity
 * yields the CLI roster (the chat models this plugin serves), while an
 * App-shaped identity yields the App's internal roster. The global product
 * spells its App identity `WorkBuddyAI/<v>` (no space); the spaced form is
 * answered with 400/12403.
 */
export async function fetchCatalog(credential, options = {}) {
  const global = regionOf(credential.domain) === 'global'
  const version = options.appVersion && /^\d+\.\d+\.\d+/u.test(options.appVersion) ? options.appVersion : '5.8.3'
  const catalogUa = global ? `WorkBuddyAI/${version}` : CLI_UA
  const response = await fetch(`${chatBase(credential)}/v3/config`, {
    headers: catalogHeaders(credential, catalogUa),
    signal: AbortSignal.timeout(options.timeoutMs ?? JSON_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) {
    const classified = classifyFailure(response.status, text)
    throw upstreamError(classified.code, classified.message, response.status)
  }
  let document
  try {
    document = JSON.parse(text)
  } catch {
    throw upstreamError('MALFORMED_RESPONSE', 'WorkBuddy catalog response was not JSON')
  }
  if (typeof document.code === 'number' && document.code !== 0) {
    throw upstreamError('SERVER', `WorkBuddy catalog refused the request: ${String(document.msg ?? '').slice(0, 200)}`)
  }
  const data = typeof document.data === 'object' && document.data !== null ? document.data : document
  const rawModels = Array.isArray(data.models) ? data.models : []
  if (rawModels.length === 0) throw upstreamError('MALFORMED_RESPONSE', 'WorkBuddy catalog carried no models')
  // The roster this account may actually use is the CLI agent's model subset.
  const agents = Array.isArray(data.agents) ? data.agents : []
  const cliAgent = agents.find(agent => agent?.name === 'cli' || agent?.description === 'cli agent')
  const agentModels = Array.isArray(cliAgent?.models) && cliAgent.models.length > 0
    ? new Set(cliAgent.models)
    : undefined
  return rawModels
    .filter(model => typeof model?.id === 'string' && model.id !== '')
    .filter(model => model.disabled !== true)
    .filter(model => agentModels === undefined || agentModels.has(model.id))
    .map(normalizeCatalogModel)
    .filter(model => model.contextWindow > 0 && model.maxTokens > 0)
}

/** Normalize one catalog row into the plugin's model shape. */
export function normalizeCatalogModel(raw) {
  const efforts = Array.isArray(raw.reasoning?.supportedEfforts)
    ? raw.reasoning.supportedEfforts.filter(value => EFFORT_VALUES.includes(value))
    : []
  const defaultEffort = EFFORT_VALUES.includes(raw.reasoning?.defaultEffort)
    ? raw.reasoning.defaultEffort
    : EFFORT_VALUES.includes(raw.reasoning?.effort) ? raw.reasoning.effort : undefined
  const supportsReasoning = raw.supportsReasoning === true || raw.onlyReasoning === true
  const badges = []
  for (const tag of Array.isArray(raw.tags) ? raw.tags : []) {
    if (typeof tag !== 'string' || !tag.toLowerCase().startsWith('badge:')) continue
    const label = tag.slice('badge:'.length).split(':')[0]
    if (label && !badges.includes(label)) badges.push(label)
  }
  const credits = typeof raw.credits === 'string' ? raw.credits.trim().replace(/\s+credits?$/iu, '') : undefined
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : raw.id,
    description: typeof raw.descriptionZh === 'string' && raw.descriptionZh !== ''
      ? raw.descriptionZh
      : typeof raw.descriptionEn === 'string' ? raw.descriptionEn : undefined,
    contextWindow: Number.isSafeInteger(raw.maxInputTokens) && raw.maxInputTokens > 0 ? raw.maxInputTokens : 200_000,
    maxTokens: Number.isSafeInteger(raw.maxOutputTokens) && raw.maxOutputTokens > 0 ? raw.maxOutputTokens : 32_000,
    supportsImages: raw.supportsImages === true && raw.disabledMultimodal !== true,
    supportsToolCall: raw.supportsToolCall !== false,
    temperature: typeof raw.temperature === 'number' ? raw.temperature : undefined,
    reasoning: {
      supports: supportsReasoning,
      onlyReasoning: raw.onlyReasoning === true,
      // Declared sets only: an undeclared model stays empty so the picker shows
      // no effort menu until a probe observes which spellings are accepted.
      efforts,
      defaultEffort,
      canDisableThinking: raw.reasoning?.canDisableThinking === true,
    },
    billing: {
      ...(credits === undefined || credits === '' ? {} : { credits }),
      ...(badges.length === 0 ? {} : { badges }),
      free: credits === 'x0.00',
    },
  }
}

/** Fetch the aggregated remaining credit for the status card (best effort). */
export async function fetchCredit(credential) {
  const base = billingBase(credential)
  const enterprise = credential.enterpriseId !== undefined
  const url = enterprise
    ? `${CN_BILLING_BASE}/v2/billing/meter/get-enterprise-user-usage`
    : `${base}/v2/billing/meter/get-user-resource`
  const headers = {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== undefined) {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  const body = enterprise ? '{}' : JSON.stringify({
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: formatBillingTime(new Date()),
    PackageEndTimeRangeEnd: formatBillingTime(new Date(Date.now() + 365 * 101 * 24 * 3600 * 1000)),
  })
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })
  const text = await response.text()
  let document
  try {
    document = JSON.parse(text)
  } catch {
    throw upstreamError('MALFORMED_RESPONSE', `WorkBuddy billing returned non-JSON (http ${response.status})`, response.status)
  }
  if (!response.ok || (typeof document.code === 'number' && document.code !== 0)) {
    const detail = extractDisplayErrorMessage(text) ?? String(document.msg ?? '').slice(0, 200)
    throw upstreamError('SERVER', `WorkBuddy billing refused the query (http ${response.status}): ${detail}`, response.status)
  }
  return enterprise ? parseEnterpriseCredits(document) : parsePersonalCredits(document)
}

/** `YYYY-MM-DD HH:mm:ss` in local time, the shape the billing query expects. */
function formatBillingTime(date) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Zone-less `CycleEndTime` as local epoch milliseconds. */
function parseCycleEndTime(value) {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/u.exec(value.trim())
  if (match === null) return undefined
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  const date = new Date(year, month - 1, day, hour, minute, second)
  const time = date.getTime()
  if (!Number.isFinite(time)) return undefined
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return undefined
  return time
}

/** Personal billing: a package list whose remaining amounts are summed. */
function parsePersonalCredits(document) {
  const data = typeof document.data === 'object' && document.data !== null ? document.data : {}
  const response = typeof data.Response === 'object' && data.Response !== null ? data.Response : {}
  const inner = typeof response.Data === 'object' && response.Data !== null ? response.Data : {}
  const rawAccounts = Array.isArray(inner.Accounts) ? inner.Accounts : []
  let total = 0
  const accounts = []
  for (const raw of rawAccounts) {
    if (typeof raw !== 'object' || raw === null) continue
    const numberField = key => (typeof raw[key] === 'number' ? raw[key] : 0)
    const size = numberField('CycleCapacitySize')
    const cycleRemain = numberField('CycleCapacityRemain')
    const cycleUsed = numberField('CycleCapacityUsed')
    const capacityRemain = numberField('CapacityRemain')
    let remain = size > 0
      ? cycleRemain
      : (cycleRemain > 0 || cycleUsed > 0 ? cycleRemain : capacityRemain)
    if (remain < 0) remain = 0
    total += remain
    const endTimeMs = parseCycleEndTime(raw.CycleEndTime)
    accounts.push({
      packageName: typeof raw.PackageName === 'string' ? raw.PackageName : '(unnamed)',
      remain,
      size: size > 0 ? size : numberField('CapacitySize'),
      ...(endTimeMs === undefined ? {} : { endTimeMs }),
    })
  }
  return { total, accounts }
}

/** CN enterprise billing: one cycle quota, `-1` meaning uncapped. */
function parseEnterpriseCredits(document) {
  const sources = []
  for (const candidate of [document.data, document]) {
    if (typeof candidate !== 'object' || candidate === null) continue
    if (typeof candidate.data === 'object' && candidate.data !== null) sources.push(candidate.data)
    sources.push(candidate)
  }
  let limit
  let used
  let resetTime
  for (const source of sources) {
    const candidate = typeof source.limitNum === 'number' ? source.limitNum
      : typeof source.limit_num === 'number' ? source.limit_num : undefined
    if (candidate === undefined) continue
    limit = candidate
    used = typeof source.credit === 'number' ? source.credit
      : typeof source.used_num === 'number' ? source.used_num : undefined
    if (typeof source.cycleResetTime === 'string' && source.cycleResetTime !== '') resetTime = source.cycleResetTime
    break
  }
  if (limit === undefined) {
    throw upstreamError('MALFORMED_RESPONSE', 'WorkBuddy enterprise billing carried no recognised quota field')
  }
  if (limit === -1) {
    return {
      total: 0,
      accounts: [{ packageName: 'enterprise', remain: 0, size: 0, unlimited: true }],
      unlimited: true,
      ...(resetTime === undefined ? {} : { cycleResetTime: resetTime }),
    }
  }
  if (used === undefined) {
    throw upstreamError('MALFORMED_RESPONSE', 'WorkBuddy enterprise billing carried a quota but no usage field')
  }
  const remain = Math.max(0, limit - used)
  return {
    total: remain,
    accounts: [{ packageName: 'enterprise', remain, size: limit }],
    ...(resetTime === undefined ? {} : { cycleResetTime: resetTime }),
  }
}

/**
 * One reasoning-effort probe request: a real streaming chat call carrying the
 * effort under test. Resolves with the first event's acceptance signal rather
 * than a completion; the answer body is never assembled.
 */
export async function probeEffortAttempt(credential, model, effort, options = {}) {
  const global = regionOf(credential.domain) === 'global'
  const payload = {
    model,
    stream: true,
    messages: [
      ...(global ? [{ role: 'system', content: 'You are a helpful assistant.' }] : []),
      { role: 'user', content: 'ping' },
    ],
    max_tokens: global ? 16 : 1,
  }
  if (effort !== undefined) payload.reasoning_effort = effort
  const controller = new AbortController()
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), options.timeoutMs)
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal])
  try {
    const response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(credential, options.appVersion),
      body: JSON.stringify(payload),
      redirect: 'error',
      signal,
    })
    if (!response.ok) {
      const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
      return { status: response.status, streamed: false, ...errorCodeOf(text) }
    }
    const streamed = await readFirstDataLine(response)
    return { status: response.status, streamed }
  } catch (error) {
    return { status: 0, streamed: false, detail: `transport error: ${String(error)}` }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Pull `extError.code` out of an upstream error body. */
function errorCodeOf(text) {
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      const ext = parsed.extError
      if (typeof ext === 'object' && ext !== null && typeof ext.code === 'string') {
        return { errorCode: ext.code, detail: ext.code }
      }
    }
  } catch {
    // not JSON
  }
  return { detail: text.slice(0, 200) }
}

/** Consume a streaming response until its first `data:` line, then hang up. */
async function readFirstDataLine(response) {
  if (response.body === null) return false
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return false
      if (decoder.decode(value, { stream: true }).includes('data:')) return true
    }
  } catch {
    return false
  } finally {
    try { await reader.cancel() } catch { /* already closed */ }
  }
}

/** Expose the resolved bases for diagnostics. */
export function basesFor(credential) {
  return { chat: chatBase(credential), billing: billingBase(credential), region: regionOf(credential.domain) }
}
