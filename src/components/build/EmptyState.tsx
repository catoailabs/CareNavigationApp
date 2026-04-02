/**
 * Empty State Component - SuperAgentInterface Aesthetic
 * 
 * Features:
 * - Georgia serif headline with deterministic rotation
 * - Dark rich purple accents (#3730A3, #4C1D95)
 * - Surface-950/900 color system
 * - Premium custom input with paste-to-attachment logic
 */

import { useState, useMemo, memo, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useBuildStore } from '@/stores/buildStore'
import { ContextPicker, type ContextItem } from '@/components/agent-panel/ContextPicker'
import { TabAttachments } from '@/components/ai-elements/TabAttachment'
import buildPhrases from '@/data/buildPhrases.json'
import { useAuthStore } from '@/stores/authStore'
import { SparklesIcon, ArrowRightIcon, XMarkIcon, ArrowUpIcon, PaperClipIcon } from '@heroicons/react/24/outline'
import { cn } from '@/utils/cn'
import { fileToDataUrl, makePastedTextFilename } from '@/utils/file-utils'

const EASE = [0.16, 1, 0.3, 1] as const
const LARGE_PASTE_THRESHOLD_CHARS = 2000



interface EmptyStateProps {
  onSubmit: (text: string, tabAttachments?: Array<{ id: string; name: string; url?: string; title?: string; favicon?: string; screenshotUrl?: string }>) => void
}

/**
 * Deterministic phrase selection based on seed
 */
function selectPhrase(userId: string, navigationCounter: number): string {
  const dateKey = new Date().toISOString().slice(0, 10)
  const seed = `${userId}:${navigationCounter}:${dateKey}`
  
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  
  const index = Math.abs(hash) % buildPhrases.length
  return buildPhrases[index]
}

// ─────────────────────────────────────────────────────────────────────────────
// Suggestion Pill Component
// ─────────────────────────────────────────────────────────────────────────────

interface SuggestionPillProps {
  text: string
  onClick: () => void
  delay: number
}

