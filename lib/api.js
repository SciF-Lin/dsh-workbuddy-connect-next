/**
 * Host-side API for the plugin UI: one status snapshot plus the mutating
 * actions the card and the balance chip perform (refresh balance, refresh the
 * model list, hide/show a model, probe one model's reasoning efforts).
 *
 * Served over two same-origin HTTP routes by {@link registerWorkBuddyRoutes};
 * the browser half is a plain fetch client. Every mutation requires the
 * `x-workbuddy-connect: 1` header and is refused off loopback, so a stray web
 * page cannot spend the account's credits.
 *
 * @module dsh-workbuddy-connect-next/api
 */
import { accountKeyOf } from './preferences.js'
import { fingerprintModel, probeModel } from './probe.js'
import { fetchCredit, probeEffortAttempt } from './upstream.js'

const ROUTE_STATUS = '/workbuddy-connect-next/status'
const ROUTE_ACTION = '/workbuddy-connect-next/action'
const REQUEST_LIMIT = 64 * 1024

/** Read and parse one JSON request body with a size cap. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > REQUEST_LIMIT) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('body must be a JSON object')
  return parsed
}

/** Refuse requests that did not come from the page of this same origin. */
function refusalFor(req) {
  const address = req.socket?.remoteAddress ?? ''
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return 'loopback clients only'
  if (req.headers['x-workbuddy-connect'] !== '1') return 'missing x-workbuddy-connect header'
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    const host = req.headers.host
    if (typeof host !== 'string') return 'missing Host header'
    const allowed = [`http://${host}`, `https://${host}`]
    if (!allowed.includes(origin)) return 'unexpected Origin'
  }
  return undefined
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/** One shared API instance per plugin activation. */
export class WorkBuddyApi {
  #options
  #credit
  #probeQueue = Promise.resolve()
  #probePending = new Map()

  constructor(options) {
    this.#options = options
    this.#credit = { state: 'idle' }
  }

  /** Current account key, or undefined while signed out. */
  async accountKey() {
    try {
      return accountKeyOf(await this.#options.store.current())
    } catch {
      return undefined
    }
  }

  /** The record the adapter may use to expose probed efforts. */
  async probeRecordFor(model) {
    const key = await this.accountKey()
    if (key === undefined) return undefined
    return this.#options.probeStore.recordFor(key, model.id, fingerprintModel(model))
  }

  /** Reduce the raw package list to display groups, newest usefulness first. */
  #creditForDisplay() {
    const credit = this.#credit
    if (credit.state !== 'ready' || !Array.isArray(credit.accounts)) return credit
    const groups = new Map()
    for (const account of credit.accounts) {
      const name = account.packageName || '(unnamed)'
      const group = groups.get(name) ?? { packageName: name, remain: 0, size: 0, endTimeMs: undefined }
      group.remain += account.remain ?? 0
      group.size += account.size ?? 0
      if (typeof account.endTimeMs === 'number') {
        group.endTimeMs = group.endTimeMs === undefined ? account.endTimeMs : Math.min(group.endTimeMs, account.endTimeMs)
      }
      groups.set(name, group)
    }
    const list = [...groups.values()]
      .filter(group => group.remain > 0 || group.size > 0)
      .sort((a, b) => b.remain - a.remain)
    return {
      ...credit,
      accounts: list.slice(0, 6),
      hiddenPackages: Math.max(0, list.length - 6),
      packageCount: credit.accounts.length,
    }
  }

  /** Assemble the status document the card and the chip render. */
  async snapshot() {
    const { store, catalog, visibility, probeStore } = this.#options
    const status = await store.status()
    const credential = status.state === 'signed-in' ? await store.current().catch(() => undefined) : undefined
    const account = accountKeyOf(credential)
    const hidden = await visibility.hiddenIds(account)
    const records = await probeStore.recordsFor(account)
    const models = catalog.models().map(model => {
      const record = records[model.id]
      const sameFingerprint = record !== undefined && record.fingerprint === fingerprintModel(model)
      return {
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        supportsImages: model.supportsImages,
        billing: model.billing ?? {},
        declaredEfforts: model.reasoning?.efforts ?? [],
        supportsReasoning: model.reasoning?.supports === true,
        visible: !hidden.has(model.id),
        probe: sameFingerprint
          ? {
            validation: record.validation,
            efforts: record.efforts,
            requests: record.requests,
            reason: record.reason,
            atMs: record.atMs,
          }
          : undefined,
      }
    })
    return {
      ok: true,
      plugin: {
        name: 'dsh-workbuddy-connect-next',
        providerId: this.#options.providerId,
        providerName: this.#options.providerName,
      },
      account: {
        ...status,
        enterprise: credential?.enterpriseId !== undefined,
      },
      credit: this.#creditForDisplay(),
      catalog: {
        source: catalog.source,
        count: catalog.models().length,
        fetchedAtMs: catalog.fetchedAtMs,
        error: catalog.lastError,
      },
      models,
    }
  }

