/**
 * WorkBuddy model catalog: fetched from the product document, cached on disk,
 * and served to the model picker even while the network or sign-in is down.
 *
 * @module dsh-workbuddy-connect-next/catalog
 */
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fetchCatalog } from './upstream.js'

/** Baseline rows used only when neither the network nor a cache can answer. */
const FALLBACK_MODELS = [
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, maxTokens: 131_072, supportsImages: true, supportsToolCall: true, reasoning: { supports: true, onlyReasoning: true, efforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: false }, billing: {} },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 64_000, supportsImages: true, supportsToolCall: true, reasoning: { supports: true, onlyReasoning: true, efforts: ['low', 'high', 'max'], defaultEffort: 'max', canDisableThinking: false }, billing: {} },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, supportsToolCall: true, reasoning: { supports: true, onlyReasoning: true, efforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: {} },
  { id: 'kimi-k3-1', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000, supportsImages: true, supportsToolCall: true, reasoning: { supports: true, onlyReasoning: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', canDisableThinking: false }, billing: {} },
]

const CACHE_FILENAME = '.workbuddy-connect-next-catalog.json'

/**
 * One catalog shared by the plugin: disk cache first, then a network refresh.
 * Refresh failures never empty a working list.
 */
export class WorkBuddyCatalog {
  #options
  #models = []
  #source = 'none'
  #fetchedAtMs
  #lastError
  #inflight
  #initialized

  constructor(options) {
    this.#options = {
      ttlMs: 10 * 60 * 1000,
      ...options,
    }
  }

  /** Load the on-disk cache once; safe to call repeatedly. */
  init() {
    this.#initialized ??= this.#loadCache()
    return this.#initialized
  }

  /** Whether a list is currently servable. */
  get ready() {
    return this.#models.length > 0
  }

  /** Current model rows (possibly cached or fallback). */
  models() {
    return this.#models.length > 0 ? this.#models : FALLBACK_MODELS
  }

  /** Source label for diagnostics. */
  get source() {
    return this.#source
  }

  get fetchedAtMs() {
    return this.#fetchedAtMs
  }

  get lastError() {
    return this.#lastError
  }

  /** Find one row by id. */
  find(id) {
    return this.models().find(model => model.id === id)
  }

  /**
   * Refresh from upstream when stale, or forced. Concurrent callers share one
   * request; a failure keeps the previous list and records the reason.
   */
  async refresh(force = false) {
    await this.init()
    const fresh = this.#fetchedAtMs !== undefined && Date.now() - this.#fetchedAtMs < this.#options.ttlMs
    if (!force && fresh) return this.models()
    this.#inflight ??= this.#fetchNow().finally(() => { this.#inflight = undefined })
    return this.#inflight
  }

  async #fetchNow() {
    try {
      const credential = await this.#options.resolveCredential()
      const models = await fetchCatalog(credential, { timeoutMs: 20_000 })
      if (models.length > 0) {
        this.#models = models
        this.#source = 'upstream'
        this.#fetchedAtMs = Date.now()
        this.#lastError = undefined
        await this.#saveCache(models)
      }
      return this.models()
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error)
      this.#options.logger?.warn?.(`workbuddy-connect-next: model list refresh failed (${this.#lastError}); keeping ${this.#source} list`)
      return this.models()
    }
  }

  async #cachePath() {
    return this.#options.cachePath ?? join(this.#options.home, CACHE_FILENAME)
  }

  async #loadCache() {
    try {
      const path = await this.#cachePath()
      const text = await readFile(path, 'utf8')
      const parsed = JSON.parse(text)
      if (!Array.isArray(parsed?.models) || parsed.models.length === 0) return
      this.#models = parsed.models
      this.#source = 'cache'
      this.#fetchedAtMs = typeof parsed.fetchedAtMs === 'number' ? parsed.fetchedAtMs : undefined
    } catch {
      this.#source = 'fallback'
    }
  }

  async #saveCache(models) {
    try {
      const path = await this.#cachePath()
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify({ version: 1, fetchedAtMs: Date.now(), models }, null, 2)}\n`)
      await rename(temp, path)
    } catch (error) {
      this.#options.logger?.warn?.(`workbuddy-connect-next: could not persist the model cache (${String(error)})`)
    }
  }

  /** Drop the cache; used by the diagnostics surface. */
  async clearCache() {
    try {
      await rm(await this.#cachePath(), { force: true })
    } catch {
      // best effort
    }
  }
}
