/**
 * DSH WorkBuddy Connect (Next) — Host half.
 *
 * Registers one LLM provider route whose adapter speaks the WorkBuddy desktop
 * upstream directly, using the app's own sign-in. The former plugin reached
 * this through a pi-ai shim and a loopback OpenAI proxy; the current kernel's
 * `llm.registerAdapter` makes the shim unnecessary, so this plugin is a single
 * adapter with no third-party dependencies.
 *
 * It also serves the small same-origin HTTP API the browser half (balance chip
 * and the bundle's Plugins page card) uses for status, balance, model
 * visibility, and reasoning-effort probes.
 *
 * @module dsh-workbuddy-connect-next
 */
import { WorkBuddyAdapter } from './lib/adapter.js'
import { WorkBuddyApi } from './lib/api.js'
import { WorkBuddyCatalog } from './lib/catalog.js'
import { WorkBuddyCredentialStore, dshHome } from './lib/credential.js'
import { ProbeStore, VisibilityStore } from './lib/preferences.js'
import { refreshCredential } from './lib/upstream.js'

/** Wait for the LLM registry before activating. */
export const inject = ['llm']

/** Default route id shown as the provider group in the model picker. */
const DEFAULT_PROVIDER_ID = 'workbuddy'
const DEFAULT_PROVIDER_NAME = 'WorkBuddy'
const REFRESH_INTERVAL_MS = 30 * 60 * 1000

/**
 * Host plugin body.
 *
 * @param ctx - plugin lifetime with the LLM registry injected.
 * @param config - optional `{ providerId, providerName, authFile, electronPath, appVersion }`.
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger
  const home = dshHome()
  const providerName = typeof config.providerName === 'string' && config.providerName !== ''
    ? config.providerName
    : DEFAULT_PROVIDER_NAME
  const appVersion = typeof config.appVersion === 'string' ? config.appVersion : undefined

  const store = new WorkBuddyCredentialStore({
    authCandidates: typeof config.authFile === 'string' && config.authFile !== '' ? [config.authFile] : undefined,
    electronPath: typeof config.electronPath === 'string' && config.electronPath !== '' ? config.electronPath : undefined,
    ownPath: config.ownAuthPath,
    refresh: credential => refreshCredential(credential),
    logger,
  })

  const catalog = new WorkBuddyCatalog({
    home,
    cachePath: config.catalogCachePath,
    resolveCredential: () => store.resolve(),
    logger,
  })

  const visibility = new VisibilityStore({ home, path: config.visibilityPath })
  const probeStore = new ProbeStore({ home, path: config.probePath })

  let route = typeof config.providerId === 'string' && config.providerId !== ''
    ? config.providerId
    : DEFAULT_PROVIDER_ID
  let registration

  const reemit = () => {
    try {
      registration?.replace([route])
    } catch {
      // the fiber is gone; nothing to refresh
    }
  }

  const api = new WorkBuddyApi({
    store,
    catalog,
    visibility,
    probeStore,
    providerId: route,
    providerName,
    appVersion,
    region: 'cn',
    onRegistrationChanged: reemit,
  })

  const adapter = new WorkBuddyAdapter({
    catalog,
    store,
    visibility,
    probeRecordFor: model => api.probeRecordFor(model),
    accountKey: () => api.accountKey(),
    providerName,
    appVersion,
    resolveAttachments: () => ctx.get('attachments'),
  })

  void Promise.all([catalog.init(), visibility.init(), probeStore.init()])
    .then(() => catalog.refresh())
    .then(() => reemit())
    .catch(error => {
      logger?.warn?.(`workbuddy-connect-next: initial refresh failed (${String(error)})`)
    })

  // Keep the roster reasonably current without blocking anything.
  const timer = setInterval(() => {
    void catalog.refresh(true).then(() => reemit()).catch(() => {})
  }, REFRESH_INTERVAL_MS)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer))

  // Same-origin HTTP API for the browser half (status, balance, visibility,
  // probe). The web server may be mounted after this plugin on a cold boot, so
  // wait for the service instead of reading `ctx.get` once during apply.
  ctx.inject(['webServer'], child => {
    child.effect(() => {
      const disposers = api.register(child.webServer)
      return () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* already disposed */ }
        }
      }
    })
  })

  // A broken pi-ai-based predecessor may still own the plain route id; claim
  // it when free and fall back to a suffixed route instead of failing to mount.
  try {
    registration = ctx.llm.registerAdapter([route], adapter)
  } catch (error) {
    if (!/DUPLICATE_ADAPTER|adapter/iu.test(String(error?.message ?? error))) throw error
    route = `${route}-next`
    logger?.warn?.(`workbuddy-connect-next: route "${DEFAULT_PROVIDER_ID}" is already registered (${String(error)}); using "${route}"`)
    registration = ctx.llm.registerAdapter([route], adapter)
  }
  logger?.info?.(`workbuddy-connect-next: WorkBuddy provider route "${route}" registered as "${providerName}"`)
}