  /** Re-read the model roster; returns the new snapshot. */
  async refreshModels() {
    await this.#options.catalog.refresh(true)
    return this.snapshot()
  }

  /** Query the account's remaining credit; returns the new snapshot. */
  async refreshBalance() {
    const credential = await this.#options.store.resolve().catch(error => {
      this.#credit = { state: 'error', error: String(error), fetchedAtMs: Date.now() }
      return undefined
    })
    if (credential === undefined) return this.snapshot()
    try {
      const credits = await fetchCredit(credential)
      this.#credit = { state: 'ready', ...credits, fetchedAtMs: Date.now() }
    } catch (error) {
      this.#credit = { state: 'error', error: String(error), fetchedAtMs: Date.now() }
    }
    return this.snapshot()
  }

  /** Hide or show one model in the picker for the signed-in account. */
  async setVisibility(modelId, visible) {
    const key = await this.accountKey()
    if (key === undefined) throw new Error('no signed-in WorkBuddy account')
    await this.#options.visibility.setHidden(key, String(modelId), visible !== true)
    this.#options.onRegistrationChanged?.()
    return this.snapshot()
  }

  /**
   * Probe one model's reasoning efforts. Serial (a real chat must not contend
   * with a sweep) and attributed to the account that started it.
   */
  async probeEffort(modelId) {
    const id = String(modelId)
    const pending = this.#probePending.get(id)
    if (pending !== undefined) return pending
    const run = this.#probeQueue.then(async () => {
      const credential = await this.#options.store.resolve()
      const key = accountKeyOf(credential)
      const model = this.#options.catalog.find(id)
      if (model === undefined) throw new Error(`unknown WorkBuddy model: ${id}`)
      if ((model.reasoning?.efforts ?? []).length > 0) {
        return { state: 'declared', message: 'this model already declares its reasoning efforts' }
      }
      const outcome = await probeModel({
        region: this.#options.region,
        send: (effort, signal) => probeEffortAttempt(credential, id, effort, {
          signal,
          appVersion: this.#options.appVersion,
        }),
      })
      // The account may have switched while the sweep ran; only attribute the
      // observation when the same identity is still signed in.
      const still = accountKeyOf(await this.#options.store.current().catch(() => undefined))
      if (still !== key) return { state: 'unavailable', reason: 'the WorkBuddy account changed during the probe' }
      await this.#options.probeStore.save(key, id, fingerprintModel(model), outcome)
      this.#options.onRegistrationChanged?.()
      return { state: 'ok', ...outcome }
    })
    this.#probeQueue = run.catch(() => {})
    const tracked = run.finally(() => this.#probePending.delete(id))
    this.#probePending.set(id, tracked)
    return tracked
  }

  /** Dispatch one action document. */
  async act(body) {
    const action = String(body.action ?? '')
    try {
      if (action === 'refresh-balance') return { ok: true, snapshot: await this.refreshBalance() }
      if (action === 'refresh-models') return { ok: true, snapshot: await this.refreshModels() }
      if (action === 'set-visibility') {
        return { ok: true, snapshot: await this.setVisibility(body.modelId, body.visible === true) }
      }
      if (action === 'probe') {
        const result = await this.probeEffort(body.modelId)
        return { ok: true, result, snapshot: await this.snapshot() }
      }
      return { ok: false, error: `unknown action: ${action}` }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Register both routes on the host web server; returns the disposers. */
  register(webServer) {
    const disposers = []
    disposers.push(webServer.register({
      kind: 'exact',
      path: ROUTE_STATUS,
      handler: async (req, res) => {
        const refusal = refusalFor(req)
        if (refusal !== undefined) return sendJson(res, 403, { ok: false, error: refusal })
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
        try {
          sendJson(res, 200, await this.snapshot())
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: ROUTE_ACTION,
      handler: async (req, res) => {
        const refusal = refusalFor(req)
        if (refusal !== undefined) return sendJson(res, 403, { ok: false, error: refusal })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        sendJson(res, 200, await this.act(body))
      },
    }))
    return disposers
  }
}

export { ROUTE_STATUS, ROUTE_ACTION }
