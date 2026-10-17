/**
 * WorkBuddy credential resolution for DeepSeek Harness.
 *
 * The authority is the WorkBuddy desktop app's own auth file, read-only.
 * Since WorkBuddy 5.6 the token fields are sealed at rest with a key that
 * lives in the app's own Electron binary, reached by running that binary once
 * with `ELECTRON_RUN_AS_NODE=1` and calling its private storage binding.
 * Refreshed tokens are kept in a plugin-owned copy under $DSH_HOME so the
 * app's file is never written.
 *
 * @module dsh-workbuddy-connect-next/credential
 */
import { execFile } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** Basename of the plugin-owned credential copy inside the Harness home. */
export const OWN_AUTH_FILENAME = '.workbuddy-connect-next-auth.json'

/** Env variable overriding the desktop auth-file location. */
const AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'
/** Env variable naming the WorkBuddy Electron binary explicitly. */
const ELECTRON_BIN_ENV = 'WORKBUDDY_ELECTRON_BIN'

/** The private binding call whose stdout is the sealed at-rest payload. */
const KEY_HELPER_SCRIPT =
  'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'

const AUTH_RELATIVE_PATH = ['CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info']

/** Harness home; the same value the rest of the profile uses. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** Location of the plugin-owned refreshed-credential copy. */
export function ownAuthPath() {
  return join(dshHome(), OWN_AUTH_FILENAME)
}

/** Platform candidates for the desktop auth file, in probe order. */
export function desktopAuthCandidates() {
  const explicit = process.env[AUTH_FILE_ENV]?.trim()
  if (explicit) return [explicit]
  const home = homedir()
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', ...AUTH_RELATIVE_PATH)]
  }
  if (process.platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean)
    return roots.map(root => join(root, ...AUTH_RELATIVE_PATH))
  }
  const configHome = process.env.XDG_CONFIG_HOME?.trim()
  const dataHome = process.env.XDG_DATA_HOME?.trim()
  return [
    join(configHome && configHome.startsWith('/') ? configHome : join(home, '.config'), ...AUTH_RELATIVE_PATH),
    join(dataHome && dataHome.startsWith('/') ? dataHome : join(home, '.local', 'share'), ...AUTH_RELATIVE_PATH),
  ]
}

/** Default Electron binary candidates, in probe order. */
function defaultElectronCandidates() {
  const out = []
  if (process.platform === 'darwin') {
    out.push('/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy')
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA?.trim()
    if (local) out.push(join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'))
  }
  return out
}

/** One auth field envelope, decoded. */
function parseEnvelope(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined
  if (raw.$wbEncrypted !== 1 || typeof raw.envelope !== 'string') return undefined
  let inner
  try {
    inner = JSON.parse(Buffer.from(raw.envelope, 'base64').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof inner !== 'object' || inner === null) return undefined
  if (inner.suite !== 1) return undefined
  if (typeof inner.keyId !== 'string' || !/^[0-9a-f]{16}$/u.test(inner.keyId)) return undefined
  const nonce = Buffer.from(String(inner.nonce ?? ''), 'base64')
  const authTag = Buffer.from(String(inner.authTag ?? ''), 'base64')
  const ciphertext = Buffer.from(String(inner.ciphertext ?? ''), 'base64')
  if (nonce.length !== 12 || authTag.length !== 16 || ciphertext.length === 0) return undefined
  return { suite: inner.suite, keyId: inner.keyId, nonce, authTag, ciphertext }
}

/** The authenticated-context AAD for one credential field envelope (suite 1). */
function envelopeAad(keyId, suite) {
  const lengthPrefixed = (value) => {
    const bytes = Buffer.from(value, 'utf8')
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(bytes.length)
    return Buffer.concat([header, bytes])
  }
  const suiteBytes = Buffer.allocUnsafe(4)
  suiteBytes.writeUInt32BE(suite)
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    lengthPrefixed('WBEV1'),
    lengthPrefixed('sym-v1'),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

/** Open one sealed field; undefined when the key does not open it. */
function openSealedField(protectorKey, envelope) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', protectorKey, envelope.nonce, { authTagLength: 16 })
    decipher.setAAD(envelopeAad(envelope.keyId, envelope.suite))
    decipher.setAuthTag(envelope.authTag)
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

/** sha256 over the sealed secret's UTF-8 string, as the app derives it. */
function deriveProtectorKey(secret) {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** Validate the helper payload: `{version:1, atRestSecretKey:<32-byte b64>}`. */
function parseAtRestPayload(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  if (parsed.version !== 1) return undefined
  const secret = parsed.atRestSecretKey
  if (typeof secret !== 'string' || secret === '') return undefined
  const decoded = Buffer.from(secret, 'base64')
  if (decoded.length !== 32 || decoded.toString('base64') !== secret) return undefined
  if (decoded.every(byte => byte === 0)) return undefined
  return secret
}

/** Run one probe of the WorkBuddy binary for its sealed at-rest secret. */
function spawnKeyHelper(electronPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      electronPath,
      ['-e', KEY_HELPER_SCRIPT],
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = error.killed
            ? 'timed out'
            : error.code !== undefined
              ? `exit code ${error.code}`
              : error.message
          reject(new Error(
            `WorkBuddy credential helper at ${electronPath} did not produce a key (${detail})`
            + `${stderr && stderr.trim() ? `; stderr: ${stderr.trim().slice(0, 200)}` : ''}`,
          ))
          return
        }
        resolve(String(stdout ?? ''))
      },
    )
  })
}

