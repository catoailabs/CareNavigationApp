import { useMemo, useRef, useEffect, useState, type ReactNode } from 'react'
import { getToolName, isToolUIPart, type FileUIPart, type UIMessage } from 'ai'
import { ArrowTrendingUpIcon, BuildingOffice2Icon, UserIcon } from '@heroicons/react/24/outline'
import { SparklesIcon } from '@heroicons/react/24/outline'
import { ProviderThreadStateProvider } from '@/copilot/provider/ProviderThreadState'
import { PROVIDER_AGENT_ID } from '@/copilot/provider/constants'
import {
  ProviderCompareSheet,
  ProviderCompareTray,
  ProviderProfileSheet,
  ProviderResearchDossierModal,
} from '@/components/provider/ProviderUi'
import { ProviderPromptInput } from '@/components/provider/ProviderPromptInput'
import { useBuildStore } from '@/stores/buildStore'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { JSXPreview, JSXPreviewContent } from '@/components/ai-elements/jsx-preview'
import { GEN_UI_COMPONENTS } from '@/components/ai-elements/jsxPreviewRegistry'
import { TabAttachments } from '@/components/ai-elements/TabAttachment'
import {
  Attachment,
  Attachments,
  AttachmentInfo,
  AttachmentPreview,
} from '@/components/ai-elements/attachments'
import { StrandsChainOfThought } from '@/components/ai-elements/strands-chain-of-thought'
import { StrandsMultiAgentWorkflow } from '@/components/ai-elements/strands-workflow'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/utils/cn'
import type {
  ProviderChatMessage,
  ProviderComposerSubmitPayload,
  ProviderMessageMetadata,
  ProviderTabAttachment,
} from '@/components/provider/providerChatTypes'