const SuggestionPill = memo(function SuggestionPill({ text, onClick, delay }: SuggestionPillProps) {
  return (
    <motion.button
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.4, ease: EASE }}
      onClick={onClick}
      className="group relative px-4 py-2.5 rounded-xl text-sm font-light text-ink-inverse-secondary bg-surface-800/40 border border-surface-700/50 hover:border-[#4C1D95]/50 hover:text-ink-inverse transition-all duration-300 overflow-hidden"
    >
      {/* Hover gradient effect */}
      <div 
        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-[linear-gradient(90deg,transparent_0%,rgba(99,102,241,0.1)_50%,transparent_100%)]"
      />
      
      <span className="relative z-10 flex items-center gap-2">
        {text}
        <ArrowRightIcon className="w-3 h-3 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300" />
      </span>
    </motion.button>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Context Chip Component
// ─────────────────────────────────────────────────────────────────────────────

interface ContextChipProps {
  context: ContextItem
  onRemove: () => void
}

const ContextChip = memo(function ContextChip({ context, onRemove }: ContextChipProps) {
  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      className="group flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#4C1D95]/20 border border-[#4C1D95]/30 text-xs text-ink-inverse-secondary hover:border-[#6366F1]/50 transition-colors"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-[#6366F1]" />
      <span className="max-w-[120px] truncate">{context.name}</span>
      <button 
        onClick={onRemove}
        aria-label="Remove context"
        className="p-0.5 rounded hover:bg-[#4C1D95]/30 text-ink-inverse-muted hover:text-ink-inverse transition-colors"
      >
        <XMarkIcon className="w-3 h-3" />
      </button>
    </motion.div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Premium Input Component
// ─────────────────────────────────────────────────────────────────────────────

interface PremiumInputProps {
  onSubmit: (text: string, tabAttachments?: Array<{ id: string; name: string; url?: string; title?: string; favicon?: string; screenshotUrl?: string }>) => void
}

const PremiumInput = memo(function PremiumInput({ onSubmit }: PremiumInputProps) {
  const [value, setValue] = useState('')
  const [selectedContexts, setSelectedContexts] = useState<ContextItem[]>([])
  const [textAttachments, setTextAttachments] = useState<Array<{ id: string; file: File; dataUrl: string; name: string }>>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [isFocused, setIsFocused] = useState(false)

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
    }
  }, [value])

  const handleSubmit = () => {
    const trimmed = value.trim()
    if (!trimmed && textAttachments.length === 0) return
    
    // Build message with context and attachments
    let finalMessage = trimmed
    
    // Extract tab contexts for persistence
    const tabContexts = selectedContexts.filter(c => c.type === 'tab')
    const nonTabContexts = selectedContexts.filter(c => c.type !== 'tab')
    
    // Add non-tab context as text
    if (nonTabContexts.length > 0) {
      const contextString = nonTabContexts
        .map((ctx) => `[Context: ${ctx.type}] ${ctx.name} - ${ctx.description || ''}`)
        .join('\n')
      finalMessage = `Context:\n${contextString}\n\n${trimmed}`
    }
    
    // Add tab context as text reference too
    if (tabContexts.length > 0) {
      const tabString = tabContexts
        .map((ctx) => `[Context: Tab] ${ctx.title || ctx.name} (${ctx.url || ''})`)
        .join('\n')
      finalMessage = tabContexts.length > 0 && nonTabContexts.length === 0
        ? `Context:\n${tabString}\n\n${trimmed}`
        : `${finalMessage}\n${tabString}`
    }
    
    if (textAttachments.length > 0) {
      const attachmentNames = textAttachments.map(a => a.name).join(', ')
      finalMessage = `${finalMessage}\n\n[Attachments: ${attachmentNames}]`
    }
    
    // Pass tab attachments for visual persistence
    const tabAttachmentData = tabContexts.map(t => ({
      id: t.id,
      name: t.name,
      url: t.url,
      title: t.title,
      favicon: t.favicon,
      screenshotUrl: t.screenshotUrl,
    }))
    
    onSubmit(finalMessage, tabAttachmentData.length > 0 ? tabAttachmentData : undefined)
    setValue('')
    setSelectedContexts([])
    setTextAttachments([])
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  // Handle paste events - detect large pastes and convert to attachments
  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items || [])
    const fileItems = items
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => Boolean(f))

    if (fileItems.length > 0) {
      e.preventDefault()
      for (const file of fileItems) {
        const dataUrl = await fileToDataUrl(file)
        setTextAttachments(prev => [...prev, {
          id: Math.random().toString(36).substr(2, 9),
          file,
          dataUrl,
          name: file.name
        }])
      }
      return
    }

    const text = e.clipboardData.getData('text/plain')
    if (text && text.length >= LARGE_PASTE_THRESHOLD_CHARS) {
      e.preventDefault()
      const file = new File([text], makePastedTextFilename(), { type: 'text/plain' })
      const dataUrl = await fileToDataUrl(file)
      setTextAttachments(prev => [...prev, {
        id: Math.random().toString(36).substr(2, 9),
        file,
        dataUrl,
        name: file.name
      }])
    }
  }

  const removeAttachment = (id: string) => {
    setTextAttachments(prev => prev.filter(a => a.id !== id))
  }

  const hasContent = value.trim().length > 0 || textAttachments.length > 0

  return (
    <div className="relative">
      {/* Outer ambient glow */}
      <div 
        className={cn(
          "absolute -inset-4 rounded-[28px] transition-all duration-700",
          "bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.25)_0%,rgba(76,29,149,0.15)_40%,transparent_70%)]",
          isFocused ? "opacity-80 scale-105" : "opacity-30"
        )}
      />
      
      {/* Gradient border ring */}
      <div 
        className={cn(
          "absolute -inset-[1px] rounded-2xl transition-all duration-500",
          "bg-gradient-to-br from-[#6366F1]/40 via-[#4C1D95]/20 to-[#818CF8]/30",
          isFocused ? "opacity-100" : "opacity-0"
        )}
      />
      
      {/* Input container */}
      <div 
        className={cn(
          "relative rounded-2xl transition-all duration-300",
          "bg-[#0c0c18]/90 backdrop-blur-2xl",
          "border",
          isFocused 
            ? "border-[#6366F1]/30 shadow-[0_0_30px_-5px_rgba(99,102,241,0.2),0_0_60px_-15px_rgba(76,29,149,0.15)]" 
            : "border-white/[0.08] shadow-xl shadow-black/20"
        )}
      >
        {/* Context & Attachments */}
        <AnimatePresence>
          {(selectedContexts.length > 0 || textAttachments.length > 0) && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="px-4 pt-3 flex flex-wrap gap-2 border-b border-surface-700/30"
            >
              {/* Tab contexts → rich TabAttachments */}
              <TabAttachments
                tabs={selectedContexts.filter(c => c.type === 'tab')}
                onRemove={(tabId) => setSelectedContexts(prev => prev.filter(c => c.id !== tabId))}
                showPreview
              />
              {/* Non-tab contexts → ContextChip */}
              {selectedContexts.filter(c => c.type !== 'tab').map((ctx, idx) => (
                <ContextChip
                  key={ctx.id || idx}
                  context={ctx}
                  onRemove={() => setSelectedContexts(prev => prev.filter((_, i) => i !== idx))}
                />
              ))}
              {textAttachments.map(att => (
                <motion.div
                  key={att.id}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-800 border border-surface-700 text-xs text-ink-inverse-secondary"
                >
                  <PaperClipIcon className="w-3 h-3 text-[#6366F1]" />
                  <span className="max-w-[100px] truncate">{att.name}</span>
                  <button 
                    onClick={() => removeAttachment(att.id)}
                    aria-label="Remove attachment"
                    className="p-0.5 rounded hover:bg-surface-700 text-ink-inverse-muted hover:text-ink-inverse"
                  >
                    <XMarkIcon className="w-3 h-3" />
                  </button>
                </motion.div>
              ))}
              <div className="pb-3" />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Input area */}
        <div className="relative flex items-end gap-2 p-3">
          {/* Context Picker */}
          <div className="flex-shrink-0 pb-1">
            <ContextPicker
              selectedContexts={selectedContexts}
              onContextsChange={setSelectedContexts}
            />
          </div>

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder="Describe your vision and watch it come to life..."
            rows={1}
            className={cn(
              "flex-1 resize-none py-3 px-2 bg-transparent",
              "text-[15px] leading-relaxed text-white/90 placeholder:text-white/25",
              "focus:outline-none min-h-[56px] max-h-[200px]",
              "font-light tracking-wide"
            )}
          />

          {/* Send Button */}
          <motion.button
            onClick={handleSubmit}
            disabled={!hasContent}
            whileHover={{ scale: hasContent ? 1.05 : 1 }}
            whileTap={{ scale: hasContent ? 0.95 : 1 }}
            className={cn(
              "flex-shrink-0 w-11 h-11 rounded-xl flex items-center justify-center",
              "transition-all duration-300",
              hasContent
                ? "bg-gradient-to-br from-[#6366F1] to-[#4C1D95] text-white shadow-lg shadow-[#6366F1]/25 ring-1 ring-[#818CF8]/20"
                : "bg-white/[0.04] text-white/20 cursor-not-allowed border border-white/[0.06]"
            )}
          >
            <ArrowUpIcon className="w-5 h-5" />
          </motion.button>
        </div>
      </div>
    </div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export function EmptyState({ onSubmit }: EmptyStateProps) {
  const { navigationCounter } = useBuildStore()
  const { user } = useAuthStore()
  const userId = user?.id || 'anonymous'

  const headline = useMemo(
    () => selectPhrase(userId, navigationCounter),
    [userId, navigationCounter]
  )

  const suggestions = [
    'A dashboard with real-time charts',
    'Landing page with dark mode',
    'REST API with authentication',
    'Interactive form wizard',
  ]

  const handleSuggestionClick = (text: string) => {
    onSubmit(text)
  }

  return (
    <div className="flex flex-col items-center justify-center h-full px-6 relative">
      {/* Decorative gradient orb - dark rich purple */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[500px] pointer-events-none">
        <motion.div 
          animate={{ 
            scale: [1, 1.05, 1], 
            opacity: [0.08, 0.15, 0.08] 
          }}
          transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
          className="w-full h-full bg-[radial-gradient(ellipse,#3730A340,transparent_60%)] blur-[100px]"
        />
      </div>
      
      {/* Hero Headline */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: EASE }}
        className="text-center mb-10 relative z-10"
      >
        {/* Badge */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2, duration: 0.5 }}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface-800/60 border border-[#4C1D95]/30 mb-6"
        >
          <SparklesIcon className="w-3.5 h-3.5 text-[#6366F1]" />
          <span className="text-xs font-light text-ink-inverse-muted tracking-wide">AI-Powered Development</span>
        </motion.div>
        
        <h1 className="text-4xl md:text-5xl lg:text-6xl font-serif font-semibold text-ink-inverse leading-tight tracking-tight">
          {headline}
        </h1>
        
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4, duration: 0.5 }}
          className="mt-5 text-lg text-ink-inverse-muted font-light max-w-lg mx-auto"
        >
          Describe your vision and watch it come to life
        </motion.p>
      </motion.div>

      {/* Premium Input */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.6, ease: EASE }}
        className="w-full max-w-2xl relative z-10"
      >
        <PremiumInput onSubmit={onSubmit} />
      </motion.div>

      {/* Suggestion Pills */}
      <div className="mt-10 flex flex-wrap justify-center gap-3 max-w-2xl relative z-10">
        {suggestions.map((suggestion, i) => (
          <SuggestionPill
            key={i}
            text={suggestion}
            onClick={() => handleSuggestionClick(suggestion)}
            delay={0.5 + i * 0.1}
          />
        ))}
      </div>
      
      {/* Keyboard hint */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1, duration: 0.5 }}
        className="mt-8 text-center"
      >
        <span className="text-[10px] text-ink-inverse-muted/40 font-light">
          Press <kbd className="px-1.5 py-0.5 rounded bg-surface-800 text-ink-inverse-muted/60 border border-surface-700 font-mono text-[9px]">Enter</kbd> to submit
        </span>
      </motion.div>
    </div>
  )
}