/**
 * Locate the WorkBuddy Electron binary. Explicit env wins; then the platform
 * default; on Windows the uninstall registry is consulted last so a portable
 * or non-default installation is still discovered.
 */
async function resolveElectronPath(logger) {
  const explicit = process.env[ELECTRON_BIN_ENV]?.trim()
  if (explicit) return explicit
  for (const candidate of defaultElectronCandidates()) {
    try {
      const stat = await readFile(candidate, { flag: 'r' })
      if (stat.length >= 0) return candidate
    } catch {
      // absent; keep probing
    }
  }
  if (process.platform === 'win32') {
    const discovered = await discoverFromWindowsRegistry(logger)
    if (discovered) return discovered
  }
  throw new Error(
    'WorkBuddy desktop app not found; install it, or set '
    + `${ELECTRON_BIN_ENV} to its executable path (for example %LOCALAPPDATA%\\Programs\\WorkBuddy\\WorkBuddy.exe)`,
  )
}

/** Scan the Windows uninstall registry for a WorkBuddy executable path. */
function discoverFromWindowsRegistry(logger) {
  const systemRoot = process.env.SystemRoot?.trim() || 'C:\\Windows'
  const regPath = join(systemRoot, 'System32', 'reg.exe')
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  const query = root => new Promise(resolve => {
    execFile(regPath, ['query', root, '/s'], {
      timeout: 8000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    }, (error, stdout) => resolve(error ? '' : String(stdout ?? '')))
  })
  return (async () => {
    for (const root of roots) {
      const text = await query(root)
      if (!text) continue
      let nameSeen = false
      let keySeen = false
      for (const line of text.split(/\r?\n/u)) {
        const trimmed = line.trim()
        if (/^HKEY_/u.test(trimmed)) { nameSeen = false; keySeen = false; continue }
        if (!trimmed) continue
        const match = /^(DisplayName|DisplayIcon)\s+REG_\w+\s+(.*)$/u.exec(trimmed)
        if (!match) continue
        if (match[1] === 'DisplayName') {
          nameSeen = /workbuddy/iu.test(match[2])
          keySeen = true
        } else if (nameSeen) {
          const icon = match[2].trim().replace(/,\d+$/u, '').replace(/^"/u, '').replace(/"$/u, '')
          if (basename(icon).toLowerCase().endsWith('.exe') && /workbuddy/iu.test(icon)) {
            logger?.info?.(`workbuddy-connect-next: discovered WorkBuddy at ${icon} from the uninstall registry`)
            return icon
          }
        }
      }
    }
    return undefined
  })()
}

/**
 * In-memory protector key resolver: one helper spawn per key id, single-flight.
 * Never persisted, never logged.
 */
class ProtectorKeyProvider {
  #explicitBin
  #timeoutMs
  #logger
  #cache = new Map()
  #inflight

  constructor({ electronPath, timeoutMs = 20000, logger } = {}) {
    this.#explicitBin = electronPath
    this.#timeoutMs = timeoutMs
    this.#logger = logger
  }

  get helperPath() {
    return this.#explicitBin
  }