function AssistantChrome({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="relative mt-1 h-8 w-8 shrink-0">
        <div className="absolute -inset-1 rounded-xl bg-gradient-to-r from-[#4C1D95]/30 to-[#6366F1]/20 blur-md" />
        <div className="relative flex h-8 w-8 items-center justify-center rounded-xl border border-white/[0.08] bg-[linear-gradient(135deg,rgba(15,15,25,0.96),rgba(20,20,32,0.96))]">
          <SparklesIcon className="h-4 w-4 text-indigo-300" />
        </div>
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/**
 * Renders an assistant message's parts.
 * - Text parts: markdown or Gen-UI JSX
 * - Reasoning + tool parts: delegated to StrandsChainOfThought which maps
 *   each tool to its rich ai-elements component (browser, code, search, etc.)
 */
function MessageParts({ message, isStreaming }: { message: ProviderChatMessage; isStreaming: boolean }) {
  const hasTimeline = message.parts.some(
    (p) => p.type === 'reasoning' || isToolUIPart(p)
  )

  return (
    <div className="space-y-3">
      {/* Render text parts inline */}
      {message.parts.map((part, i) => {
        // Skip tool and reasoning parts — handled by StrandsChainOfThought below
        if (isToolUIPart(part) || part.type === 'reasoning') return null

        switch (part.type) {
          case 'text': {
            const text = (part as { type: 'text'; text: string }).text
            if (!text.trim()) return null
            // Check if text contains JSX-like tags for Gen-UI rendering
            const hasJsx = /<[A-Z][a-zA-Z]*[\s/>]/.test(text)
            if (hasJsx) {
              return (
                <JSXPreview
                  key={`${message.id}-${i}`}
                  jsx={text}
                  isStreaming={isStreaming}
                  components={GEN_UI_COMPONENTS as unknown as Record<string, React.ComponentType<Record<string, unknown>>>}
                >
                  <JSXPreviewContent />
                </JSXPreview>
              )
            }
            return (
              <div key={`${message.id}-${i}`} className="relative">
                <div className="absolute -inset-1 rounded-[24px] bg-gradient-to-r from-[#3730A3]/12 via-[#6366F1]/5 to-transparent blur-xl" />
                <div className="relative rounded-2xl border border-white/[0.06] bg-white/[0.02] px-5 py-4">
                  <div className="prose prose-invert max-w-none prose-p:my-2 prose-pre:border prose-pre:border-white/[0.08] prose-pre:bg-[#050508] prose-headings:text-white prose-a:text-indigo-300">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
                  </div>
                </div>
              </div>
            )
          }
          case 'step-start':
            return i > 0 ? <hr key={`${message.id}-${i}`} className="border-white/[0.06]" /> : null
          default:
            return null
        }
      })}

      {/* Rich chain-of-thought timeline: reasoning blocks, each tool mapped to its
          dedicated ai-elements component (browser viewer, code blocks, search results,
          sandbox, subagent inspector, HITL confirmation, etc.) */}
      {hasTimeline && (
        <StrandsChainOfThought message={message} isStreaming={isStreaming} />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Subagent Workflow Extraction
// ─────────────────────────────────────────────────────────────────────────────

const SUBAGENT_TOOL_NAMES = ['subagent', 'call_subagent', 'use_agent', 'agent_skills', 'skill']

function isSubagentTool(toolName: string): boolean {
  const lower = toolName.toLowerCase()
  return SUBAGENT_TOOL_NAMES.some(name => lower.includes(name))
}

/**
 * Extract subagent orchestration data from the AI SDK message stream.
 * Builds React Flow nodes, edges, and per-node agent state for the 70/30 workflow.
 */
function extractWorkflowData(messages: UIMessage[]) {
  const nodes: Array<{ id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown> }> = []
  const edges: Array<{ id: string; source: string; target: string; animated?: boolean }> = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentsDataMap: Record<string, any> = {}
  const seenAgents = new Set<string>()
  let subagentCount = 0

  // Always add the orchestrator node
  nodes.push({
    id: 'orchestrator',
    type: 'agentNode',
    position: { x: 250, y: 30 },
    data: { agentName: 'Orchestrator', role: 'Primary Agent', status: 'Active' },
  })
  agentsDataMap['orchestrator'] = {
    agentName: 'Orchestrator',
    model: 'grok-4.20',
    systemPrompt: 'Root agent coordinating subagent execution.',
    events: [],
  }

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const part of msg.parts) {
      if (!isToolUIPart(part)) continue
      const toolName = getToolName(part)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args = (part.input || {}) as Record<string, any>
      const state = part.state
      const isComplete = state === 'output-available' || state === 'output-error'

      if (isSubagentTool(toolName)) {
        const agentName = args.agent_name || args.name || toolName
        const agentId = `subagent-${agentName}`

        if (!seenAgents.has(agentId)) {
          seenAgents.add(agentId)
          subagentCount++
          const col = subagentCount % 3
          const row = Math.floor((subagentCount - 1) / 3)

          nodes.push({
            id: agentId,
            type: 'agentNode',
            position: { x: 80 + col * 220, y: 160 + row * 140 },
            data: {
              agentName,
              role: args.role || 'Subagent',
              status: isComplete ? 'Complete' : 'Running',
            },
          })

          edges.push({
            id: `edge-orchestrator-${agentId}`,
            source: 'orchestrator',
            target: agentId,
            animated: !isComplete,
          })

          agentsDataMap[agentId] = {
            agentName,
            model: args.model || 'default-model',
            systemPrompt: args.instructions || args.system_prompt || 'Executing delegated task.',
            events: [],
          }
        }

        // Record the event
        agentsDataMap[agentId]?.events?.push({
          type: 'tool',
          toolName,
          status: isComplete ? 'complete' : 'active',
        })
      } else {
        // Non-subagent tool calls are logged on the orchestrator
        agentsDataMap['orchestrator']?.events?.push({
          type: 'tool',
          toolName,
          status: isComplete ? 'complete' : 'active',
        })
      }
    }

    // Collect reasoning events for orchestrator
    for (const part of msg.parts) {
      if (part.type === 'reasoning') {
        agentsDataMap['orchestrator']?.events?.push({
          type: 'reasoning',
          text: part.text?.slice(0, 120) + (part.text && part.text.length > 120 ? '...' : ''),
        })
      }
    }
  }

  return { nodes, edges, agentsDataMap, hasSubagents: seenAgents.size > 0 }
}

function WorkflowPanel({ messages }: { messages: UIMessage[] }) {
  const { nodes, edges, agentsDataMap, hasSubagents } = useMemo(
    () => extractWorkflowData(messages),
    [messages]
  )
  const [isExpanded, setIsExpanded] = useState(true)

  if (!hasSubagents) return null

  return (
    <div className="border-b border-white/[0.06]">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-6 py-3 text-left text-xs uppercase tracking-[0.18em] text-white/42 hover:text-white/60 transition-colors"
      >
        <span className={cn('transition-transform', isExpanded ? 'rotate-90' : '')}>▸</span>
        <span>Multi-Agent Workflow ({nodes.length - 1} subagents)</span>
      </button>
      {isExpanded && (
        <div className="px-4 pb-4">
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
            <StrandsMultiAgentWorkflow
              nodes={nodes}
              edges={edges}
              agentsDataMap={agentsDataMap}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function getProviderMessageMetadata(metadata: unknown): ProviderMessageMetadata | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined
  }

  return metadata as ProviderMessageMetadata
}

function toInlineAttachment(part: FileUIPart, id: string) {
  return {
    ...part,
    id,
  }
}

function UserMessage({ message }: { message: ProviderChatMessage }) {
  const metadata = getProviderMessageMetadata(message.metadata)
  const textPart = message.parts.find((part) => part.type === 'text')
  const displayText =
    metadata?.displayText?.trim() ||
    (textPart && textPart.type === 'text' ? textPart.text.trim() : '') ||
    (message.parts.some((part) => part.type === 'file') || metadata?.tabAttachments?.length
      ? 'Attached context'
      : '')

  const fileParts = message.parts.filter((part): part is FileUIPart => part.type === 'file')
  const imageParts = fileParts.filter((part) => part.mediaType.startsWith('image/'))
  const documentParts = fileParts.filter((part) => !part.mediaType.startsWith('image/'))
  const tabAttachments = metadata?.tabAttachments ?? []

  return (
    <div className="flex flex-row-reverse gap-4">
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[linear-gradient(135deg,#3730A3,#6366F1)] shadow-[0_18px_50px_-30px_rgba(99,102,241,0.9)]">
        <UserIcon className="h-4 w-4 text-white" />
      </div>
      <div className="min-w-0 max-w-[88%]">
        <div className="flex flex-col items-end gap-3">
          {tabAttachments.length > 0 ? (
            <div className="flex w-full justify-end">
              <TabAttachments
                tabs={tabAttachments as ProviderTabAttachment[]}
                showPreview={false}
                className="pt-1"
              />
            </div>
          ) : null}

          {imageParts.length > 0 ? (
            <Attachments variant="grid" className="ml-auto">
              {imageParts.map((part, index) => (
                <Attachment
                  key={`${message.id}-image-${index}`}
                  data={toInlineAttachment(part, `${message.id}-image-${index}`)}
                  className="size-24 rounded-2xl border border-white/[0.08] bg-white/[0.03]"
                >
                  <AttachmentPreview />
                </Attachment>
              ))}
            </Attachments>
          ) : null}

          {documentParts.length > 0 ? (
            <Attachments variant="inline" className="ml-auto">
              {documentParts.map((part, index) => (
                <Attachment
                  key={`${message.id}-file-${index}`}
                  data={toInlineAttachment(part, `${message.id}-file-${index}`)}
                  className="h-10 rounded-xl border border-white/[0.08] bg-white/[0.03] px-2.5 text-white/72"
                >
                  <AttachmentPreview className="size-6 rounded-md bg-white/[0.08]" />
                  <AttachmentInfo className="text-xs" />
                </Attachment>
              ))}
            </Attachments>
          ) : null}

          {displayText ? (
            <div className="rounded-[24px] bg-[linear-gradient(135deg,#3730A3,#6366F1)] px-5 py-4 text-left text-sm leading-relaxed text-white shadow-[0_24px_80px_-36px_rgba(99,102,241,0.85)]">
              <p>{displayText}</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ActiveChat({ sessionId }: { sessionId: string }) {
  const { messages, sendMessage, status, stop } = useChat<ProviderChatMessage>({
    transport: new DefaultChatTransport({
      api: '/api/chat',
      body: sessionId ? { sessionId } : undefined,
    }),
  })
  const isStreaming = status === 'streaming' || status === 'submitted'
  const recordSessionPrompt = useBuildStore(state => state.recordSessionPrompt)
  const scrollRef = useRef<HTMLDivElement>(null)

  const sendUserMessage = (text: string) => {
    void sendMessage({ text })
  }

  const handleComposerSubmit = ({ displayText, files, promptText, tabAttachments }: ProviderComposerSubmitPayload) => {
    void sendMessage({
      text: promptText || (files.length > 0 || tabAttachments.length > 0 ? 'Attached context' : ''),
      files: files.length > 0 ? files : undefined,
      metadata: {
        displayText,
        tabAttachments,
      },
    })
  }

  // Record first user prompt as session title
  const firstUserMessage = useMemo(() => {
    const msg = messages.find(m => m.role === 'user')
    if (!msg) return null
    const metadata = getProviderMessageMetadata(msg.metadata)
    if (metadata?.displayText?.trim()) {
      return metadata.displayText.trim()
    }
    const textPart = msg.parts.find(p => p.type === 'text')
    return textPart && textPart.type === 'text' ? textPart.text : null
  }, [messages])

  useEffect(() => {
    if (firstUserMessage) recordSessionPrompt(firstUserMessage)
  }, [firstUserMessage, recordSessionPrompt])

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  return (
    <ProviderThreadStateProvider
      key={sessionId}
      threadId={sessionId}
      messages={messages}
      sendMessage={sendUserMessage}
      isRunning={isStreaming}
    >
      <div className="flex h-full flex-col">
        {/* 70/30 Multi-Agent Workflow panel — renders when subagent orchestration is detected */}
        <WorkflowPanel messages={messages} />

        <div
          ref={scrollRef}
          className={cn(
            'flex-1 overflow-y-auto px-6 pt-6',
            messages.length === 0 ? 'pb-6' : 'pb-56',
          )}
        >
          <div className="space-y-8">
            {messages.map(message => (
              <div key={message.id}>
                {message.role === 'user' ? (
                  <UserMessage message={message} />
                ) : message.role === 'assistant' ? (
                  <AssistantChrome>
                    <MessageParts message={message} isStreaming={isStreaming} />
                  </AssistantChrome>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        {messages.length === 0 ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center px-6">
            <div className="w-full max-w-4xl">
              <ProviderPromptInput
                isCentered
                isStreaming={isStreaming}
                onStop={stop}
                onSubmit={handleComposerSubmit}
              />
            </div>
          </div>
        ) : (
          <div className="absolute inset-x-0 bottom-0 z-20 px-4 pb-5 pt-6 md:px-6">
            <div className="mx-auto max-w-4xl">
              <ProviderPromptInput
                isStreaming={isStreaming}
                onStop={stop}
                onSubmit={handleComposerSubmit}
              />
            </div>
          </div>
        )}
      </div>

      <ProviderCompareTray />
      <ProviderProfileSheet />
      <ProviderCompareSheet />
      <ProviderResearchDossierModal />
    </ProviderThreadStateProvider>
  )
}

export function CenterPane() {
  const activeSessionId = useBuildStore(state => state.activeSessionId)
  const sessions = useBuildStore(state => state.sessions)
  const createSession = useBuildStore(state => state.createSession)
  const activeSession = sessions.find(s => s.id === activeSessionId) ?? null

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
    <div className="relative flex flex-1 min-w-0 flex-col">
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

        <div className="relative flex-1 min-h-0 overflow-hidden">
          <ActiveChat sessionId={activeSessionId} />
        </div>
      </div>
    </div>
  )
}
