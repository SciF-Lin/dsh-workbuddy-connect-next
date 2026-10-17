/**
 * DSH WorkBuddy Connect (Next) — browser half.
 *
 * Two seats:
 * - `conversation.input.right`: a compact balance chip beside the composer
 *   submit control, shown only while a WorkBuddy account is signed in.
 * - `plugins.bundle.config` (key = this package): the bundle's page card with
 *   account, balance, model list source, per-model visibility toggles, and the
 *   consensual reasoning-effort probe.
 *
 * All data comes from the Host half's same-origin API; nothing here holds a
 * credential.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-connect-next',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef, Fragment } = React

    const API_STATUS = '/workbuddy-connect-next/status'
    const API_ACTION = '/workbuddy-connect-next/action'
    const PACKAGE = 'dsh-workbuddy-connect-next'

    const isZh = () => {
      const lang = (typeof navigator === 'object' && navigator.language ? navigator.language : 'en').toLowerCase()
      return lang.startsWith('zh')
    }

    const TEXT = {
      zh: {
        account: '账号',
        expires: '令牌有效期',
        credits: '剩余积分',
        creditsRefresh: '刷新积分',
        creditsError: '积分查询失败',
        creditsIdle: '尚未查询（点击刷新）',
        unlimited: '不限量',
        packages: '套餐明细',
        models: '模型',
        modelsRefresh: '刷新模型列表',
        catalogFrom: '目录来源',
        catalogLive: '上游实时',
        catalogCache: '本地缓存',
        catalogFallback: '内置兜底',
        catalogCount: '模型数',
        signedOut: '未检测到已登录的 WorkBuddy 账号。请在 WorkBuddy 桌面 App 中登录。',
        signedOutReason: '原因',
        visible: '在模型选择器中显示',
        hidden: '已隐藏',
        declaredEfforts: '已声明档位',
        noReasoning: '该模型不支持推理档位',
        probeButton: '检测档位',
        probeIntro: '部分模型具备思考能力，但没有声明可选档位。检测会发送少量真实请求，可能消耗积分。',
        probeConfirm: model => `向 ${model} 发送探测请求，以确认可用推理档位。可能消耗少量积分。`,
        probeConfirmButton: '确认检测',
        probeCancel: '取消',
        probeRunning: '检测中…',
        probeNonValidating: '该模型不校验该参数',
        probeUnknown: '检测未完成',
        probeNoLevels: '本次测试的档位均未被接受。',
        probing: '正在检测',
        notProbed: '尚未检测',
        agree: '知道了',
        generalError: '操作失败',
        context: '上下文',
        maxOutput: '最大输出',
        image: '图片',
        tokenValid: '有效',
        retry: '重试',
        loading: '加载中…',
      },
      en: {
        account: 'Account',
        expires: 'Token expires',
        credits: 'Remaining credits',
        creditsRefresh: 'Refresh credits',
        creditsError: 'Credit query failed',
        creditsIdle: 'Not queried yet (click refresh)',
        unlimited: 'Unlimited',
        packages: 'Packages',
        models: 'Models',
        modelsRefresh: 'Refresh model list',
        catalogFrom: 'Catalog source',
        catalogLive: 'upstream',
        catalogCache: 'saved',
        catalogFallback: 'built-in',
        catalogCount: 'Models',
        signedOut: 'No signed-in WorkBuddy account found. Sign in in the WorkBuddy desktop app.',
        signedOutReason: 'Reason',
        visible: 'Show in the model picker',
        hidden: 'Hidden',
        declaredEfforts: 'Declared efforts',
        noReasoning: 'This model has no reasoning effort',
        probeButton: 'Detect efforts',
        probeIntro: 'Some models think but declare no selectable effort levels. Detection sends a few real requests and may consume credits.',
        probeConfirm: model => `Send probe requests to ${model} to determine which reasoning efforts it accepts. This may consume a little credit.`,
        probeConfirmButton: 'Detect',
        probeCancel: 'Cancel',
        probeRunning: 'Detecting…',
        probeNonValidating: 'This model does not validate the parameter',
        probeUnknown: 'Detection did not complete',
        probeNoLevels: 'None of the tested levels was accepted.',
        probing: 'Detecting',
        notProbed: 'Not detected',
        agree: 'Got it',
        generalError: 'Action failed',
        context: 'Context',
        maxOutput: 'Max output',
        image: 'Images',
        tokenValid: 'valid',
        retry: 'Retry',
        loading: 'Loading…',
      },
    }

    const L = () => TEXT[isZh() ? 'zh' : 'en']

    /** Same-origin Host API call; the header is the Host's anti-CSRF gate. */
    async function call(path, init) {
      const response = await fetch(path, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...init,
        headers: {
          'x-workbuddy-connect': '1',
          ...(init && init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(init && init.headers ? init.headers : {}),
        },
      })
      let document
      try {
        document = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok || document.ok === false) {
        throw new Error((document && document.error) || `HTTP ${response.status}`)
      }
      return document
    }

    const getStatus = () => call(API_STATUS)
    const act = body => call(API_ACTION, { method: 'POST', body: JSON.stringify(body) })

    function formatNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return value.toLocaleString()
    }

    function formatTime(ms) {
      if (typeof ms !== 'number' || ms <= 0) return '—'
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return '—'
      }
    }

    function formatAge(ms) {
      if (typeof ms !== 'number' || ms <= 0) return '—'
      const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
      if (seconds < 60) return isZh() ? `${seconds} 秒前` : `${seconds}s ago`
      if (seconds < 3600) return isZh() ? `${Math.round(seconds / 60)} 分钟前` : `${Math.round(seconds / 60)}m ago`
      return isZh() ? `${Math.round(seconds / 3600)} 小时前` : `${Math.round(seconds / 3600)}h ago`
    }

    const CSS = `
      .wbc-chip{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 8px;border-radius:13px;
        border:1px solid var(--dsw-alias-border-l1,#d9d9e0);background:var(--dsw-alias-bg-layer-1,transparent);
        color:var(--dsw-alias-label-secondary,#6b6b76);font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;
        font-variant-numeric:tabular-nums}
      .wbc-chip:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#1f1f24)}
      .wbc-chip[disabled]{cursor:default;opacity:.7}
      .wbc-card{border:1px solid var(--dsw-alias-border-l1,#e3e3ea);border-radius:12px;padding:14px 16px;margin:12px 0;
        background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#1f1f24);font-size:13px;
        display:flex;flex-direction:column;gap:12px}
      .wbc-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
      .wbc-title{font-size:15px;font-weight:600}
      .wbc-sub{color:var(--dsw-alias-label-secondary,#6b6b76);font-size:12px}
      .wbc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .wbc-label{color:var(--dsw-alias-label-secondary,#6b6b76);min-width:84px;font-size:12px}
      .wbc-value{font-variant-numeric:tabular-nums}
      .wbc-section{border-top:1px solid var(--dsw-alias-border-l1,#ececf2);padding-top:10px;display:flex;flex-direction:column;gap:8px}
      .wbc-section-title{font-weight:600;font-size:13px;display:flex;align-items:center;gap:8px;justify-content:space-between}
      .wbc-btn{border:1px solid var(--dsw-alias-border-l1,#d9d9e0);background:transparent;color:inherit;border-radius:8px;
        padding:4px 10px;font-size:12px;cursor:pointer;line-height:1.4}
      .wbc-btn:hover:not([disabled]){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}
      .wbc-btn[disabled]{opacity:.55;cursor:default}
      .wbc-btn.primary{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe)}
      .wbc-btn.danger{color:var(--dsw-alias-state-error-primary,#d33)}
      .wbc-models{display:flex;flex-direction:column;gap:2px;max-height:340px;overflow:auto;border-radius:8px}
      .wbc-model{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:8px;flex-wrap:wrap}
      .wbc-model:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08))}
      .wbc-model-name{font-weight:500;min-width:150px}
      .wbc-meta{color:var(--dsw-alias-label-secondary,#6b6b76);font-size:11px;font-variant-numeric:tabular-nums}
      .wbc-badges{display:inline-flex;gap:4px;flex-wrap:wrap}
      .wbc-badge{border:1px solid var(--dsw-alias-border-l1,#e0e0e8);border-radius:999px;padding:1px 7px;font-size:11px;
        color:var(--dsw-alias-label-secondary,#6b6b76)}
      .wbc-badge.ok{color:var(--dsw-alias-state-success-primary,#16803c);border-color:currentColor}
      .wbc-badge.warn{color:var(--dsw-alias-state-warn-primary,#b26a00);border-color:currentColor}
      .wbc-badge.err{color:var(--dsw-alias-state-error-primary,#d33);border-color:currentColor}
      .wbc-toggle{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#6b6b76)}
      .wbc-probe{border:1px solid var(--dsw-alias-border-l1,#e0e0e8);border-radius:10px;padding:10px 12px;
        background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05));display:flex;flex-direction:column;gap:8px;
        max-width:520px;font-size:12px}
      .wbc-note{color:var(--dsw-alias-label-secondary,#6b6b76);font-size:12px;line-height:1.5}
      .wbc-error{color:var(--dsw-alias-state-error-primary,#d33);font-size:12px;white-space:pre-wrap}
      .wbc-key{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
      .wbc-empty{color:var(--dsw-alias-label-secondary,#6b6b76);font-size:12px}
    `

    /** Scoped stylesheet; React removes it on unmount. */
    function Styles() {
      return h('style', { 'data-wbc': 'styles' }, CSS)
    }

    function Badge({ children, tone }) {
      return h('span', { className: `wbc-badge${tone ? ` ${tone}` : ''}` }, children)
    }

    function useStatus(loadOnMount, autoCredit) {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const askedCredit = useRef(false)
      const reload = useCallback(async () => {
        try {
          const next = await getStatus()
          setStatus(next)
          setError(null)
          return next
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
          return null
        }
      }, [])
      useEffect(() => {
        if (loadOnMount) void reload()
      }, [loadOnMount, reload])
      useEffect(() => {
        if (!autoCredit || status === null || askedCredit.current) return
        if (status.account?.state !== 'signed-in') return
        if (status.credit && status.credit.state !== 'idle') return
        askedCredit.current = true
        act({ action: 'refresh-balance' }).then(result => {
          if (result && result.snapshot) setStatus(result.snapshot)
        }).catch(() => {})
      }, [autoCredit, status])
      return { status, setStatus, error, setError, reload }
    }

    /** Compact credit chip in the composer control row. */
    function BalanceChip() {
      const t = L()
      const { status, setStatus, error } = useStatus(true, true)
      const [busy, setBusy] = useState(false)
      const refresh = useCallback(async () => {
        if (busy) return
        setBusy(true)
        try {
          const result = await act({ action: 'refresh-balance' })
          if (result.snapshot) setStatus(result.snapshot)
        } catch {
          // the chip stays on the last value; the card reports the reason
        } finally {
          setBusy(false)
        }
      }, [busy, setStatus])
      if (error !== null || status === null) return null
      if (status.account?.state !== 'signed-in') return null
      const credit = status.credit
      let label
      let title
      if (credit && credit.state === 'ready') {
        label = `WB ${credit.unlimited === true ? '∞' : formatNumber(credit.total)}`
        title = credit.unlimited === true ? 'WorkBuddy credits: unlimited' : `${t.credits}: ${formatNumber(credit.total)}`
      } else if (credit && credit.state === 'error') {
        label = 'WB !'
        title = `${t.creditsError}: ${credit.error}`
      } else {
        label = 'WB …'
        title = t.creditsIdle
      }
      return h(Fragment, null,
        h(Styles),
        h('button', {
          type: 'button',
          className: 'wbc-chip',
          onClick: refresh,
          disabled: busy,
          title: busy ? t.loading : `${title} — ${t.creditsRefresh}`,
          'aria-label': `${title}. ${t.creditsRefresh}`,
        }, busy ? 'WB …' : label),
      )
    }

    /** One model row: visibility toggle plus declared/probed effort state. */
    function ModelRow({ model, t, busy, onToggle, onProbe }) {
      const [open, setOpen] = useState(false)
      const declared = Array.isArray(model.declaredEfforts) ? model.declaredEfforts : []
      const probe = model.probe
      const canProbe = model.supportsReasoning && declared.length === 0
      let probeNode = null
      if (declared.length > 0) {
        probeNode = h('span', { className: 'wbc-badges' }, declared.map(effort => h(Badge, { key: effort }, effort)))
      } else if (!model.supportsReasoning) {
        probeNode = h('span', { className: 'wbc-meta' }, t.noReasoning)
      } else if (probe && probe.validation === 'validating') {
        probeNode = h(Fragment, null,
          h('span', { className: 'wbc-badges' },
            (probe.efforts || []).map(effort => h(Badge, { key: effort, tone: 'ok' }, effort))),
          h('span', { className: 'wbc-meta' }, `· ${formatAge(probe.atMs)} · ${probe.requests} req`),
        )
      } else if (probe && probe.validation === 'non-validating') {
        probeNode = h(Fragment, null,
          h(Badge, { tone: 'warn' }, t.probeNonValidating),
          probe.atMs ? h('span', { className: 'wbc-meta' }, `· ${formatAge(probe.atMs)}`) : null,
        )
      } else if (probe && probe.validation === 'unknown') {
        probeNode = h(Fragment, null,
          h(Badge, { tone: 'err' }, `${t.probeUnknown}${probe.reason ? `: ${probe.reason}` : ''}`),
        )
      } else if (canProbe) {
        probeNode = h('button', {
          type: 'button',
          className: 'wbc-btn',
          disabled: busy.probe,
          onClick: () => setOpen(true),
        }, busy.probe ? t.probeRunning : t.probeButton)
      }
      return h(Fragment, null,
        h('div', { className: 'wbc-model' },
          h('label', { className: 'wbc-toggle', title: t.visible },
            h('input', {
              type: 'checkbox',
              checked: model.visible !== false,
              disabled: busy.visibility,
              onChange: event => onToggle(model, event.target.checked),
            }),
          ),
          h('span', { className: 'wbc-model-name' }, model.name),
          h('span', { className: 'wbc-meta' }, `${model.id} · ${formatNumber(model.contextWindow)} ctx`),
          (model.billing && model.billing.free) ? h(Badge, { tone: 'ok' }, isZh() ? '免费' : 'free') : null,
          (model.billing && Array.isArray(model.billing.badges) ? model.billing.badges : []).map(label => h(Badge, { key: label }, label)),
          model.supportsImages ? h(Badge, null, t.image) : null,
          probeNode,
        ),
        open ? h('div', { className: 'wbc-model' },
          h('div', { className: 'wbc-probe' },
            h('div', null, t.probeConfirm(model.name)),
            h('div', { className: 'wbc-note' }, t.probeIntro),
            h('div', { className: 'wbc-row' },
              h('button', {
                type: 'button', className: 'wbc-btn primary', disabled: busy.probe,
                onClick: () => { setOpen(false); onProbe(model) },
              }, busy.probe ? t.probeRunning : t.probeConfirmButton),
              h('button', { type: 'button', className: 'wbc-btn', onClick: () => setOpen(false) }, t.probeCancel),
            ),
          ),
        ) : null,
      )
    }

    /** The bundle's page card in the Plugins panel. */
    function BundleConfigCard(props) {
      const t = L()
      const view = props && props.view ? props.view : 'page'
      const { status, setStatus, error, setError, reload } = useStatus(true, false)
      const [busy, setBusy] = useState({ credit: false, models: false, visibility: false, probe: false })
      const [notice, setNotice] = useState(null)
      const setFlag = (name, value) => setBusy(current => ({ ...current, [name]: value }))

      const run = useCallback(async (action, flag, body) => {
        setFlag(flag, true)
        setNotice(null)
        try {
          const result = await act({ action, ...body })
          if (result.snapshot) setStatus(result.snapshot)
          if (action === 'probe' && result.result) {
            const outcome = result.result
            if (outcome.state === 'ok') {
              if (outcome.validation === 'validating' && outcome.efforts.length === 0) setNotice({ tone: 'warn', text: t.probeNoLevels })
              else if (outcome.validation === 'non-validating') setNotice({ tone: 'warn', text: t.probeNonValidating })
              else if (outcome.validation === 'unknown') setNotice({ tone: 'err', text: `${t.probeUnknown}${outcome.reason ? `: ${outcome.reason}` : ''}` })
            } else if (outcome.state !== 'ok') {
              setNotice({ tone: 'warn', text: outcome.message || outcome.reason || t.probeUnknown })
            }
          }
          setError(null)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setFlag(flag, false)
        }
      }, [setError, setStatus, t])

      if (view === 'summary') {
        if (status === null) return h('span', { className: 'wbc-sub' }, error ? `${t.generalError}: ${error}` : t.loading)
        const credit = status.credit
        const text = status.account?.state === 'signed-in'
          ? `${t.credits}: ${credit && credit.state === 'ready' ? (credit.unlimited === true ? t.unlimited : formatNumber(credit.total)) : '—'}`
          : t.signedOut
        return h(Fragment, null, h(Styles), h('span', { className: 'wbc-sub' }, text))
      }

      if (status === null) {
        return h(Fragment, null, h(Styles),
          h('div', { className: 'wbc-card' },
            error === null
              ? h('div', { className: 'wbc-empty' }, t.loading)
              : h(Fragment, null,
                h('div', { className: 'wbc-error' }, `${t.generalError}: ${error}`),
                h('div', null, h('button', { type: 'button', className: 'wbc-btn', onClick: () => { void reload() } }, t.retry)),
              ),
          ),
        )
      }

      const signedIn = status.account?.state === 'signed-in'
      const credit = status.credit || { state: 'idle' }
      const catalog = status.catalog || {}
      const models = Array.isArray(status.models) ? status.models : []
      const sourceLabel = catalog.source === 'upstream' ? t.catalogLive
        : catalog.source === 'cache' ? t.catalogCache : t.catalogFallback

      const onToggle = (model, visible) => run('set-visibility', 'visibility', { modelId: model.id, visible })
      const onProbe = model => run('probe', 'probe', { modelId: model.id })

      const creditValue = credit.state === 'ready'
        ? (credit.unlimited === true ? t.unlimited : `${formatNumber(credit.total)}`)
        : credit.state === 'error' ? '—' : '—'

      return h(Fragment, null,
        h(Styles),
        h('div', { className: 'wbc-card' },
          h('div', { className: 'wbc-head' },
            h('span', { className: 'wbc-title' }, 'WorkBuddy'),
            h('span', { className: 'wbc-sub' }, status.plugin?.providerId || 'workbuddy'),
            signedIn ? null : h(Badge, { tone: 'warn' }, t.signedOut),
          ),

          !signedIn ? h('div', { className: 'wbc-note' },
            t.signedOut,
            status.account?.reason ? h('div', null, `${t.signedOutReason}: ${status.account.reason}`) : null,
            h('div', null, h('button', { type: 'button', className: 'wbc-btn', onClick: () => { void reload() } }, t.retry)),
          ) : h(Fragment, null,
            h('div', { className: 'wbc-row' },
              h('span', { className: 'wbc-label' }, t.account),
              h('span', { className: 'wbc-value' }, status.account.nickname || status.account.uid || '—'),
              status.account.enterprise ? h(Badge, null, 'enterprise') : null,
              h('span', { className: 'wbc-meta' }, status.account.domain || ''),
            ),
            h('div', { className: 'wbc-row' },
              h('span', { className: 'wbc-label' }, t.expires),
              h('span', { className: 'wbc-value' }, formatTime(status.account.expiresAtMs)),
              h('span', { className: 'wbc-meta' }, t.tokenValid),
            ),
          ),

          signedIn ? h('div', { className: 'wbc-section' },
            h('div', { className: 'wbc-section-title' },
              h('span', null, `${t.credits}: ${creditValue}`),
              h('button', {
                type: 'button', className: 'wbc-btn',
                disabled: busy.credit,
                onClick: () => run('refresh-balance', 'credit'),
              }, busy.credit ? t.loading : t.creditsRefresh),
            ),
            credit.state === 'error' ? h('div', { className: 'wbc-error' }, `${t.creditsError}: ${credit.error}`) : null,
            credit.state !== 'ready' && credit.state !== 'error'
              ? h('div', { className: 'wbc-note' }, t.creditsIdle)
              : null,
            credit.state === 'ready' && Array.isArray(credit.accounts) && credit.accounts.length > 0
              ? h('div', { className: 'wbc-badges' }, credit.accounts.map((account, index) => h(Badge, {
                key: `${account.packageName}-${index}`,
                tone: account.remain > 0 ? undefined : 'warn',
              }, `${account.packageName}: ${formatNumber(account.remain)}${account.size ? ` / ${formatNumber(account.size)}` : ''}${account.endTimeMs ? ` · ${formatTime(account.endTimeMs)}` : ''}`)))
              : null,
            credit.state === 'ready' && credit.hiddenPackages > 0
              ? h('div', { className: 'wbc-meta' }, isZh() ? `另有 ${credit.hiddenPackages} 个套餐未展开` : `+${credit.hiddenPackages} more packages`)
              : null,
            credit.state === 'ready' && credit.fetchedAtMs ? h('div', { className: 'wbc-meta' }, formatAge(credit.fetchedAtMs)) : null,
          ) : null,

          h('div', { className: 'wbc-section' },
            h('div', { className: 'wbc-section-title' },
              h('span', null, `${t.models} (${models.length})`),
              h('button', {
                type: 'button', className: 'wbc-btn',
                disabled: busy.models,
                onClick: () => run('refresh-models', 'models'),
              }, busy.models ? t.loading : t.modelsRefresh),
            ),
            h('div', { className: 'wbc-row' },
              h('span', { className: 'wbc-meta' }, `${t.catalogFrom}: ${sourceLabel}`),
              catalog.fetchedAtMs ? h('span', { className: 'wbc-meta' }, `· ${formatAge(catalog.fetchedAtMs)}`) : null,
              catalog.error ? h('span', { className: 'wbc-error' }, `· ${catalog.error}`) : null,
            ),
            models.length === 0
              ? h('div', { className: 'wbc-empty' }, t.loading)
              : h('div', { className: 'wbc-models' }, models.map(model => h(ModelRow, {
                key: model.id,
                model,
                t,
                busy,
                onToggle,
                onProbe,
              }))),
          ),

          notice !== null ? h('div', { className: `wbc-${notice.tone === 'err' ? 'error' : 'note'}` }, notice.text) : null,
          error !== null ? h('div', { className: 'wbc-error' }, `${t.generalError}: ${error}`) : null,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'workbuddy-balance',
          order: 6,
          label: 'WorkBuddy balance',
        }, BalanceChip))
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: PACKAGE,
        }, BundleConfigCard))
      },
    }
  },
})