  async protectorKeyFor(requestedIds) {
    if (!Array.isArray(requestedIds) || requestedIds.length === 0) {
      throw new Error('encrypted WorkBuddy credential carries no key ids')
    }
    for (const id of requestedIds) {
      const cached = this.#cache.get(id)
      if (cached) return cached
    }
    this.#inflight ??= this.#resolve()
      .finally(() => { this.#inflight = undefined })
    const resolved = await this.#inflight
    if (!requestedIds.includes(resolved.keyId)) {
      throw new Error(
        `WorkBuddy's current at-rest key (id ${resolved.keyId}) does not match the credential envelope`
        + ` (id ${requestedIds.join(' or ')}); open the WorkBuddy app once so it reseals the sign-in, then retry`,
      )
    }
    return resolved.key
  }

  async #resolve() {
    const bin = this.#explicitBin ?? await resolveElectronPath(this.#logger)
    const output = await spawnKeyHelper(bin, this.#timeoutMs)
    const secret = parseAtRestPayload(output)
    if (!secret) {
      throw new Error(
        `the WorkBuddy binary at ${bin} did not return the expected at-rest key payload;`
        + ' update WorkBuddy or point ' + ELECTRON_BIN_ENV + ' at the correct installation',
      )
    }
    const key = deriveProtectorKey(secret)
    const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16)
    this.#cache.set(keyId, key)
    return { key, keyId }
  }
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value) {
  if (typeof value !== 'number' || value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Parse an auth document into the normalized credential. Accepts both the
 * nested `{auth, account}` shape and the flat panel shape.
 */
export function parseAuthDocument(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed
  const auth = typeof document.auth === 'object' && document.auth !== null ? document.auth : document
  const identity = typeof document.account === 'object' && document.account !== null ? document.account : document
  const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : ''
  if (accessToken === '') return undefined
  const enterpriseId = optionalString(identity.enterpriseId)
  const nickname = optionalString(identity.nickname)
  return {
    accessToken,
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    expiresAtMs: expiryToMs(auth.expiresAt),
    refreshExpiresAtMs: auth.refreshExpiresAt === undefined ? undefined : expiryToMs(auth.refreshExpiresAt),
    domain: optionalString(auth.domain) ?? '',
    uid: optionalString(identity.uid) ?? '',
    enterpriseId,
    nickname,
    source: 'desktop',
  }
}

/** Read the desktop auth document, decrypting sealed token fields when present. */
async function readDesktopCredential(paths, keyProvider, logger) {
  for (const path of paths) {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') continue
      throw error
    }
    if (text.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(
        `the WorkBuddy auth file at ${path} is not valid JSON; fix or remove it`,
      )
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`the WorkBuddy auth file at ${path} is not a credential document`)
    }
    const auth = typeof parsed.auth === 'object' && parsed.auth !== null ? parsed.auth : parsed
    const sealed = ['accessToken', 'refreshToken']
      .map(field => ({ field, envelope: parseEnvelope(auth[field]) }))
      .filter(entry => entry.envelope !== undefined)
    if (sealed.length === 0) {
      const plain = parseAuthDocument(text)
      if (plain) return plain
      continue
    }
    const key = await keyProvider.protectorKeyFor([...new Set(sealed.map(entry => entry.envelope.keyId))])
    const rebuilt = structuredClone(parsed)
    const target = typeof rebuilt.auth === 'object' && rebuilt.auth !== null ? rebuilt.auth : rebuilt
    for (const entry of sealed) {
      const plaintext = openSealedField(key, entry.envelope)
      if (plaintext === undefined) {
        throw new Error(
          `the encrypted WorkBuddy credential field "${entry.field}" could not be decrypted`
          + ` (envelope key id ${entry.envelope.keyId}); open the WorkBuddy app once to reseal the sign-in`,
        )
      }
      target[entry.field] = plaintext
    }
    const credential = parseAuthDocument(JSON.stringify(rebuilt))
    if (credential) return credential
    logger?.warn?.(`workbuddy-connect-next: auth file at ${path} carried no usable access token`)
  }
  return undefined
}

/** Parse the plugin-owned copy. */
function parseOwnDocument(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  if (parsed.version !== 1 || typeof parsed.credential !== 'object' || parsed.credential === null) return undefined
  const stored = parsed.credential
  if (typeof stored.accessToken !== 'string' || stored.accessToken === '') return undefined
  return {
    accessToken: stored.accessToken,
    refreshToken: typeof stored.refreshToken === 'string' ? stored.refreshToken : '',
    expiresAtMs: expiryToMs(stored.expiresAtMs),
    refreshExpiresAtMs: stored.refreshExpiresAtMs === undefined ? undefined : expiryToMs(stored.refreshExpiresAtMs),
    domain: optionalString(stored.domain) ?? '',
    uid: optionalString(stored.uid) ?? '',
    enterpriseId: optionalString(stored.enterpriseId),
    nickname: optionalString(stored.nickname),
    source: 'dsh',
  }
}

/**
 * Credential store with demand-driven refresh. The effective credential is the
 * one belonging to the currently signed-in app account, preferring the desktop
 * file on identity mismatch so a stale plugin copy can never speak as another
 * user.
 */
export class WorkBuddyCredentialStore {
  #options
  #keyProvider
  #inflight
  #ownPath
  #lastStatus

