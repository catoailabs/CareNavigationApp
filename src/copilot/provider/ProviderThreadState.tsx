import { createContext, useCallback, useMemo, useState, type ReactNode } from 'react'
import type { UIMessage } from 'ai'
import { PROVIDER_COMPARE_LIMIT } from './constants'
import {
  buildProviderCompareRows,
  createProviderThreadSnapshot,
  findProviderByNpi,
} from './normalizers'
import type { ProviderCompareRow, ProviderResearchJob, ProviderSearchResult, ProviderThreadSnapshot } from './types'

interface ProviderThreadStateValue {
  threadId: string
  snapshot: ProviderThreadSnapshot
  isRunning: boolean
  selectedProvider: ProviderSearchResult | null
  comparedProviders: ProviderSearchResult[]
  compareRows: ProviderCompareRow[]
  isProfileOpen: boolean
  isCompareOpen: boolean
  isResearchOpen: boolean
  selectedResearchJob: ProviderResearchJob | null
  openProfile: (provider: ProviderSearchResult) => Promise<void>
  closeProfile: () => void
  toggleCompare: (provider: ProviderSearchResult) => void
  openCompare: () => void
  closeCompare: () => void
  openResearch: (provider: ProviderSearchResult) => Promise<void>
  refreshResearch: (provider: ProviderSearchResult, job: ProviderResearchJob | null) => Promise<void>
  closeResearch: () => void
}

const ProviderThreadStateContext = createContext<ProviderThreadStateValue | null>(null)

function buildProfilePrompt(provider: ProviderSearchResult): string {
  const location = [provider.city, provider.state].filter(Boolean).join(', ')
  return [
    `Build a full provider profile for ${provider.displayName} (NPI ${provider.npi}).`,
    'Use perplexity_search_api with return_images=true and provider-specific web queries.',
    'Focus on authoritative provider pages, reviews, education, publications, awards, and location context.',
    provider.organizationName ? `Organization: ${provider.organizationName}.` : null,
    location ? `Location anchor: ${location}.` : null,
    'Do not invent facts. Use cited web results only.',
  ].filter(Boolean).join(' ')
}

function buildDeepResearchStartPrompt(provider: ProviderSearchResult): string {
  const focusAreas = [
    'practice history',
    'locations',
    'patient reviews',
    'education and training',
    'publications',
    'awards and recognition',
  ]

  return [
    `Start deep provider research for ${provider.displayName} (NPI ${provider.npi}).`,
    `Use perplexity_deep_research(action="start", topic="${provider.displayName} NPI ${provider.npi}", focus_areas=${JSON.stringify(focusAreas)}, include_guidelines=false, include_trials=false, depth="comprehensive").`,
    'Return after the tool call so the UI can track the job status.',
  ].join(' ')
}

function buildDeepResearchFetchPrompt(job: ProviderResearchJob): string {
  return [
    `Fetch the current status for provider deep research request ${job.requestId ?? ''}.`,
    `Use perplexity_deep_research(action="fetch", request_id="${job.requestId ?? ''}", topic="${job.topic}").`,
    'Return the latest report or in-progress status without summarizing away the tool output.',
  ].join(' ')
}

/**
 * Convert AI SDK v6 UIMessage[] to the AgentMessageLike[] shape that
 * createProviderThreadSnapshot expects.
 *
 * AI SDK v6 tool parts use 'dynamic-tool' type with state machine.
 * We convert these into the ToolCall / tool-message shape that normalizers.ts understands.
 */
function adaptMessagesForSnapshot(messages: UIMessage[]): Array<{
  id: string
  role: string
  content?: unknown
  toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>
  toolCallId?: string
}> {
  const adapted: Array<{
    id: string
    role: string
    content?: unknown
    toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>
    toolCallId?: string
  }> = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      const textParts = msg.parts.filter(p => p.type === 'text')
      const text = textParts.map(p => (p as { type: 'text'; text: string }).text).join('\n')
      adapted.push({ id: msg.id, role: 'user', content: text })
      continue
    }

    if (msg.role === 'assistant') {
      // Collect text content
      const textParts = msg.parts.filter(p => p.type === 'text')
      const text = textParts.map(p => (p as { type: 'text'; text: string }).text).join('\n')

      // Collect tool calls from dynamic-tool parts
      const toolParts = msg.parts.filter(p => p.type === 'dynamic-tool') as Array<{
        type: 'dynamic-tool'
        toolCallId: string
        toolName: string
        state: string
        input?: Record<string, unknown>
        output?: unknown
      }>

      const toolCalls = toolParts.map(tp => ({
        id: tp.toolCallId,
        function: {
          name: tp.toolName,
          arguments: JSON.stringify(tp.input ?? {}),
        },
      }))

      adapted.push({
        id: msg.id,
        role: 'assistant',
        content: text,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      })

      // Create tool result messages for tools with output-available state
      for (const tp of toolParts) {
        if (tp.state === 'output-available' && tp.output !== undefined) {
          adapted.push({
            id: `${msg.id}-tool-${tp.toolCallId}`,
            role: 'tool',
            toolCallId: tp.toolCallId,
            content: typeof tp.output === 'string' ? tp.output : JSON.stringify(tp.output),
          })
        }
      }
    }
  }

  return adapted
}

