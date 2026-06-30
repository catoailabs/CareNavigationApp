import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { cn } from '@/utils/cn'

export type CatalogItem = {
  id: string
  name: string
  description?: string
  kind: 'env' | 'tool' | 'connector' | 'skill' | 'openapi' | 'toolset'
  category?: string
}

export type PromptMentionCatalog = {
  env: CatalogItem[]
  tools: CatalogItem[]
  connectors: CatalogItem[]
  skills: CatalogItem[]
  openapiSpecs: CatalogItem[]
  toolsets: CatalogItem[]
}

interface UseMentionPickerOptions {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  value: string
  onChange: (value: string) => void
  catalog: PromptMentionCatalog
  disabled?: boolean
}

interface MentionPickerState {
  open: boolean
  query: string
  position: { top: number; left: number }
}

const TOKEN_PREFIXES: Record<CatalogItem['kind'], string> = {
  env: '@env:',
  tool: '@tool:',
  connector: '@connector:',
  skill: '@skill:',
  openapi: '@openapi:',
  toolset: '@toolset:',
}

function getCatalogItems(catalog: PromptMentionCatalog): CatalogItem[] {
  return [
    ...catalog.env.map((item) => ({ ...item, kind: 'env' as const })),
    ...catalog.tools.map((item) => ({ ...item, kind: 'tool' as const })),
    ...catalog.connectors.map((item) => ({ ...item, kind: 'connector' as const })),
    ...catalog.skills.map((item) => ({ ...item, kind: 'skill' as const })),
    ...catalog.openapiSpecs.map((item) => ({ ...item, kind: 'openapi' as const })),
    ...catalog.toolsets.map((item) => ({ ...item, kind: 'toolset' as const })),
  ]
}

function getCaretCoordinates(
  textarea: HTMLTextAreaElement,
  selectionStart: number,
): { top: number; left: number } {
  const div = document.createElement('div')
  const style = getComputedStyle(textarea)
  const properties = [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'letterSpacing',
    'lineHeight',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'boxSizing',
    'whiteSpace',
    'wordWrap',
  ] as const

  properties.forEach((prop) => {
    div.style.setProperty(prop, style.getPropertyValue(prop))
  })

  div.style.position = 'absolute'
  div.style.visibility = 'hidden'
  div.style.overflow = 'auto'
  div.textContent = textarea.value.substring(0, selectionStart)
  const span = document.createElement('span')
  span.textContent = textarea.value.substring(selectionStart) || '.'
  div.appendChild(span)

  document.body.appendChild(div)
  const { offsetTop, offsetLeft } = span
  const { top, left } = textarea.getBoundingClientRect()
  document.body.removeChild(div)

  return {
    top: top + offsetTop + parseFloat(style.lineHeight),
    left: left + offsetLeft,
  }
}

