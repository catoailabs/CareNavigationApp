import { useEffect, useMemo } from 'react'
import type { Message } from '@ag-ui/core'
import { CopilotChat, UseAgentUpdate, useAgent } from '@copilotkit/react-core/v2'
import { ArrowTrendingUpIcon, BuildingOffice2Icon } from '@heroicons/react/24/outline'
import { ProviderThreadStateProvider } from '@/copilot/provider/ProviderThreadState'
import { PROVIDER_AGENT_ID } from '@/copilot/provider/constants'
import { ProviderChatMessageView, ProviderComposer, ProviderWelcomeScreen } from '@/components/provider/ProviderChat'
import {
  ProviderCompareSheet,
  ProviderCompareTray,
  ProviderProfileSheet,
  ProviderResearchDossierModal,
} from '@/components/provider/ProviderUi'
import { useBuildStore } from '@/stores/buildStore'

function messageToText(message: Message): string | null {
  if (typeof message.content === 'string') {
    const trimmed = message.content.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  if (Array.isArray(message.content)) {
    const merged = message.content
      .flatMap((item) => {
        if (item.type === 'text' && typeof item.text === 'string') {
          return [item.text]
        }
        return []
      })
      .join('\n')
      .trim()

    return merged.length > 0 ? merged : null
  }

  return null
}

function SessionPromptSync({ threadId }: { threadId: string }) {
  const recordSessionPrompt = useBuildStore((state) => state.recordSessionPrompt)
  const { agent } = useAgent({
    agentId: PROVIDER_AGENT_ID,
    updates: [UseAgentUpdate.OnMessagesChanged],
  })

  const firstUserPrompt = useMemo(() => {
    if (agent.threadId !== threadId) return null
    const firstUserMessage = agent.messages.find((message) => message.role === 'user')
    return firstUserMessage ? messageToText(firstUserMessage) : null
  }, [agent.messages, agent.threadId, threadId])

  useEffect(() => {
    if (!firstUserPrompt) return
    recordSessionPrompt(firstUserPrompt)
  }, [firstUserPrompt, recordSessionPrompt])

  return null
}

export function CenterPane() {
  const activeSessionId = useBuildStore((state) => state.activeSessionId)
  const sessions = useBuildStore((state) => state.sessions)
  const createSession = useBuildStore((state) => state.createSession)
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null

  if (!activeSessionId) {
    return (
      <div className="relative flex flex-1 items-center justify-center px-6">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.12),transparent_55%)]" />
        <div className="relative max-w-xl rounded-[32px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(10,10,18,0.88)_0%,rgba(5,5,10,0.92)_100%)] px-8 py-8 text-center shadow-[0_32px_120px_-48px_rgba(99,102,241,0.4)]">
          <div className="text-[11px] uppercase tracking-[0.26em] text-white/35">Provider research</div>
          <h2 className="mt-4 text-3xl font-light text-white">The existing workspace stays intact.</h2>
          <p className="mt-4 text-sm leading-relaxed text-white/58">
            Start a new chat to search, compare, and deep-research providers from the root workbench.
          </p>
          <button
            onClick={() => createSession(PROVIDER_AGENT_ID)}
            className="mt-6 inline-flex items-center justify-center rounded-full bg-[linear-gradient(135deg,#6366F1,#4C1D95)] px-5 py-3 text-sm font-medium text-white shadow-[0_18px_50px_-28px_rgba(99,102,241,0.8)]"
          >
            Start provider chat
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex flex-1 min-w-0 flex-col overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.14),transparent_58%)]" />
      <div className="relative flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between gap-4 border-b border-surface-800/90 bg-surface-900/55 px-6 py-4 backdrop-blur-xl">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.24em] text-white/35">Provider intelligence</div>
            <h2 className="mt-2 truncate text-xl font-light text-white">
              {activeSession?.title ?? 'New chat'}
            </h2>
          </div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-white/42">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5">
              <BuildingOffice2Icon className="h-4 w-4 text-indigo-200" />
              NPPES + cited enrichment
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-indigo-300/20 bg-indigo-400/10 px-3 py-1.5 text-indigo-100">
              <ArrowTrendingUpIcon className="h-4 w-4" />
              Deep research ready
            </span>
          </div>
        </div>

        <div className="relative flex-1 min-h-0">
          <ProviderThreadStateProvider threadId={activeSessionId}>
            <SessionPromptSync threadId={activeSessionId} />

            <CopilotChat
              agentId={PROVIDER_AGENT_ID}
              threadId={activeSessionId}
              className="h-full"
              labels={{
                welcomeMessageText: 'Search, compare, and research providers.',
              }}
              messageView={ProviderChatMessageView}
              input={ProviderComposer}
              welcomeScreen={ProviderWelcomeScreen}
            />

            <ProviderCompareTray />
            <ProviderProfileSheet />
            <ProviderCompareSheet />
            <ProviderResearchDossierModal />
          </ProviderThreadStateProvider>
        </div>
      </div>
    </div>
  )
}
