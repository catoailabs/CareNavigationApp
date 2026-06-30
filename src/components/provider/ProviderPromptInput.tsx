import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowUpIcon,
  DocumentTextIcon,
  GlobeAltIcon,
  PaperClipIcon,
  PhotoIcon,
  StopCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Attachment,
  Attachments,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
} from '@/components/ai-elements/attachments'
import { TabAttachments } from '@/components/ai-elements/TabAttachment'
import { SurfaceCard } from './ProviderUi'
import { isBrowserExtensionBridgeAvailable } from '@/services/browserExtensionBridge'
import { isCDPAvailable, loadRealTabs } from '@/services/tabService'
import { fileToDataUrl, makePastedTextFilename } from '@/utils/file-utils'
import { cn } from '@/utils/cn'
import type {
  ProviderComposerFile,
  ProviderComposerSubmitPayload,
  ProviderTabAttachment,
} from './providerChatTypes'
import {
  PromptMentionPicker,
  usePromptMentionPicker,
  type PromptMentionCatalog,
} from './PromptMentionPicker'
import { usePromptMentions } from './usePromptMentions'

const EASE = [0.16, 1, 0.3, 1] as const
const PASTE_TO_ATTACHMENT_THRESHOLD = 200

const ATTACHMENT_BUTTON_CLASS =
  'group flex h-12 w-12 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.04] text-white/68 transition-all duration-200 hover:border-indigo-300/30 hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-50'

const SEND_BUTTON_CLASS =
  'flex h-14 w-14 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#6366F1,#4C1D95)] text-white shadow-[0_22px_60px_-28px_rgba(99,102,241,0.9)] transition-all duration-200'

function createLocalId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

async function toComposerFiles(files: FileList | null): Promise<ProviderComposerFile[]> {
  const nextFiles = Array.from(files ?? [])
  return Promise.all(
    nextFiles.map(async (file) => ({
      id: createLocalId(),
      filename: file.name,
      mediaType: file.type || 'application/octet-stream',
      type: 'file' as const,
      url: await fileToDataUrl(file),
    })),
  )
}

function normalizeTab(tab: ProviderTabAttachment): ProviderTabAttachment {
  return {
    id: tab.id,
    type: 'tab',
    name: tab.name,
    description: tab.description,
    favicon: tab.favicon,
    url: tab.url,
    title: tab.title,
    screenshotUrl: tab.screenshotUrl,
    pageContent: tab.pageContent,
    navigationInfo: tab.navigationInfo,
  }
}

function formatTabContext(tab: ProviderTabAttachment): string {
  const label = tab.title || tab.name || 'Untitled tab'
  const sections = [`Tab: ${label}`]

  if (tab.url) {
    sections.push(`URL: ${tab.url}`)
  }

  if (tab.description && tab.description !== tab.url) {
    sections.push(`Description: ${tab.description}`)
  }

  if (tab.navigationInfo?.canonical) {
    sections.push(`Canonical URL: ${tab.navigationInfo.canonical}`)
  }

  if (tab.navigationInfo?.referrer) {
    sections.push(`Referrer: ${tab.navigationInfo.referrer}`)
  }

  if (tab.navigationInfo?.links?.length) {
    sections.push(`Links on page:\n${tab.navigationInfo.links.map((link) => `- ${link}`).join('\n')}`)
  }

  if (tab.pageContent?.trim()) {
    sections.push(`Visible page text:\n${tab.pageContent.trim()}`)
  }

  return sections.join('\n')
}

function buildPromptText(
  displayText: string,
  files: ProviderComposerFile[],
  tabAttachments: ProviderTabAttachment[],
) {
  const trimmedDisplayText = displayText.trim()
  const sections: string[] = []

  if (tabAttachments.length > 0) {
    sections.push(
      [
        'Selected browser tab context:',
        ...tabAttachments.map((tab, index) => `--- Tab ${index + 1} ---\n${formatTabContext(tab)}`),
      ].join('\n'),
    )
  }

  if (files.length > 0) {
    sections.push(
      [
        'Attached files:',
        ...files.map((file) => {
          const label = file.filename || 'Attachment'
          return file.mediaType ? `- ${label} [${file.mediaType}]` : `- ${label}`
        }),
      ].join('\n'),
    )
  }

  if (sections.length === 0) {
    return trimmedDisplayText
  }

  const requestText = trimmedDisplayText || 'Please use the attached context and continue.'
  return `${sections.join('\n\n')}\n\nUser request:\n${requestText}`
}