export function usePromptMentionPicker({
  textareaRef,
  value,
  onChange,
  catalog,
  disabled,
}: UseMentionPickerOptions) {
  const [state, setState] = useState<MentionPickerState>({
    open: false,
    query: '',
    position: { top: 0, left: 0 },
  })
  const lastAtIndexRef = useRef<number | null>(null)

  const allItems = useMemo(() => getCatalogItems(catalog), [catalog])

  const filteredItems = useMemo(() => {
    const query = state.query.toLowerCase()
    if (!query) return allItems
    return allItems.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        (item.description?.toLowerCase().includes(query) ?? false),
    )
  }, [allItems, state.query])

  const groupedItems = useMemo(() => {
    const groups: Record<string, CatalogItem[]> = {}
    for (const item of filteredItems) {
      const category = item.category ?? item.kind
      if (!groups[category]) groups[category] = []
      groups[category].push(item)
    }
    return groups
  }, [filteredItems])

  const close = useCallback(() => {
    setState((current) => ({ ...current, open: false, query: '' }))
    lastAtIndexRef.current = null
  }, [])

  const insertMention = useCallback(
    (item: CatalogItem) => {
      const textarea = textareaRef.current
      if (!textarea || lastAtIndexRef.current === null) return

      const start = lastAtIndexRef.current
      const end = textarea.selectionStart
      const prefix = TOKEN_PREFIXES[item.kind]
      const before = value.slice(0, start)
      const after = value.slice(end)
      const nextValue = `${before}${prefix}${item.name} ${after}`

      onChange(nextValue)
      close()

      requestAnimationFrame(() => {
        const caret = start + prefix.length + item.name.length + 1
        textarea.focus()
        textarea.setSelectionRange(caret, caret)
      })
    },
    [textareaRef, value, onChange, close],
  )

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea || disabled) return

    const handleInput = (event: Event) => {
      if (event instanceof InputEvent && event.isComposing) return

      const start = textarea.selectionStart
      const text = textarea.value
      const beforeCursor = text.slice(0, start)
      const lastAt = beforeCursor.lastIndexOf('@')

      if (lastAt === -1) {
        close()
        return
      }

      const afterAt = beforeCursor.slice(lastAt + 1)
      const isAtWordBoundary = lastAt === 0 || /\s/.test(beforeCursor.charAt(lastAt - 1))
      const hasSpaceInQuery = /\s/.test(afterAt)

      if (!isAtWordBoundary || hasSpaceInQuery) {
        close()
        return
      }

      lastAtIndexRef.current = lastAt
      const coords = getCaretCoordinates(textarea, lastAt)
      setState({
        open: true,
        query: afterAt,
        position: coords,
      })
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!state.open) return
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }

    textarea.addEventListener('input', handleInput)
    textarea.addEventListener('keydown', handleKeyDown)
    textarea.addEventListener('click', close)

    return () => {
      textarea.removeEventListener('input', handleInput)
      textarea.removeEventListener('keydown', handleKeyDown)
      textarea.removeEventListener('click', close)
    }
  }, [textareaRef, disabled, state.open, close])

  return {
    open: state.open,
    query: state.query,
    position: state.position,
    groupedItems,
    filteredItems,
    insertMention,
    close,
  }
}

interface PromptMentionPickerProps {
  open: boolean
  query: string
  position: { top: number; left: number }
  groupedItems: Record<string, CatalogItem[]>
  onSelect: (item: CatalogItem) => void
}

const CATEGORY_LABELS: Record<string, string> = {
  env: 'Environment Variables',
  tool: 'Tools',
  connector: 'Connectors',
  skill: 'Agent Skills',
  openapi: 'OpenAPI Specs',
  toolset: 'Toolsets',
}

export function PromptMentionPicker({
  open,
  query,
  position,
  groupedItems,
  onSelect,
}: PromptMentionPickerProps) {
  if (!open) return null

  const categories = Object.keys(groupedItems)

  return (
    <div
      className="fixed z-[100] w-80"
      style={{
        top: position.top,
        left: position.left,
      }}
    >
      <Command
        className={cn(
          'overflow-hidden rounded-2xl border border-white/[0.08]',
          'bg-[#11111d]/98 text-white shadow-[0_28px_120px_-48px_rgba(0,0,0,0.95)] backdrop-blur-2xl',
        )}
      >
        <CommandInput
          placeholder="Search context mentions..."
          value={query}
          readOnly
          tabIndex={-1}
          className="h-10 border-0 bg-transparent text-sm text-white placeholder:text-white/30"
        />
        <CommandList className="max-h-80">
          {categories.length === 0 && <CommandEmpty className="text-white/50">No matches</CommandEmpty>}
          {categories.map((category) => (
            <CommandGroup
              key={category}
              heading={CATEGORY_LABELS[category] ?? category}
              className="text-white/40 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.2em]"
            >
              {groupedItems[category]?.map((item) => (
                <CommandItem
                  key={`${item.kind}:${item.name}`}
                  value={`${item.kind}:${item.name}`}
                  onSelect={() => onSelect(item)}
                  className="px-3 py-2.5 text-sm text-white/82 data-selected:bg-white/[0.08] data-selected:text-white"
                >
                  <span className="truncate">{item.name}</span>
                  {item.description ? (
                    <span className="ml-2 truncate text-xs text-white/40">{item.description}</span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </div>
  )
}