export function ProviderThreadStateProvider({
  threadId,
  messages,
  sendMessage,
  isRunning,
  children,
}: {
  threadId: string
  messages: UIMessage[]
  sendMessage: (text: string) => void
  isRunning: boolean
  children: ReactNode
}) {
  const [selectedProviderNpi, setSelectedProviderNpi] = useState<string | null>(null)
  const [comparedProviderNpis, setComparedProviderNpis] = useState<string[]>([])
  const [isProfileOpen, setIsProfileOpen] = useState(false)
  const [isCompareOpen, setIsCompareOpen] = useState(false)
  const [isResearchOpen, setIsResearchOpen] = useState(false)

  // Adapt AI SDK v6 messages to the shape normalizers.ts expects
  const adaptedMessages = useMemo(() => adaptMessagesForSnapshot(messages), [messages])
  const snapshot = useMemo(() => createProviderThreadSnapshot(adaptedMessages), [adaptedMessages])

  const selectedProvider = useMemo(
    () => findProviderByNpi(snapshot.searchRuns, selectedProviderNpi),
    [selectedProviderNpi, snapshot.searchRuns],
  )

  const comparedProviders = useMemo(() => (
    comparedProviderNpis
      .map((npi) => findProviderByNpi(snapshot.searchRuns, npi))
      .filter((provider): provider is ProviderSearchResult => provider !== null)
  ), [comparedProviderNpis, snapshot.searchRuns])

  const compareRows = useMemo(() => buildProviderCompareRows(comparedProviders), [comparedProviders])

  const selectedResearchJob = useMemo(() => {
    if (!selectedProvider) return null
    return snapshot.researchJobs.find((job) => {
      const topic = job.topic.toLowerCase()
      return topic.includes(selectedProvider.npi.toLowerCase()) || topic.includes(selectedProvider.displayName.toLowerCase())
    }) ?? null
  }, [selectedProvider, snapshot.researchJobs])

  const openProfile = useCallback(async (provider: ProviderSearchResult) => {
    setSelectedProviderNpi(provider.npi)
    setIsProfileOpen(true)
    if (provider.generalSources.length > 0 || isRunning) return
    sendMessage(buildProfilePrompt(provider))
  }, [isRunning, sendMessage])

  const closeProfile = useCallback(() => {
    setIsProfileOpen(false)
  }, [])

  const toggleCompare = useCallback((provider: ProviderSearchResult) => {
    setComparedProviderNpis((current) => {
      if (current.includes(provider.npi)) {
        const next = current.filter((npi) => npi !== provider.npi)
        if (next.length < 2) {
          setIsCompareOpen(false)
        }
        return next
      }

      if (current.length >= PROVIDER_COMPARE_LIMIT) return current
      return [...current, provider.npi]
    })
  }, [])

  const openCompare = useCallback(() => {
    if (comparedProviderNpis.length >= 2) {
      setIsCompareOpen(true)
    }
  }, [comparedProviderNpis.length])

  const closeCompare = useCallback(() => {
    setIsCompareOpen(false)
  }, [])

  const openResearch = useCallback(async (provider: ProviderSearchResult) => {
    setSelectedProviderNpi(provider.npi)
    setIsProfileOpen(false)
    setIsResearchOpen(true)
    const existingJob = snapshot.researchJobs.find((job) => {
      const topic = job.topic.toLowerCase()
      return topic.includes(provider.npi.toLowerCase()) || topic.includes(provider.displayName.toLowerCase())
    }) ?? null

    if (isRunning) return

    if (!existingJob || ['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(existingJob.status)) {
      sendMessage(buildDeepResearchStartPrompt(provider))
      return
    }

    if (existingJob.status !== 'COMPLETED') {
      sendMessage(buildDeepResearchFetchPrompt(existingJob))
    }
  }, [isRunning, sendMessage, snapshot.researchJobs])

  const refreshResearch = useCallback(async (provider: ProviderSearchResult, job: ProviderResearchJob | null) => {
    setSelectedProviderNpi(provider.npi)
    setIsResearchOpen(true)
    if (isRunning) return
    if (job?.requestId) {
      sendMessage(buildDeepResearchFetchPrompt(job))
      return
    }
    sendMessage(buildDeepResearchStartPrompt(provider))
  }, [isRunning, sendMessage])

  const closeResearch = useCallback(() => {
    setIsResearchOpen(false)
  }, [])

  const value = useMemo<ProviderThreadStateValue>(() => ({
    threadId,
    snapshot,
    isRunning,
    selectedProvider,
    comparedProviders,
    compareRows,
    isProfileOpen,
    isCompareOpen,
    isResearchOpen,
    selectedResearchJob,
    openProfile,
    closeProfile,
    toggleCompare,
    openCompare,
    closeCompare,
    openResearch,
    refreshResearch,
    closeResearch,
  }), [
    threadId,
    isRunning,
    closeCompare,
    closeProfile,
    closeResearch,
    compareRows,
    comparedProviders,
    isCompareOpen,
    isProfileOpen,
    isResearchOpen,
    openCompare,
    openProfile,
    openResearch,
    refreshResearch,
    selectedProvider,
    selectedResearchJob,
    snapshot,
    toggleCompare,
  ])

  return (
    <ProviderThreadStateContext.Provider value={value}>
      {children}
    </ProviderThreadStateContext.Provider>
  )
}

export { ProviderThreadStateContext }
