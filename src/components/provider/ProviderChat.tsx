import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowUpIcon,
  SparklesIcon,
  StopCircleIcon,
  UserIcon,
} from '@heroicons/react/24/outline'
import {
  CopilotChatAssistantMessage,
  CopilotChatInput,
  CopilotChatMessageView,
  CopilotChatReasoningMessage,
  CopilotChatToolCallsView,
  CopilotChatUserMessage,
  CopilotChatView,
  type CopilotChatAssistantMessageProps,
  type CopilotChatInputProps,
  type CopilotChatMessageViewProps,
  type CopilotChatReasoningMessageProps,
  type CopilotChatUserMessageProps,
} from '@copilotkit/react-core/v2'
import { cn } from '@/utils/cn'
import { ProviderEmptyHint, SurfaceCard } from './ProviderUi'

type WelcomeScreenProps = ComponentProps<typeof CopilotChatView.WelcomeScreen>

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

function ProviderChatMessageViewBase(props: CopilotChatMessageViewProps) {
  return (
    <CopilotChatMessageView
      {...props}
      assistantMessage={ProviderAssistantMessage}
      userMessage={ProviderUserMessage}
      reasoningMessage={ProviderReasoningMessage}
      className={cn('space-y-8', props.className)}
    />
  )
}

export const ProviderChatMessageView = Object.assign(ProviderChatMessageViewBase, {
  Cursor: CopilotChatMessageView.Cursor,
})

function ProviderAssistantMessageBase({
  message,
  messages = [],
}: CopilotChatAssistantMessageProps) {
  const hasText = Boolean(message.content?.trim())

  return (
    <AssistantChrome>
      <div className="space-y-3">
        {hasText ? (
          <div className="relative">
            <div className="absolute -inset-1 rounded-[24px] bg-gradient-to-r from-[#3730A3]/12 via-[#6366F1]/5 to-transparent blur-xl" />
            <SurfaceCard className="relative px-5 py-4">
              <div className="prose prose-invert max-w-none prose-p:my-2 prose-pre:border prose-pre:border-white/[0.08] prose-pre:bg-[#050508] prose-headings:text-white prose-a:text-indigo-300">
                <CopilotMarkdown content={message.content ?? ''} />
              </div>
            </SurfaceCard>
          </div>
        ) : null}

        <CopilotChatToolCallsView message={message} messages={messages} />
      </div>
    </AssistantChrome>
  )
}

export const ProviderAssistantMessage = Object.assign(ProviderAssistantMessageBase, {
  MarkdownRenderer: CopilotChatAssistantMessage.MarkdownRenderer,
  Toolbar: CopilotChatAssistantMessage.Toolbar,
  ToolbarButton: CopilotChatAssistantMessage.ToolbarButton,
  CopyButton: CopilotChatAssistantMessage.CopyButton,
  ThumbsUpButton: CopilotChatAssistantMessage.ThumbsUpButton,
  ThumbsDownButton: CopilotChatAssistantMessage.ThumbsDownButton,
  ReadAloudButton: CopilotChatAssistantMessage.ReadAloudButton,
  RegenerateButton: CopilotChatAssistantMessage.RegenerateButton,
})

function getUserContent(message: CopilotChatUserMessageProps['message']) {
  if (typeof message.content === 'string') {
    return message.content
  }

  return message.content
    .flatMap((item) => (item.type === 'text' ? [item.text] : []))
    .join('\n')
}