  constructor(options) {
    this.#options = options
    this.#ownPath = options.ownPath ?? ownAuthPath()
    this.#keyProvider = new ProtectorKeyProvider({
      electronPath: options.electronPath,
      logger: options.logger,
    })
    this.#lastStatus = { state: 'unknown' }
  }

  get keyProvider() {
    return this.#keyProvider
  }

  /** Read the freshest stored credential without refreshing. */
  async current() {
    const desktop = await readDesktopCredential(
      this.#options.authCandidates ?? desktopAuthCandidates(),
      this.#keyProvider,
      this.#options.logger,
    )
    const own = await this.#readOwn()
    if (desktop === undefined) return own
    if (own === undefined) return desktop
    if (desktop.uid !== own.uid || desktop.enterpriseId !== own.enterpriseId) return desktop
    return own.expiresAtMs > desktop.expiresAtMs ? own : desktop
  }

  /** The credential to send upstream, refreshed when inside the margin. */
  async resolve() {
    const credential = await this.current()
    if (credential === undefined) {
      const candidates = this.#options.authCandidates ?? desktopAuthCandidates()
      throw new Error(
        'no signed-in WorkBuddy account found; sign in once in the WorkBuddy desktop app'
        + ` (expected ${candidates.join(' or ') || 'a WorkBuddy auth file'})`,
      )
    }
    if (!this.#needsRefresh(credential)) return credential
    this.#inflight ??= this.#refreshNow(credential)
      .finally(() => { this.#inflight = undefined })
    return this.#inflight
  }

  /** Read-only sign-in summary; never refreshes and never throws. */
  async status() {
    try {
      const credential = await this.current()
      if (credential === undefined) {
        this.#lastStatus = { state: 'signed-out', reason: 'no credential file found' }
        return this.#lastStatus
      }
      this.#lastStatus = {
        state: 'signed-in',
        uid: credential.uid,
        domain: credential.domain,
        nickname: credential.nickname,
        expiresAtMs: credential.expiresAtMs,
        source: credential.source,
      }
      return this.#lastStatus
    } catch (error) {
      this.#lastStatus = { state: 'signed-out', reason: error instanceof Error ? error.message : String(error) }
      return this.#lastStatus
    }
  }

  #needsRefresh(credential) {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + (this.#options.refreshMarginMs ?? 5 * 60 * 1000) >= credential.expiresAtMs
  }

  async #refreshNow(credential) {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error('WorkBuddy access token expired and no refresh token is stored; sign in again in the app')
    }
    try {
      const outcome = await this.#options.refresh(credential)
      const refreshed = {
        ...credential,
        accessToken: outcome.accessToken,
        ...(outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken }),
        expiresAtMs: outcome.expiresInSec !== undefined
          ? Date.now() + outcome.expiresInSec * 1000
          : credential.expiresAtMs,
        ...(outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain }),
        source: 'dsh',
      }
      await this.#saveOwn(refreshed)
      return refreshed
    } catch (error) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(
        `WorkBuddy token refresh failed and the access token is expired (${String(error)});`
        + ' open the WorkBuddy desktop app once to sign in again',
      )
    }
  }

  async #saveOwn(credential) {
    const path = this.#ownPath
    await mkdir(join(path, '..'), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify({ version: 1, credential }, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, path)
  }

  async #readOwn() {
    try {
      return parseOwnDocument(await readFile(this.#ownPath, 'utf8'))
    } catch {
      return undefined
    }
  }
}
