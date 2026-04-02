import { memo, useMemo } from 'react'
import { motion } from 'framer-motion'
import { SparklesIcon, UserIcon, WrenchIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { MessageBlock, BuildMessage } from './types'
import { cn } from '@/utils/cn'
import {
  ChainOfThought,
  ChainOfThoughtHeader,
  ChainOfThoughtContent,
  ChainOfThoughtStep,
  ChainOfThoughtSearchResults,
  ChainOfThoughtSearchResult,
} from '@/components/ai-elements/chain-of-thought'
import { TabAttachments } from '@/components/ai-elements/TabAttachment'

interface MessageRendererProps {
  message: BuildMessage
}

export const MessageRenderer = memo(function MessageRenderer({ message }: MessageRendererProps) {
  const isUser = message.role === 'user'
  
  // Separate blocks for rendering
  const { textBlocks, thinkingBlocks } = useMemo(() => {
    const text: Extract<MessageBlock, { type: 'text' }>[] = []
    const thinking: MessageBlock[] = []
    
    message.blocks.forEach(block => {
      if (block.type === 'text') {
        text.push(block)
      } else {
        thinking.push(block)
      }
    })
    
    return { textBlocks: text, thinkingBlocks: thinking }
  }, [message.blocks])

  const content = textBlocks.map(b => b.content).join('\n\n')

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn('flex gap-4', isUser ? 'flex-row-reverse' : '')}
    >
      {/* Avatar with glow effect */}
      <div className="flex-shrink-0 relative mt-1">
        {!isUser && (
          <div className="absolute -inset-1 bg-gradient-to-r from-[#4C1D95]/30 to-[#6366F1]/20 rounded-xl blur-md opacity-60" />
        )}
        <div
          className={cn(
            'relative w-8 h-8 rounded-xl flex items-center justify-center shadow-lg',
            isUser 
              ? 'bg-gradient-to-br from-[#3730A3] to-[#6366F1]' 
              : 'bg-gradient-to-br from-surface-800 to-surface-900 border border-surface-700/50'
          )}
        >
          {isUser ? (
            <UserIcon className="w-4 h-4 text-white" />
          ) : (
            <SparklesIcon className="w-4 h-4 text-[#6366F1]" />
          )}
        </div>
      </div>

      {/* Content */}
      <div className={cn('flex-1 min-w-0', isUser ? 'text-right' : '')}>
        {isUser ? (
          <div className="inline-block max-w-[90%] text-left">
            {/* Tab attachments in sent messages */}
            {message.tabAttachments && message.tabAttachments.length > 0 && (
              <div className="mb-2">
                <TabAttachments
                  tabs={message.tabAttachments.map(t => ({
                    ...t,
                    type: 'tab' as const,
                  }))}
                  showPreview={false}
                />
              </div>
            )}
            <div className="px-4 py-3 rounded-2xl bg-gradient-to-br from-[#3730A3] to-[#6366F1] text-white shadow-lg shadow-[#3730A3]/20">
              <div className="prose prose-invert prose-p:my-1 prose-sm max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {content}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4 max-w-[95%]">
            {thinkingBlocks.length > 0 && (
              <ChainOfThought defaultOpen={message.isStreaming}>
                <ChainOfThoughtHeader>Process & Reasoning</ChainOfThoughtHeader>
                <ChainOfThoughtContent>
                  {thinkingBlocks.map((block, idx) => {
                    if (block.type === 'reasoning') {
                      return (
                        <ChainOfThoughtStep
                          key={`reasoning-${idx}`}
                          label={block.summary}
                          status={block.isComplete ? 'complete' : 'active'}
                        >
                          <div className="text-muted-foreground text-xs leading-relaxed italic">
                            {block.details}
                          </div>
                        </ChainOfThoughtStep>
                      )
                    }
                    
                    if (block.type === 'tool_call') {
                      return (
                        <ChainOfThoughtStep
                          key={`tool-${idx}`}
                          icon={WrenchIcon}
                          label={`Using ${block.toolName}`}
                          status={block.status === 'success' ? 'complete' : block.status === 'error' ? 'complete' : 'active'}
                          description={block.duration ? `Took ${block.duration}ms` : undefined}
                        >
                          {block.status === 'error' && (
                            <div className="text-destructive text-xs mt-1">
                              {block.error}
                            </div>
                          )}
                        </ChainOfThoughtStep>
                      )
                    }

                    if (block.type === 'citations' || block.type === 'sources') {
                      const items = block.type === 'citations' ? block.items : block.items
                      return (
                        <ChainOfThoughtStep
                          key={`sources-${idx}`}
                          icon={MagnifyingGlassIcon}
                          label={`Gathered ${items.length} sources`}
                          status="complete"
                        >
                          <ChainOfThoughtSearchResults>
                            {items.map((item, sIdx) => (
                              <ChainOfThoughtSearchResult key={sIdx}>
                                {item.url ? (
                                  (() => {
                                    try {
                                      return new URL(item.url).hostname
                                    } catch {
                                      return 'source'
                                    }
                                  })()
                                ) : 'source'}
                              </ChainOfThoughtSearchResult>
                            ))}
                          </ChainOfThoughtSearchResults>
                        </ChainOfThoughtStep>
                      )
                    }

                    return null
                  })}
                </ChainOfThoughtContent>
              </ChainOfThought>
            )}

            {content && (
              <div className="relative">
                {/* Subtle glow behind assistant message */}
                <div className="absolute -inset-1 bg-gradient-to-r from-[#3730A3]/10 via-[#6366F1]/5 to-transparent rounded-2xl blur-xl opacity-50" />
                
                <div className="relative bg-surface-900/60 border border-surface-700/40 rounded-2xl px-5 py-4 text-ink-inverse shadow-xl">
                   <div className="prose prose-invert prose-p:my-2 prose-pre:bg-surface-950 prose-pre:border prose-pre:border-surface-800 prose-sm max-w-none prose-headings:font-semibold prose-a:text-[#6366F1]">
                     <ReactMarkdown remarkPlugins={[remarkGfm]}>
                       {content}
                     </ReactMarkdown>
                   </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </motion.div>
  )
})