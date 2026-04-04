import { createContext, useCallback, useMemo, useState, type ReactNode } from 'react'
import { useAgent, UseAgentUpdate, useAgentContext, useCopilotKit } from '@copilotkit/react-core/v2'
import { PROVIDER_AGENT_ID, PROVIDER_COMPARE_LIMIT } from './constants'
import {
  buildProviderCompareRows,
  createProviderThreadSnapshot,
  findProviderByNpi,
} from './normalizers'
import type { ProviderCompareRow, ProviderResearchJob, ProviderSearchResult, ProviderThreadSnapshot } from './types'

interface ProviderThreadStateValue {
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

async function runAgentPrompt(
  prompt: string,
  agent: ReturnType<typeof useAgent>['agent'],
  runAgent: ReturnType<typeof useCopilotKit>['copilotkit']['runAgent'],
) {
  agent.addMessage({
    id: crypto.randomUUID(),
    role: 'user',
    content: prompt,
  })
  await runAgent({ agent })
}

export function ProviderThreadStateProvider({
  threadId,
  children,
}: {
  threadId: string
  children: ReactNode
}) {
  const { agent } = useAgent({
    agentId: PROVIDER_AGENT_ID,
    updates: [
      UseAgentUpdate.OnMessagesChanged,
      UseAgentUpdate.OnRunStatusChanged,
      UseAgentUpdate.OnStateChanged,
    ],
  })
  const { copilotkit } = useCopilotKit()
  const [selectedProviderNpi, setSelectedProviderNpi] = useState<string | null>(null)
  const [comparedProviderNpis, setComparedProviderNpis] = useState<string[]>([])
  const [isProfileOpen, setIsProfileOpen] = useState(false)
  const [isCompareOpen, setIsCompareOpen] = useState(false)
  const [isResearchOpen, setIsResearchOpen] = useState(false)

  const snapshot = useMemo(() => createProviderThreadSnapshot(agent.messages), [agent.messages])

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

  useAgentContext({
    description: 'Provider discovery interface state',
    value: {
      activeThreadId: threadId,
      selectedProviderNpi,
      comparedProviderNpis,
      profileOpen: isProfileOpen,
      compareOpen: isCompareOpen,
      researchOpen: isResearchOpen,
    },
  })

  const openProfile = useCallback(async (provider: ProviderSearchResult) => {
    setSelectedProviderNpi(provider.npi)
    setIsProfileOpen(true)
    if (provider.generalSources.length > 0 || agent.isRunning) return
    await runAgentPrompt(buildProfilePrompt(provider), agent, copilotkit.runAgent.bind(copilotkit))
  }, [agent, copilotkit])

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

    if (agent.isRunning) return

    if (!existingJob || ['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(existingJob.status)) {
      await runAgentPrompt(buildDeepResearchStartPrompt(provider), agent, copilotkit.runAgent.bind(copilotkit))
      return
    }

    if (existingJob.status !== 'COMPLETED') {
      await runAgentPrompt(buildDeepResearchFetchPrompt(existingJob), agent, copilotkit.runAgent.bind(copilotkit))
    }
  }, [agent, copilotkit, snapshot.researchJobs])

  const refreshResearch = useCallback(async (provider: ProviderSearchResult, job: ProviderResearchJob | null) => {
    setSelectedProviderNpi(provider.npi)
    setIsResearchOpen(true)
    if (agent.isRunning) return
    if (job?.requestId) {
      await runAgentPrompt(buildDeepResearchFetchPrompt(job), agent, copilotkit.runAgent.bind(copilotkit))
      return
    }
    await runAgentPrompt(buildDeepResearchStartPrompt(provider), agent, copilotkit.runAgent.bind(copilotkit))
  }, [agent, copilotkit])

  const closeResearch = useCallback(() => {
    setIsResearchOpen(false)
  }, [])

  const value = useMemo<ProviderThreadStateValue>(() => ({
    snapshot,
    isRunning: agent.isRunning,
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
    agent.isRunning,
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
