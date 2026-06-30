import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  EnvironmentVariables,
  EnvironmentVariable,
  EnvironmentVariableCopyButton,
  EnvironmentVariablesContent,
  EnvironmentVariablesHeader,
  EnvironmentVariablesTitle,
  EnvironmentVariablesToggle,
} from '@/components/ai-elements/environment-variables'
import { cn } from '@/utils/cn'
import { authedFetch } from '@/lib/api'
import { TrashIcon } from '@heroicons/react/24/outline'

const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/

const PROTECTED_VARS = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'PYTHONPATH',
  'STRANDS_HOME',
  'BYPASS_TOOL_CONSENT',
])

interface EnvironmentVariableRecord {
  name: string
  value: string
  protected: boolean
}

export function EnvironmentVariablesSection() {
  const [variables, setVariables] = useState<EnvironmentVariableRecord[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const loadVariables = useCallback(async () => {
    setIsLoading(true)
    try {
      const response = await authedFetch('/api/settings/environment')
      if (!response.ok) throw new Error('Failed to load environment variables')
      const data = (await response.json()) as {
        variables: EnvironmentVariableRecord[]
      }
      setVariables(data.variables ?? [])
    } catch {
      setError('Unable to load environment variables')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadVariables()
  }, [loadVariables])

  const nameError = useMemo(() => {
    if (!name) return null
    const trimmed = name.trim()
    if (PROTECTED_VARS.has(trimmed)) return `${trimmed} is a protected variable`
    if (!ENV_VAR_NAME_RE.test(trimmed)) {
      return 'Name must be uppercase letters, digits, and underscores, starting with a letter or underscore'
    }
    return null
  }, [name])

  const handleSave = async () => {
    const trimmedName = name.trim()
    if (!trimmedName || value === '') return
    if (nameError) {
      setError(nameError)
      return
    }
    setIsSaving(true)
    setError(null)
    try {
      const response = await authedFetch('/api/settings/environment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, value }),
      })
      if (!response.ok) {
        const data = (await response.json()) as { detail?: string }
        throw new Error(data.detail ?? 'Failed to save variable')
      }
      setName('')
      setValue('')
      await loadVariables()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save variable')
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async (variableName: string) => {
    if (!confirm(`Delete environment variable ${variableName}?`)) return
    try {
      const response = await authedFetch(`/api/settings/environment/${encodeURIComponent(variableName)}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        const data = (await response.json()) as { detail?: string }
        throw new Error(data.detail ?? 'Failed to delete variable')
      }
      await loadVariables()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete variable')
    }
  }

  return (
    <div className="space-y-6">
      <EnvironmentVariables className="border-white/[0.08] bg-surface-900/60 text-white">
        <EnvironmentVariablesHeader className="border-white/[0.08] px-4 py-3">
          <EnvironmentVariablesTitle className="text-white">Persisted Variables</EnvironmentVariablesTitle>
          <EnvironmentVariablesToggle />
        </EnvironmentVariablesHeader>
        <EnvironmentVariablesContent className="divide-white/[0.06]">
          {isLoading ? (
            <div className="px-4 py-6 text-sm text-white/50">Loading…</div>
          ) : variables.length === 0 ? (
            <div className="px-4 py-6 text-sm text-white/50">No environment variables saved yet.</div>
          ) : (
            variables.map((variable) => (
              <EnvironmentVariable
                key={variable.name}
                name={variable.name}
                value={variable.value}
                className="px-4 py-3 hover:bg-white/[0.03]"
              >
                <div className="flex flex-1 items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm text-white">{variable.name}</span>
                    {variable.protected ? (
                      <span className="rounded-full border border-amber-300/20 bg-amber-400/10 px-2 py-0.5 text-[10px] text-amber-200">
                        Protected
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <EnvironmentVariableCopyButton
                      className="text-white/50 hover:bg-white/[0.08] hover:text-white"
                      copyFormat="value"
                    />
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => handleDelete(variable.name)}
                      disabled={variable.protected}
                      className="text-white/50 hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-30"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </EnvironmentVariable>
            ))
          )}
        </EnvironmentVariablesContent>
      </EnvironmentVariables>

      <div className="rounded-2xl border border-white/[0.08] bg-surface-900/60 p-5">
        <h4 className="text-sm font-medium text-white">Add / Update Variable</h4>
        <div className="mt-4 grid gap-4 sm:grid-cols-[1fr,1fr,auto]">
          <div className="space-y-2">
            <label htmlFor="env-name" className="text-xs text-white/60">Name</label>
            <Input
              id="env-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="XAI_API_KEY"
              className={cn(
                'h-10 border-white/[0.08] bg-white/[0.04] text-white placeholder:text-white/25',
                nameError && 'border-rose-300/30 focus-visible:ring-rose-500/20',
              )}
            />
            {nameError ? <p className="text-xs text-rose-300">{nameError}</p> : null}
          </div>
          <div className="space-y-2">
            <label htmlFor="env-value" className="text-xs text-white/60">Value</label>
            <Input
              id="env-value"
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="••••••••"
              className="h-10 border-white/[0.08] bg-white/[0.04] text-white placeholder:text-white/25"
            />
          </div>
          <div className="flex items-end">
            <Button
              onClick={handleSave}
              disabled={!name.trim() || value === '' || Boolean(nameError) || isSaving}
              className="h-10 bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40"
            >
              {isSaving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
        {error ? <p className="mt-3 text-sm text-rose-300">{error}</p> : null}
      </div>
    </div>
  )
}