interface ProviderPromptInputProps {
  isCentered?: boolean
  isStreaming: boolean
  onStop: () => void
  onSubmit: (payload: ProviderComposerSubmitPayload) => void
}

export function ProviderPromptInput({
  isCentered = false,
  isStreaming,
  onStop,
  onSubmit,
}: ProviderPromptInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [selectedTabs, setSelectedTabs] = useState<ProviderTabAttachment[]>([])
  const [files, setFiles] = useState<ProviderComposerFile[]>([])
  const [tabs, setTabs] = useState<ProviderTabAttachment[]>([])
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isTabMenuOpen, setIsTabMenuOpen] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const [isLoadingTabs, setIsLoadingTabs] = useState(false)
  const [tabLoadError, setTabLoadError] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<PromptMentionCatalog>({
    env: [],
    tools: [],
    connectors: [],
    skills: [],
    openapiSpecs: [],
    toolsets: [],
  })

  const { extractMentions } = usePromptMentions()

  const mentionPicker = usePromptMentionPicker({
    textareaRef,
    value,
    onChange: setValue,
    catalog,
    disabled: isStreaming,
  })

  useEffect(() => {
    let active = true
    fetch('/api/catalog')
      .then(async (response) => {
        if (!response.ok) return
        const data = (await response.json()) as {
          tools?: Array<{ id?: string; label?: string; tools?: Array<{ name?: string; description?: string }> }>
          connectors?: Array<{ id?: string; label?: string; mcp_servers?: Array<{ name?: string; description?: string }> }>
          skills?: Array<{ name?: string; description?: string }>
          openapiSpecs?: Array<{ id?: string; label?: string; openapi_specs?: Array<{ name?: string; description?: string }> }>
          toolsets?: Array<{ name?: string; description?: string }>
        }
        if (!active) return
        setCatalog({
          env: [],
          tools:
            data.tools?.flatMap((category) =>
              (category.tools ?? []).map((tool) => ({
                id: `tool:${tool.name ?? ''}`,
                name: tool.name ?? '',
                description: tool.description,
                kind: 'tool' as const,
                category: 'tool',
              })),
            ) ?? [],
          connectors:
            data.connectors?.flatMap((category) =>
              (category.mcp_servers ?? []).map((server) => ({
                id: `connector:${server.name ?? ''}`,
                name: server.name ?? '',
                description: server.description,
                kind: 'connector' as const,
                category: 'connector',
              })),
            ) ?? [],
          skills:
            data.skills?.map((skill) => ({
              id: `skill:${skill.name ?? ''}`,
              name: skill.name ?? '',
              description: skill.description,
              kind: 'skill' as const,
              category: 'skill',
            })) ?? [],
          openapiSpecs:
            data.openapiSpecs?.flatMap((category) =>
              (category.openapi_specs ?? []).map((spec) => ({
                id: `openapi:${spec.name ?? ''}`,
                name: spec.name ?? '',
                description: spec.description,
                kind: 'openapi' as const,
                category: 'openapi',
              })),
            ) ?? [],
          toolsets:
            data.toolsets?.map((toolset) => ({
              id: `toolset:${toolset.name ?? ''}`,
              name: toolset.name ?? '',
              description: toolset.description,
              kind: 'toolset' as const,
              category: 'toolset',
            })) ?? [],
        })
      })
      .catch(() => {
        // Catalog is optional for the picker; leave empty on failure.
      })

    const handleEnvUpdate = () => {
      void fetch('/api/settings/environment')
        .then(async (response) => {
          if (!response.ok) return
          const data = (await response.json()) as {
            variables?: Array<{ name?: string; value?: string; protected?: boolean }>
          }
          if (!active) return
          setCatalog((current) => ({
            ...current,
            env:
              data.variables?.map((variable) => ({
                id: `env:${variable.name ?? ''}`,
                name: variable.name ?? '',
                description: variable.protected ? 'Protected' : undefined,
                kind: 'env' as const,
                category: 'env',
              })) ?? [],
          }))
        })
        .catch(() => {})
    }

    handleEnvUpdate()

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, isCentered ? 280 : 220)}px`
  }, [value, isCentered])

  useEffect(() => {
    if (isStreaming) return
    textareaRef.current?.focus()
  }, [isCentered, isStreaming])

  useEffect(() => {
    if (!isTabMenuOpen) return
    let isActive = true

    loadRealTabs()
      .then(async (loadedTabs) => {
        if (!isActive) return
        const liveTabs = loadedTabs
          .filter((tab) => tab.type === 'tab')
          .map((tab) => normalizeTab(tab))
        setTabs(liveTabs)
        if (liveTabs.length === 0) {
          const [extensionAvailable, cdpAvailable] = await Promise.all([
            isBrowserExtensionBridgeAvailable(),
            isCDPAvailable(),
          ])
          if (!isActive || extensionAvailable || cdpAvailable) return
          setTabLoadError('Install Chromium with "brew install --cask chromium" and rerun "npm run dev", or load browser-extension/provider-tab-bridge as an unpacked Chrome extension.')
        }
      })
      .catch(() => {
        if (!isActive) return
        setTabs([])
        setTabLoadError('Unable to load live tabs right now.')
      })
      .finally(() => {
        if (isActive) {
          setIsLoadingTabs(false)
        }
      })

    return () => {
      isActive = false
    }
  }, [isTabMenuOpen])

  const hasContent = value.trim().length > 0 || files.length > 0 || selectedTabs.length > 0
  const totalAttachments = files.length + selectedTabs.length

  const imageFiles = useMemo(
    () => files.filter((file) => file.mediaType.startsWith('image/')),
    [files],
  )

  const documentFiles = useMemo(
    () => files.filter((file) => !file.mediaType.startsWith('image/')),
    [files],
  )

  const removeFile = (id: string) => {
    setFiles((current) => current.filter((file) => file.id !== id))
  }

  const toggleTab = (tab: ProviderTabAttachment, checked: boolean) => {
    setSelectedTabs((current) => {
      if (checked) {
        if (current.some((item) => item.id === tab.id)) {
          return current
        }
        return [...current, tab]
      }

      return current.filter((item) => item.id !== tab.id)
    })
  }

  const selectAllTabs = () => {
    setSelectedTabs(tabs.map((tab) => normalizeTab(tab)))
  }

  const clearSelectedTabs = () => {
    setSelectedTabs([])
  }

  const handleInputFiles = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const nextFiles = await toComposerFiles(event.target.files)
    if (nextFiles.length > 0) {
      setFiles((current) => [...current, ...nextFiles])
    }
    event.target.value = ''
    textareaRef.current?.focus()
  }

  const handlePaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Pasted files (images, documents) take precedence and are attached directly.
    const pastedFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => Boolean(f))

    if (pastedFiles.length > 0) {
      event.preventDefault()
      const composerFiles = await Promise.all(
        pastedFiles.map(async (file) => ({
          id: createLocalId(),
          filename: file.name,
          mediaType: file.type || 'application/octet-stream',
          type: 'file' as const,
          url: await fileToDataUrl(file),
        })),
      )
      setFiles((current) => [...current, ...composerFiles])
      return
    }

    // Large text pastes become a text/plain attachment rendered inline.
    const text = event.clipboardData.getData('text/plain')
    if (text && text.length > PASTE_TO_ATTACHMENT_THRESHOLD) {
      event.preventDefault()
      const file = new File([text], makePastedTextFilename(), { type: 'text/plain' })
      const url = await fileToDataUrl(file)
      setFiles((current) => [
        ...current,
        {
          id: createLocalId(),
          filename: file.name,
          mediaType: 'text/plain',
          type: 'file' as const,
          url,
        },
      ])
    }
  }

  const submit = () => {
    if (!hasContent || isStreaming) return

    const normalizedTabs = selectedTabs.map(normalizeTab)
    const displayText = value.trim()
    onSubmit({
      displayText,
      files,
      promptText: buildPromptText(value, files, normalizedTabs),
      tabAttachments: normalizedTabs,
      mentions: extractMentions(displayText),
    })

    setValue('')
    setFiles([])
    setSelectedTabs([])
  }

  return (
    <motion.div
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: EASE }}
      className="w-full"
    >
      {isCentered ? (
        <div className="mb-8 text-center">
          <div className="text-[11px] uppercase tracking-[0.28em] text-white/35">Provider research</div>
          <h3 className="mt-4 text-3xl font-light tracking-[-0.03em] text-white md:text-[2.6rem]">
            Search, compare, and brief with real context.
          </h3>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-white/58 md:text-[15px]">
            Start with a question, then enrich it with files, photos, or live tab context before you send.
          </p>
        </div>
      ) : null}

      <div className="relative">
        <PromptMentionPicker
          open={mentionPicker.open}
          query={mentionPicker.query}
          position={mentionPicker.position}
          groupedItems={mentionPicker.groupedItems}
          onSelect={mentionPicker.insertMention}
        />
        <div
          className={cn(
            'absolute -inset-4 rounded-[36px] transition-all duration-500',
            'bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.18)_0%,rgba(76,29,149,0.12)_42%,transparent_72%)]',
            isFocused || isCentered ? 'opacity-100' : 'opacity-70',
          )}
        />

        <div
          className={cn(
            'absolute -inset-[1px] rounded-[32px] bg-gradient-to-br from-[#818CF8]/35 via-transparent to-[#4C1D95]/35 transition-opacity duration-300',
            isFocused ? 'opacity-100' : 'opacity-60',
          )}
        />

        <SurfaceCard className="relative overflow-hidden rounded-[32px] border-white/[0.09] bg-[linear-gradient(180deg,rgba(16,16,28,0.97)_0%,rgba(9,9,18,0.96)_100%)]">
          <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(129,140,248,0.08),transparent_38%,rgba(76,29,149,0.12))]" />

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleInputFiles}
          />
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleInputFiles}
          />

          <div className="relative">
            <AnimatePresence initial={false}>
              {(selectedTabs.length > 0 || files.length > 0) && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2 }}
                  className="border-b border-white/[0.06] px-5 pt-5"
                >
                  {selectedTabs.length > 0 ? (
                    <TabAttachments
                      tabs={selectedTabs}
                      onRemove={(tabId) =>
                        setSelectedTabs((current) => current.filter((tab) => tab.id !== tabId))
                      }
                      showPreview
                      className="mb-3"
                    />
                  ) : null}

                  {imageFiles.length > 0 ? (
                    <Attachments variant="grid" className="mb-3 ml-0">
                      {imageFiles.map((file) => (
                        <Attachment
                          key={file.id}
                          data={file}
                          onRemove={() => removeFile(file.id)}
                          className="size-24 rounded-2xl border border-white/[0.08] bg-white/[0.04]"
                        >
                          <AttachmentPreview />
                          <AttachmentRemove className="bg-black/55 text-white hover:bg-black/80" />
                        </Attachment>
                      ))}
                    </Attachments>
                  ) : null}

                  {documentFiles.length > 0 ? (
                    <Attachments variant="inline" className="mb-4">
                      {documentFiles.map((file) => (
                        <Attachment
                          key={file.id}
                          data={file}
                          onRemove={() => removeFile(file.id)}
                          className="h-10 rounded-xl border border-white/[0.08] bg-white/[0.04] px-2.5 text-white/72 hover:bg-white/[0.08] hover:text-white"
                        >
                          <AttachmentPreview className="size-6 rounded-md bg-white/[0.08]" />
                          <AttachmentInfo className="text-xs" />
                          <AttachmentRemove className="size-6 rounded-lg text-white/58 hover:bg-white/[0.08] hover:text-white" />
                        </Attachment>
                      ))}
                    </Attachments>
                  ) : null}
                </motion.div>
              )}
            </AnimatePresence>

            <div className={cn('px-5', isCentered ? 'pt-6' : 'pt-5')}>
              <textarea
                ref={textareaRef}
                rows={isCentered ? 3 : 2}
                value={value}
                disabled={isStreaming}
                onChange={(event) => setValue(event.target.value)}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    if (isStreaming) {
                      onStop()
                    } else {
                      submit()
                    }
                  }
                }}
                onPaste={handlePaste}
                placeholder="Search for a provider, compare candidates, or attach context to shape the next answer..."
                className={cn(
                  'w-full resize-none bg-transparent text-white placeholder:text-white/26 focus:outline-none',
                  'min-h-[104px] text-[15px] leading-7 md:text-base',
                  isCentered ? 'max-h-[280px]' : 'max-h-[220px]',
                )}
              />
            </div>

            <div className="relative flex items-center justify-between gap-4 border-t border-white/[0.06] px-5 py-4">
              <div className="flex items-center gap-3">
                <DropdownMenu
                  open={isMenuOpen}
                  onOpenChange={(open) => {
                    setIsMenuOpen(open)
                    if (!open) {
                      setIsTabMenuOpen(false)
                      setIsLoadingTabs(false)
                    }
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      disabled={isStreaming}
                      aria-label="Add attachments"
                      className={ATTACHMENT_BUTTON_CLASS}
                    >
                      <PaperClipIcon className="h-5 w-5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    side="top"
                    sideOffset={12}
                    className="w-72 rounded-2xl border border-white/[0.08] bg-[#11111d]/96 p-1.5 text-white shadow-[0_28px_120px_-48px_rgba(0,0,0,0.95)] backdrop-blur-2xl"
                  >
                    <DropdownMenuLabel className="px-3 pb-1 pt-2 text-[11px] uppercase tracking-[0.24em] text-white/38">
                      Add context
                    </DropdownMenuLabel>
                    <DropdownMenuItem
                      className="rounded-xl px-3 py-3 text-white/82 focus:bg-white/[0.08] focus:text-white"
                      onSelect={(event) => {
                        event.preventDefault()
                        fileInputRef.current?.click()
                      }}
                    >
                      <DocumentTextIcon className="h-4 w-4" />
                      Files
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="rounded-xl px-3 py-3 text-white/82 focus:bg-white/[0.08] focus:text-white"
                      onSelect={(event) => {
                        event.preventDefault()
                        photoInputRef.current?.click()
                      }}
                    >
                      <PhotoIcon className="h-4 w-4" />
                      Photos
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className="bg-white/[0.06]" />
                    <DropdownMenuSub
                      open={isTabMenuOpen}
                      onOpenChange={(open) => {
                        setIsTabMenuOpen(open)
                        if (open) {
                          setIsLoadingTabs(true)
                          setTabLoadError(null)
                        } else {
                          setIsLoadingTabs(false)
                        }
                      }}
                    >
                      <DropdownMenuSubTrigger className="rounded-xl px-3 py-3 text-white/82 focus:bg-white/[0.08] focus:text-white data-open:bg-white/[0.08]">
                        <GlobeAltIcon className="h-4 w-4" />
                        Tab context
                        {tabs.length > 0 ? (
                          <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[10px] text-white/50">
                            {tabs.length}
                          </span>
                        ) : null}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent
                        sideOffset={10}
                        collisionPadding={16}
                        className="max-h-[min(28rem,var(--radix-dropdown-menu-content-available-height))] w-96 overflow-y-auto rounded-2xl border border-white/[0.08] bg-[#11111d]/96 p-1.5 text-white shadow-[0_28px_120px_-48px_rgba(0,0,0,0.95)] backdrop-blur-2xl"
                      >
                        <DropdownMenuLabel className="px-3 pb-1 pt-2 text-[11px] uppercase tracking-[0.24em] text-white/38">
                          Open tabs
                        </DropdownMenuLabel>
                        {isLoadingTabs ? (
                          <DropdownMenuItem
                            disabled
                            className="rounded-xl px-3 py-3 text-white/42"
                          >
                            Loading browser tabs…
                          </DropdownMenuItem>
                        ) : tabLoadError ? (
                          <DropdownMenuItem
                            disabled
                            className="rounded-xl px-3 py-3 text-white/42"
                          >
                            {tabLoadError}
                          </DropdownMenuItem>
                        ) : tabs.length === 0 ? (
                          <DropdownMenuItem
                            disabled
                            className="rounded-xl px-3 py-3 text-white/42"
                          >
                            No live tabs detected
                          </DropdownMenuItem>
                        ) : (
                          <>
                            <div className="px-3 pb-2 text-xs text-white/45">
                              Select any combination of the currently open tabs. Every selected tab sends its full extracted page text plus navigation metadata.
                            </div>
                            <div className="flex items-center gap-2 px-2 pb-2">
                              <button
                                type="button"
                                onClick={selectAllTabs}
                                className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-white/72 transition-colors hover:bg-white/[0.08] hover:text-white"
                              >
                                Select all
                              </button>
                              <button
                                type="button"
                                onClick={clearSelectedTabs}
                                className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-white/72 transition-colors hover:bg-white/[0.08] hover:text-white"
                              >
                                Clear
                              </button>
                              <span className="ml-auto text-[11px] text-white/42">
                                {selectedTabs.length}/{tabs.length} selected
                              </span>
                            </div>
                            {tabs.map((tab) => (
                              <DropdownMenuCheckboxItem
                                key={tab.id}
                                checked={selectedTabs.some((item) => item.id === tab.id)}
                                className="rounded-xl px-3 py-3 text-white/82 focus:bg-white/[0.08] focus:text-white"
                                onSelect={(event) => event.preventDefault()}
                                onCheckedChange={(checked) => toggleTab(tab, checked === true)}
                              >
                                <div className="min-w-0">
                                  <div className="truncate text-sm text-white">
                                    {tab.title || tab.name}
                                  </div>
                                  {tab.url ? (
                                    <div className="truncate text-xs text-white/45">
                                      {tab.url}
                                    </div>
                                  ) : null}
                                  <div className="mt-1 text-[11px] text-white/35">
                                    {tab.pageContent?.trim()
                                      ? `${tab.pageContent.trim().length.toLocaleString()} characters of page context ready`
                                      : 'No page text extracted'}
                                  </div>
                                </div>
                              </DropdownMenuCheckboxItem>
                            ))}
                          </>
                        )}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </DropdownMenuContent>
                </DropdownMenu>

                <div className="hidden text-xs text-white/42 sm:block">
                  {totalAttachments > 0
                    ? `${totalAttachments} item${totalAttachments === 1 ? '' : 's'} attached`
                    : 'Attach files, photos, or a live tab before you send'}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="hidden text-[10px] font-light text-white/32 md:block">
                  <span className="rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[9px] text-white/42">
                    Enter
                  </span>
                  <span className="ml-1">to send</span>
                  <span className="mx-1.5">·</span>
                  <span className="rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[9px] text-white/42">
                    Shift+Enter
                  </span>
                  <span className="ml-1">for a new line</span>
                </div>

                <motion.button
                  type="button"
                  onClick={isStreaming ? onStop : submit}
                  disabled={!isStreaming && !hasContent}
                  whileHover={{ scale: isStreaming || hasContent ? 1.03 : 1 }}
                  whileTap={{ scale: isStreaming || hasContent ? 0.97 : 1 }}
                  className={cn(
                    SEND_BUTTON_CLASS,
                    isStreaming
                      ? 'border border-rose-300/20 bg-rose-400/12 text-rose-100 shadow-none'
                      : hasContent
                        ? 'opacity-100'
                        : 'cursor-not-allowed opacity-35',
                  )}
                >
                  {isStreaming ? (
                    <StopCircleIcon className="h-5 w-5" />
                  ) : (
                    <ArrowUpIcon className="h-5 w-5" />
                  )}
                </motion.button>
              </div>
            </div>
          </div>
        </SurfaceCard>

        {!isCentered && hasContent ? (
          <button
            type="button"
            onClick={() => {
              setValue('')
              setFiles([])
              setSelectedTabs([])
            }}
            className="absolute right-6 top-6 flex items-center gap-1 rounded-full px-2 py-1 text-[11px] text-white/32 transition-colors hover:bg-white/[0.05] hover:text-white/55"
          >
            <XMarkIcon className="h-3.5 w-3.5" />
            Clear
          </button>
        ) : null}
      </div>
    </motion.div>
  )
}
