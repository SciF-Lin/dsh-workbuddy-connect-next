/**
 * The Harness LLM adapter for WorkBuddy: provider metadata, model capability,
 * and the streaming translation from OpenAI-compatible chunks into the
 * Harness stream protocol.
 *
 * @module dsh-workbuddy-connect-next/adapter
 */
import { buildChatBody, readSseJson, requestChat, upstreamError } from './upstream.js'

const PROVIDER_NAME = 'WorkBuddy'

const EFFORT_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

/** The canonical effort ids, for validating probe observations. */
const EFFORT_IDS = Object.keys(EFFORT_LABELS)

/** Retry policy applied to this route. */
const RETRY_POLICY = {
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TRANSPORT', 'EMPTY_RESPONSE'],
  initialDelayMs: 1000,
  maxDelayMs: 20_000,
  jitterRatio: 0.2,
}

/**
 * Build a failure error the LLM service normalizes, carrying the code and
 * status where the runtime can use them.
 */
function llmFailure(code, message, status) {
  return upstreamError(code, message, status)
}

/** Map the upstream finish reason onto the Harness finish reason. */
function finishReasonOf(raw) {
  switch (raw) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'length':
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'content_filter':
    case 'stop':
    case undefined:
    case null:
    case '':
      return { kind: 'stop' }
    default:
      return { kind: 'stop' }
  }
}

/** Fold one upstream usage document into the accumulated usage. */
function foldUsage(usage, raw) {
  if (typeof raw !== 'object' || raw === null) return
  const input = raw.prompt_tokens
  const output = raw.completion_tokens
  if (Number.isSafeInteger(input) && input >= 0) usage.inputTokens = input
  if (Number.isSafeInteger(output) && output >= 0) usage.outputTokens = output
  const cacheRead = raw.prompt_cache_hit_tokens ?? raw.prompt_cache_read_tokens
  if (Number.isSafeInteger(cacheRead) && cacheRead > 0) usage.cacheReadTokens = cacheRead
  const reasoning = raw.completion_tokens_details?.reasoning_tokens ?? raw.completion_tokens_details?.reasoning
  if (Number.isSafeInteger(reasoning) && reasoning > 0) usage.reasoningTokens = reasoning
}

/**
 * Translate the upstream chunk stream into Harness stream chunks.
 *
 * Blocks are opened on first delta, closed when a different block kind starts
 * or at settlement, and indices count in opening order.
 */
export class WorkBuddyAdapter {
  #catalog
  #store
  #options

  constructor(options) {
    this.#catalog = options.catalog
    this.#store = options.store
    this.#options = options
  }

  providerInfo(provider) {
    return { id: provider, name: this.#options.providerName ?? PROVIDER_NAME }
  }

  providerRetryPolicy() {
    return RETRY_POLICY
  }

  async listModels(provider) {
    await this.#catalog.init()
    const hidden = this.#options.visibility === undefined
      ? new Set()
      : await this.#options.visibility.hiddenIds(await this.#options.accountKey?.())
    return this.#catalog.models()
      .filter(model => !hidden.has(model.id))
      .map(model => ({
        provider,
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        inputModalities: model.supportsImages ? ['text', 'image'] : ['text'],
      }))
  }

  async resolveModel(provider, model) {
    const entry = this.#catalog.find(model)
    if (entry === undefined) {
      throw llmFailure(
        'UNKNOWN_MODEL',
        `WorkBuddy has no model "${model}"; refresh the model list or pick one from the WorkBuddy group`,
      )
    }
    let effortIds = entry.reasoning.supports ? entry.reasoning.efforts : []
    let defaultEffort = entry.reasoning.defaultEffort
    // A declared set always wins; only undeclared models consult observations.
    if (entry.reasoning.supports && effortIds.length === 0 && this.#options.probeRecordFor !== undefined) {
      const record = await this.#options.probeRecordFor(entry)
      if (record !== undefined && record.validation === 'validating') {
        effortIds = record.efforts.filter(effort => EFFORT_IDS.includes(effort))
        if (defaultEffort === undefined || !effortIds.includes(defaultEffort)) defaultEffort = undefined
      }
    }
    const efforts = effortIds.length > 0
      ? effortIds.map(id => ({ id, name: EFFORT_LABELS[id] ?? id }))
      : undefined
    return {
      provider,
      id: entry.id,
      name: entry.name,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      inputModalities: entry.supportsImages ? ['text', 'image'] : ['text'],
      context: { contextWindow: entry.contextWindow },
      defaultMaxTokens: entry.maxTokens,
      ...(efforts === undefined ? {} : {
        reasoning: {
          efforts,
          ...(defaultEffort === undefined ? {} : { defaultEffort }),
        },
      }),
    }
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: 8 * 1024 * 1024 }
  }

  imageRequestPricing() {
    return undefined
  }

  async prepareCall(provider, model, signal) {
    signal?.throwIfAborted()
    await this.#catalog.init()
    const info = await this.resolveModel(provider, model)
    return {
      model: info,
      stream: options => this.stream(options),
    }
  }

