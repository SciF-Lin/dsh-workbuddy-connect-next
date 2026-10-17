/**
 * Per-account plugin preferences: which models are hidden from the picker, and
 * which reasoning-effort spellings a probe observed as accepted.
 *
 * Both files are version-tagged, keyed by the signed-in account
 * (`uid:enterpriseId`), written atomically with a 0o600 mode, and read as
 * "nothing saved" when malformed. Neither file ever stores a token.
 *
 * @module dsh-workbuddy-connect-next/preferences
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** `uid:enterpriseId` identity for a credential. */
export function accountKeyOf(credential) {
  if (credential === undefined || credential === null) return undefined
  return `${credential.uid ?? ''}:${credential.enterpriseId ?? ''}`
}

/** One small JSON document with serialized atomic writes. */
class JsonStateFile {
  #path
  #cache
  #loading
  #writeChain = Promise.resolve()

  constructor(path) {
    this.#path = path
  }

  async load() {
    this.#loading ??= this.#read()
    return this.#loading
  }

  async #read() {
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && parsed.version === 1) return parsed
    } catch {
      // absent or malformed: start empty
    }
    return { version: 1, accounts: {} }
  }

  /** Read-modify-write one document, serialized across callers. */
  async mutate(change) {
    const run = this.#writeChain.then(async () => {
      const document = structuredClone(await this.load())
      if (typeof document.accounts !== 'object' || document.accounts === null) document.accounts = {}
      const result = change(document)
      await mkdir(dirname(this.#path), { recursive: true })
      const temp = `${this.#path}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.#path)
      // Keep the memoized snapshot in step with the file so readers in this
      // process see the write immediately.
      this.#loading = Promise.resolve(structuredClone(document))
      return result
    })
    this.#writeChain = run.catch(() => {})
    return run
  }
}

/** Hidden-model preferences per account; a missing entry means "visible". */
export class VisibilityStore {
  #file

  constructor({ home, path }) {
    this.#file = new JsonStateFile(path ?? join(home, '.workbuddy-connect-next-visibility.json'))
  }

  async init() {
    await this.#file.load()
  }

  async hiddenIds(account) {
    const document = await this.#file.load()
    const entry = account === undefined ? undefined : document.accounts[account]
    return new Set(Array.isArray(entry?.disabled) ? entry.disabled : [])
  }

  async setHidden(account, modelId, hidden) {
    if (account === undefined) throw new Error('no signed-in account to store a visibility preference for')
    return this.#file.mutate(document => {
      const entry = typeof document.accounts[account] === 'object' && document.accounts[account] !== null
        ? document.accounts[account]
        : { account, disabled: [], updatedAtMs: 0 }
      const disabled = new Set(Array.isArray(entry.disabled) ? entry.disabled : [])
      if (hidden) disabled.add(modelId)
      else disabled.delete(modelId)
      document.accounts[account] = {
        account,
        disabled: [...disabled],
        updatedAtMs: Date.now(),
      }
      return [...disabled]
    })
  }
}

/** Probe observations stay usable for this long before a re-sweep is offered. */
const PROBE_RECORD_TTL_MS = 14 * 24 * 60 * 60 * 1000

/** Probe observations per account, keyed by model id and validated by fingerprint. */
export class ProbeStore {
  #file

  constructor({ home, path }) {
    this.#file = new JsonStateFile(path ?? join(home, '.workbuddy-connect-next-probe.json'))
  }

  async init() {
    await this.#file.load()
  }

  /** The record usable for this account/model/fingerprint, or undefined. */
  async recordFor(account, modelId, fingerprint) {
    if (account === undefined) return undefined
    const document = await this.#file.load()
    const record = document.accounts?.[account]?.models?.[modelId]
    if (typeof record !== 'object' || record === null) return undefined
    if (record.fingerprint !== fingerprint) return undefined
    if (!Array.isArray(record.efforts)) return undefined
    if (typeof record.atMs !== 'number' || Date.now() - record.atMs > PROBE_RECORD_TTL_MS) return undefined
    return record
  }

  /** Every record for one account, as `{[modelId]: record}`. */
  async recordsFor(account) {
    if (account === undefined) return {}
    const document = await this.#file.load()
    const models = document.accounts?.[account]?.models
    return typeof models === 'object' && models !== null ? models : {}
  }

  async save(account, modelId, fingerprint, outcome) {
    if (account === undefined) throw new Error('no signed-in account to attribute a probe to')
    return this.#file.mutate(document => {
      const entry = typeof document.accounts[account] === 'object' && document.accounts[account] !== null
        ? document.accounts[account]
        : { account, models: {}, updatedAtMs: 0 }
      const models = typeof entry.models === 'object' && entry.models !== null ? entry.models : {}
      models[modelId] = {
        fingerprint,
        validation: outcome.validation,
        efforts: [...outcome.efforts],
        requests: outcome.requests,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        atMs: Date.now(),
      }
      document.accounts[account] = { account, models, updatedAtMs: Date.now() }
      return models[modelId]
    })
  }
}