function ProviderUserMessageBase({ message }: CopilotChatUserMessageProps) {
  const content = getUserContent(message)

  return (
    <div className="flex flex-row-reverse gap-4">
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[linear-gradient(135deg,#3730A3,#6366F1)] shadow-[0_18px_50px_-30px_rgba(99,102,241,0.9)]">
        <UserIcon className="h-4 w-4 text-white" />
      </div>
      <div className="max-w-[88%]">
        <div className="rounded-[24px] bg-[linear-gradient(135deg,#3730A3,#6366F1)] px-5 py-4 text-sm leading-relaxed text-white shadow-[0_24px_80px_-36px_rgba(99,102,241,0.85)]">
          {content}
        </div>
      </div>
    </div>
  )
}

export const ProviderUserMessage = Object.assign(ProviderUserMessageBase, {
  Container: CopilotChatUserMessage.Container,
  MessageRenderer: CopilotChatUserMessage.MessageRenderer,
  Toolbar: CopilotChatUserMessage.Toolbar,
  ToolbarButton: CopilotChatUserMessage.ToolbarButton,
  CopyButton: CopilotChatUserMessage.CopyButton,
  EditButton: CopilotChatUserMessage.EditButton,
  BranchNavigation: CopilotChatUserMessage.BranchNavigation,
})

function ProviderReasoningMessageBase({
  message,
}: CopilotChatReasoningMessageProps) {
  return (
    <AssistantChrome>
      <SurfaceCard className="px-4 py-3">
        <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Reasoning trace</div>
        <p className="mt-2 text-sm leading-relaxed text-white/58">{message.content}</p>
      </SurfaceCard>
    </AssistantChrome>
  )
}

export const ProviderReasoningMessage = Object.assign(ProviderReasoningMessageBase, {
  Header: CopilotChatReasoningMessage.Header,
  Content: CopilotChatReasoningMessage.Content,
  Toggle: CopilotChatReasoningMessage.Toggle,
})

function CopilotMarkdown({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
}

function ProviderComposerBase({
  onSubmitMessage,
  onStop,
  isRunning,
  value,
  onChange,
}: CopilotChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
  }, [value])

  const submit = () => {
    const next = value?.trim() ?? ''
    if (!next || !onSubmitMessage) return
    onSubmitMessage(next)
  }

  return (
    <div className="absolute inset-x-0 bottom-0 z-20 px-4 pb-5 pt-6 md:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="absolute -inset-4 rounded-[28px] bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.22)_0%,rgba(76,29,149,0.12)_42%,transparent_70%)] opacity-70" />
        <SurfaceCard className="relative overflow-hidden">
          <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(99,102,241,0.06),transparent_48%,rgba(76,29,149,0.08))]" />
          <div className="relative flex items-end gap-3 px-4 py-4">
            <textarea
              ref={textareaRef}
              value={value ?? ''}
              onChange={(event) => onChange?.(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  if (isRunning) {
                    onStop?.()
                  } else {
                    submit()
                  }
                }
              }}
              rows={1}
              placeholder="Search for a provider, compare candidates, or open a full research dossier..."
              className="min-h-[48px] max-h-[200px] flex-1 resize-none bg-transparent px-2 py-3 text-[15px] leading-relaxed text-white/88 placeholder:text-white/28 focus:outline-none"
            />

            <motion.button
              type="button"
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.96 }}
              onClick={isRunning ? onStop : submit}
              className={cn(
                'flex h-11 w-11 items-center justify-center rounded-2xl transition-all',
                isRunning
                  ? 'border border-rose-300/20 bg-rose-400/12 text-rose-100'
                  : value?.trim()
                    ? 'bg-[linear-gradient(135deg,#6366F1,#4C1D95)] text-white shadow-[0_18px_50px_-28px_rgba(99,102,241,0.8)]'
                    : 'border border-white/[0.06] bg-white/[0.03] text-white/25',
              )}
            >
              {isRunning ? <StopCircleIcon className="h-5 w-5" /> : <ArrowUpIcon className="h-5 w-5" />}
            </motion.button>
          </div>
        </SurfaceCard>

        <div className="mt-2 text-center text-[10px] font-light text-white/30">
          <span className="rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[9px] text-white/42">Enter</span>
          <span className="ml-1">to send</span>
          <span className="mx-1.5">·</span>
          <span className="rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[9px] text-white/42">Shift+Enter</span>
          <span className="ml-1">for a new line</span>
        </div>
      </div>
    </div>
  )
}

export const ProviderComposer = Object.assign(ProviderComposerBase, {
  SendButton: CopilotChatInput.SendButton,
  ToolbarButton: CopilotChatInput.ToolbarButton,
  StartTranscribeButton: CopilotChatInput.StartTranscribeButton,
  CancelTranscribeButton: CopilotChatInput.CancelTranscribeButton,
  FinishTranscribeButton: CopilotChatInput.FinishTranscribeButton,
  AddMenuButton: CopilotChatInput.AddMenuButton,
  AudioRecorder: CopilotChatInput.AudioRecorder,
  Disclaimer: CopilotChatInput.Disclaimer,
  TextArea: CopilotChatInput.TextArea,
})

export function ProviderWelcomeScreen({ input }: WelcomeScreenProps) {
  return (
    <div className="h-full">
      <ProviderEmptyHint />
      <div className="absolute inset-x-0 bottom-0">{input}</div>
    </div>
  )
}
