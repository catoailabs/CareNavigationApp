import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { authedFetch } from '@/lib/api'
import { requestGoogleAuthCode, getGoogleOAuthClientId } from '@/lib/googleIdentity'
import { cn } from '@/utils/cn'
import { CheckCircleIcon } from '@heroicons/react/24/solid'

interface ScopeCatalogEntry {
  key: string
  label: string
  description: string
  scope: string
}

interface GoogleStatus {
  connected: boolean
  scopes: string[]
  connected_at?: string
  updated_at?: string
}

export function GoogleConnectSection() {
  const [catalog, setCatalog] = useState<ScopeCatalogEntry[]>([])
  const [status, setStatus] = useState<GoogleStatus | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [isLoading, setIsLoading] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clientConfigured = Boolean(getGoogleOAuthClientId())

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const [scopesRes, statusRes] = await Promise.all([
        authedFetch('/api/google/scopes'),
        authedFetch('/api/google/status'),
      ])
      if (!scopesRes.ok) throw new Error('Failed to load scope catalog')
      if (!statusRes.ok) throw new Error('Failed to load connection status')
      const scopesData = (await scopesRes.json()) as { scopes: ScopeCatalogEntry[] }
      const statusData = (await statusRes.json()) as GoogleStatus
      setCatalog(scopesData.scopes ?? [])
      setStatus(statusData)
      // Pre-check currently granted scopes (by scope URL) when connected.
      if (statusData.connected && statusData.scopes?.length) {
        const granted = new Set(statusData.scopes)
        const preselected = new Set(
          (scopesData.scopes ?? [])
            .filter((entry) => granted.has(entry.scope))
            .map((entry) => entry.key),
        )
        setSelected(preselected)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load Google settings')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectedScopes = useMemo(
    () => catalog.filter((entry) => selected.has(entry.key)).map((entry) => entry.scope),
    [catalog, selected],
  )

  const handleConnect = async () => {
    if (selectedScopes.length === 0) {
      setError('Select at least one access type to connect.')
      return
    }
    setIsBusy(true)
    setError(null)
    try {
      const { code, scope } = await requestGoogleAuthCode(selectedScopes)
      const response = await authedFetch('/api/google/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          redirectUri: 'postmessage',
          scopes: scope ? scope.split(' ') : selectedScopes,
        }),
      })
      if (!response.ok) {
        const data = (await response.json()) as { detail?: string }
        throw new Error(data.detail ?? 'Failed to connect Google')
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect Google')
    } finally {
      setIsBusy(false)
    }
  }

  const handleDisconnect = async () => {
    if (!confirm('Disconnect Google? The agent will lose access to your Google data.')) return
    setIsBusy(true)
    setError(null)
    try {
      const response = await authedFetch('/api/google/connect', { method: 'DELETE' })
      if (!response.ok) {
        const data = (await response.json()) as { detail?: string }
        throw new Error(data.detail ?? 'Failed to disconnect Google')
      }
      setSelected(new Set())
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect Google')
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-white/[0.08] bg-surface-900/60 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 className="text-sm font-medium text-white">Connect Google</h4>
            <p className="mt-1 text-sm text-white/55">
              Grant the agent access to specific Google services on your behalf. You control exactly
              which scopes are shared.
            </p>
          </div>
          {status?.connected ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300/20 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-200">
              <CheckCircleIcon className="h-4 w-4" /> Connected
            </span>
          ) : (
            <span className="rounded-full border border-white/[0.12] bg-white/[0.04] px-3 py-1 text-xs text-white/55">
              Not connected
            </span>
          )}
        </div>

        {!clientConfigured ? (
          <div className="mt-4 rounded-xl border border-amber-300/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            <code>VITE_GOOGLE_OAUTH_CLIENT_ID</code> is not set. Configure your Google OAuth web
            client id to enable the connect flow.
          </div>
        ) : null}
      </div>

      <div className="rounded-2xl border border-white/[0.08] bg-surface-900/60 p-5">
        <h4 className="text-sm font-medium text-white">Access scopes</h4>
        <p className="mt-1 text-xs text-white/45">Choose what the agent may access.</p>
        <div className="mt-4 space-y-2">
          {isLoading ? (
            <div className="px-1 py-4 text-sm text-white/50">Loading…</div>
          ) : (
            catalog.map((entry) => {
              const checked = selected.has(entry.key)
              return (
                <label
                  key={entry.key}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors',
                    checked
                      ? 'border-indigo-400/30 bg-indigo-500/10'
                      : 'border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.04]',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(entry.key)}
                    className="mt-0.5 h-4 w-4 accent-indigo-500"
                  />
                  <div className="min-w-0">
                    <div className="text-sm text-white">{entry.label}</div>
                    <div className="text-xs text-white/50">{entry.description}</div>
                  </div>
                </label>
              )
            })
          )}
        </div>

        {error ? <p className="mt-4 text-sm text-rose-300">{error}</p> : null}

        <div className="mt-5 flex items-center gap-3">
          <Button
            onClick={handleConnect}
            disabled={isBusy || !clientConfigured || selectedScopes.length === 0}
            className="h-10 bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40"
          >
            {isBusy ? 'Working…' : status?.connected ? 'Update access' : 'Connect Google'}
          </Button>
          {status?.connected ? (
            <Button
              variant="ghost"
              onClick={handleDisconnect}
              disabled={isBusy}
              className="h-10 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