  async *stream(options) {
    await this.#catalog.init()
    const entry = this.#catalog.find(options.model)
    if (entry === undefined) {
      throw llmFailure('UNKNOWN_MODEL', `WorkBuddy has no model "${options.model}"`)
    }
    const signal = options.signal
    signal?.throwIfAborted()
    const attachmentReader = this.#options.resolveAttachments?.()
    const resolveImage = attachmentReader === undefined
      ? undefined
      : async (ref) => {
        if (ref === undefined) return undefined
        const stored = await attachmentReader.readImage(ref, signal)
        return { mediaType: stored.ref.mediaType, data: stored.data }
      }
    const body = await buildChatBody(options, resolveImage)
    if (body.max_tokens === undefined) body.max_tokens = entry.maxTokens
    if (body.temperature === undefined && entry.temperature !== undefined) body.temperature = entry.temperature
    if (body.tools !== undefined && entry.supportsToolCall === false) delete body.tools
    const credential = await this.#store.resolve()
    const response = await requestChat(credential, body, {
      appVersion: this.#options.appVersion,
      signal,
    })
    yield* this.#translate(response, signal)
  }

  async *#translate(response, signal) {
    /** Open blocks in opening order. */
    const opened = []
    const byKey = new Map()
    let nextIndex = 0
    const usage = { inputTokens: 0, outputTokens: 0 }
    let finish
    let sawAnyChunk = false

    const closeBlock = block => {
      if (block.closed) return undefined
      block.closed = true
      if (block.type === 'tool-call') {
        block.content = { ...block.content, arguments: block.arguments }
      }
      return { type: 'block-end', index: block.index, block: { ...block.content } }
    }

    const openBlock = (key, type, content) => {
      const block = { key, type, index: nextIndex++, content, closed: false }
      opened.push(block)
      byKey.set(key, block)
      return block
    }

    try {
      for await (const chunk of readSseJson(response, signal)) {
        sawAnyChunk = true
        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
        if (choice === undefined) {
          foldUsage(usage, chunk.usage)
          continue
        }
        const delta = typeof choice.delta === 'object' && choice.delta !== null ? choice.delta : {}
        const reasoning = delta.reasoning_content
        if (typeof reasoning === 'string' && reasoning !== '') {
          let block = byKey.get('reasoning')
          if (block === undefined) {
            // A different open block must settle before this one begins.
            const previous = opened.at(-1)
            if (previous !== undefined && !previous.closed) {
              const chunkOut = closeBlock(previous)
              if (chunkOut !== undefined) yield chunkOut
            }
            block = openBlock('reasoning', 'reasoning', { type: 'reasoning', text: '' })
            yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
          }
          block.content.text += reasoning
          yield { type: 'reasoning-delta', index: block.index, text: reasoning }
        }
        const text = delta.content
        if (typeof text === 'string' && text !== '') {
          let block = byKey.get('text')
          if (block === undefined) {
            const previous = opened.at(-1)
            if (previous !== undefined && !previous.closed) {
              const chunkOut = closeBlock(previous)
              if (chunkOut !== undefined) yield chunkOut
            }
            block = openBlock('text', 'text', { type: 'text', text: '' })
            yield { type: 'block-start', index: block.index, blockType: 'text' }
          }
          block.content.text += text
          yield { type: 'text-delta', index: block.index, text }
        }
        const calls = delta.tool_calls
        if (Array.isArray(calls)) {
          for (const call of calls) {
            if (typeof call !== 'object' || call === null) continue
            const callIndex = Number.isSafeInteger(call.index) ? call.index : 0
            const key = `tool:${callIndex}`
            let block = byKey.get(key)
            const fn = typeof call.function === 'object' && call.function !== null ? call.function : {}
            if (block === undefined) {
              const previous = opened.at(-1)
              if (previous !== undefined && !previous.closed) {
                const chunkOut = closeBlock(previous)
                if (chunkOut !== undefined) yield chunkOut
              }
              const id = String(call.id ?? '')
              const name = String(fn.name ?? '')
              if (id === '' && name === '') continue
              block = openBlock(key, 'tool-call', { type: 'tool-call', id, name, arguments: '' })
              block.arguments = ''
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
              yield { type: 'tool-call-delta', index: block.index, id, name, argumentsDelta: '' }
            }
            const argsDelta = typeof fn.arguments === 'string' ? fn.arguments : ''
            if (argsDelta !== '') {
              block.arguments += argsDelta
              yield {
                type: 'tool-call-delta',
                index: block.index,
                id: block.content.id,
                argumentsDelta: argsDelta,
              }
            }
          }
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          finish = finishReasonOf(choice.finish_reason)
        }
        foldUsage(usage, chunk.usage)
      }
    } finally {
      // Settlement happens in the caller-visible path below; the reader closes
      // the HTTP stream in its own finally block.
    }

    if (signal?.aborted) throw llmFailure('ABORTED', 'WorkBuddy request aborted')
    if (!sawAnyChunk) throw llmFailure('EMPTY_RESPONSE', 'WorkBuddy returned an empty stream')

    for (const block of opened) {
      if (block.closed) continue
      const chunkOut = closeBlock(block)
      if (chunkOut !== undefined) yield chunkOut
    }

    if (opened.length === 0) {
      const emptyError = llmFailure('EMPTY_RESPONSE', 'WorkBuddy returned no content')
      throw emptyError
    }

    usage.totalTokens = usage.inputTokens + usage.outputTokens
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: finish ?? { kind: 'stop' } }
  }
}
