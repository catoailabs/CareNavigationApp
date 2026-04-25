/**
 * Strands tool renderer registry.
 *
 * Maps each Strands `@tool`-decorated function name (as emitted by the Python
 * agent over the AI SDK v6 UI message stream) to a pure renderer that uses
 * canonical Vercel AI Elements components.
 *
 * The Python agent emits all baseline tools with `dynamic: True`, so every
 * part this registry sees will be a `DynamicToolUIPart` (`type === 'dynamic-tool'`).
 * We still type the input as `ToolUIPart | DynamicToolUIPart` so the registry
 * keeps working if any tool is later promoted to a static UI tool.
 *
 * Renderers are PURE functions: no hooks, no side effects, no state. Callers
 * may invoke them inside `messages.flatMap(m => m.parts.map(...))` without
 * conditional-hook concerns.
 */

import { getToolName, type DynamicToolUIPart, type ToolUIPart } from 'ai'
import type { ReactNode } from 'react'

import {
  Artifact,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
} from '@/components/ai-elements/artifact'
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from '@/components/ai-elements/sources'
import {
  Task,
  TaskContent,
  TaskItem,
  TaskTrigger,
} from '@/components/ai-elements/task'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ToolPart = ToolUIPart | DynamicToolUIPart

export interface ToolRenderContext {
  /** True while the underlying message is still streaming from the agent. */
  isStreaming: boolean
  /** The owning message id (used to derive stable React keys). */
  messageId: string
  /** Index of this part inside the message (used for React keys). */
  index: number
}

export type ToolRenderer = (part: ToolPart, ctx: ToolRenderContext) => ReactNode

// ---------------------------------------------------------------------------
// Internal helpers (no hooks; pure)
// ---------------------------------------------------------------------------

type SourceLink = { url: string; title?: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Best-effort extraction of `{url, title}` pairs from any tool output shape.
 *
 * Grounded in the actual Python tool return shapes:
 * - `perplexity_search_api` exposes citations under `results[].results[].url`
 *   plus a flat `__ui_data__.data.results[].url` and a `source_domains` list.
 * - `perplexity_deep_research` (COMPLETED) exposes `citations[]` where each
 *   element is either a string URL or `{url, title?}`.
 * - `npiLookup` returns no citations; the helper safely yields `[]`.
 */
function extractSources(output: unknown): SourceLink[] {
  if (!isPlainObject(output)) return []

  const seen = new Set<string>()
  const out: SourceLink[] = []
  const push = (url: unknown, title?: unknown): void => {
    const u = asString(url)
    if (!u || seen.has(u)) return
    seen.add(u)
    out.push({ url: u, title: asString(title) })
  }

  // perplexity_deep_research → COMPLETED payload
  const citations = output['citations']
  if (Array.isArray(citations)) {
    for (const c of citations) {
      if (typeof c === 'string') push(c)
      else if (isPlainObject(c)) push(c['url'], c['title'])
    }
  }

  // perplexity_search_api → top-level normalized __ui_data__
  const uiData = output['__ui_data__']
  if (isPlainObject(uiData)) {
    const data = uiData['data']
    if (isPlainObject(data) && Array.isArray(data['results'])) {
      for (const r of data['results']) {
        if (isPlainObject(r)) push(r['url'], r['title'])
      }
    }
  }

  // perplexity_search_api → per-query results envelope
  const results = output['results']
  if (Array.isArray(results)) {
    for (const group of results) {
      if (!isPlainObject(group)) continue
      const groupResults = group['results']
      if (!Array.isArray(groupResults)) continue
      for (const r of groupResults) {
        if (isPlainObject(r)) push(r['url'], r['title'])
      }
    }
  }

  // perplexity_search_api → flat_results when include_raw_results=true
  const flat = output['flat_results']
  if (Array.isArray(flat)) {
    for (const r of flat) {
      if (isPlainObject(r)) push(r['url'], r['title'])
    }
  }

  return out
}

/**
 * Render a `<Sources>` collapsible if and only if there are extracted links.
 * Returns `null` otherwise so callers can `<>{primary}{maybeSources}</>`.
 */
function renderSourcesBlock(output: unknown, keyPrefix: string): ReactNode {
  const links = extractSources(output)
  if (links.length === 0) return null
  return (
    <Sources>
      <SourcesTrigger count={links.length} />
      <SourcesContent>
        {links.map((link, idx) => (
          <Source
            key={`${keyPrefix}-source-${idx}`}
            href={link.url}
            title={link.title ?? link.url}
          />
        ))}
      </SourcesContent>
    </Sources>
  )
}

/**
 * Build the discriminated props expected by `<ToolHeader>`. The component
 * accepts either a static `tool-<name>` part or a `dynamic-tool` part with an
 * explicit `toolName`; we forward the right shape based on the runtime type.
 */
function toolHeader(part: ToolPart, title?: string): ReactNode {
  if (part.type === 'dynamic-tool') {
    return (
      <ToolHeader
        title={title}
        type="dynamic-tool"
        state={part.state}
        toolName={part.toolName}
      />
    )
  }
  return <ToolHeader title={title} type={part.type} state={part.state} />
}

/**
 * Pull `output` and `errorText` off the part safely. The AI SDK union only
 * defines `output` on `output-available` and `errorText` on `output-error`,
 * so we narrow at the call site instead of trusting field presence.
 */
function partOutput(part: ToolPart): ToolPart['output'] {
  return part.state === 'output-available' ? part.output : undefined
}

function partErrorText(part: ToolPart): ToolPart['errorText'] {
  return part.state === 'output-error' ? part.errorText : undefined
}

// ---------------------------------------------------------------------------
// Per-tool renderers
// ---------------------------------------------------------------------------

const renderNpiLookup: ToolRenderer = (part, { messageId, index }) => {
  // npiLookup → CMS NPPES record(s); never has citations. Canonical <Tool>.
  const keyPrefix = `${messageId}-${index}-npi`
  return (
    <Tool key={keyPrefix} defaultOpen={part.state !== 'output-available'}>
      {toolHeader(part, 'NPI Registry Lookup')}
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput
          output={partOutput(part)}
          errorText={partErrorText(part)}
        />
      </ToolContent>
    </Tool>
  )
}

const renderPerplexitySearch: ToolRenderer = (part, { messageId, index }) => {
  // perplexity_search_api → call envelope + extracted citation sources.
  const keyPrefix = `${messageId}-${index}-pplx-search`
  const output = partOutput(part)
  return (
    <div key={keyPrefix} className="space-y-2">
      <Tool defaultOpen={part.state !== 'output-available'}>
        {toolHeader(part, 'Perplexity Search')}
        <ToolContent>
          <ToolInput input={part.input} />
          <ToolOutput
            output={output}
            errorText={partErrorText(part)}
          />
        </ToolContent>
      </Tool>
      {renderSourcesBlock(output, keyPrefix)}
    </div>
  )
}

const renderPerplexityDeepResearch: ToolRenderer = (
  part,
  { messageId, index },
) => {
  // perplexity_deep_research lifecycle:
  //   - input-streaming / input-available / approval-* → <Task> "in progress"
  //   - output-available with status === "COMPLETED" → <Artifact> + <Sources>
  //   - output-available with non-COMPLETED status (POLLING/PROCESSING/...) →
  //     <Task> reflecting the latest server status (start action returns
  //     immediately with a request_id and a non-COMPLETED status).
  //   - output-error → canonical <Tool> with error surface.
  const keyPrefix = `${messageId}-${index}-pplx-deep`
  const output = partOutput(part)
  const errorText = partErrorText(part)

  if (errorText) {
    return (
      <Tool key={keyPrefix} defaultOpen>
        {toolHeader(part, 'Perplexity Deep Research')}
        <ToolContent>
          <ToolInput input={part.input} />
          <ToolOutput output={undefined} errorText={errorText} />
        </ToolContent>
      </Tool>
    )
  }

  const outputObj = isPlainObject(output) ? output : undefined
  const status = asString(outputObj?.['status'])
  const topic =
    asString(outputObj?.['topic']) ??
    (isPlainObject(part.input) ? asString(part.input['topic']) : undefined) ??
    'Deep research'
  const requestId = asString(outputObj?.['request_id'])
  const report = asString(outputObj?.['report'])
  const isCompleted = status === 'COMPLETED' && report !== undefined

  if (isCompleted) {
    const description = requestId
      ? `Request ${requestId} · status ${status}`
      : `Status ${status}`
    return (
      <div key={keyPrefix} className="space-y-2">
        <Artifact>
          <ArtifactHeader>
            <div className="flex flex-col">
              <ArtifactTitle>{topic}</ArtifactTitle>
              <ArtifactDescription>{description}</ArtifactDescription>
            </div>
          </ArtifactHeader>
          <ArtifactContent>
            <pre className="whitespace-pre-wrap text-sm leading-relaxed">
              {report}
            </pre>
          </ArtifactContent>
        </Artifact>
        {renderSourcesBlock(output, keyPrefix)}
      </div>
    )
  }

  // Still in progress (start returned, polling, processing, awaiting input,
  // or output-available but status !== COMPLETED yet).
  const inProgressStatus = status ?? (
    part.state === 'input-streaming'
      ? 'STREAMING_INPUT'
      : part.state === 'input-available'
        ? 'STARTING'
        : 'IN_PROGRESS'
  )
  const message =
    asString(outputObj?.['message']) ??
    (requestId
      ? `Job ${requestId} is ${inProgressStatus}.`
      : `Status: ${inProgressStatus}`)

  return (
    <Task
      key={keyPrefix}
      defaultOpen={part.state !== 'output-available'}
    >
      <TaskTrigger title={`Deep research: ${topic}`} />
      <TaskContent>
        <TaskItem>{message}</TaskItem>
        {requestId ? (
          <TaskItem>request_id: {requestId}</TaskItem>
        ) : null}
        <TaskItem>state: {part.state}</TaskItem>
      </TaskContent>
    </Task>
  )
}

// ---------------------------------------------------------------------------
// Default fallback (any tool not in the registry)
// ---------------------------------------------------------------------------

export const defaultToolRenderer: ToolRenderer = (
  part,
  { messageId, index },
) => {
  const keyPrefix = `${messageId}-${index}-tool`
  return (
    <Tool key={keyPrefix} defaultOpen={part.state !== 'output-available'}>
      {toolHeader(part)}
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput
          output={partOutput(part)}
          errorText={partErrorText(part)}
        />
      </ToolContent>
    </Tool>
  )
}

// ---------------------------------------------------------------------------
// Registry + dispatch
// ---------------------------------------------------------------------------

/**
 * Map Strands tool names (as emitted by the Python agent) to renderers.
 * Keys MUST match the `@tool`-decorated function names exactly:
 *   - `npiLookup`               (server/agent_tooling.py + healthcare/npiLookup.py)
 *   - `perplexity_search_api`   (research/perplexity_search_api.py)
 *   - `perplexity_deep_research` (research/perplexity_deep_research.py)
 */
export const TOOL_COMPONENT_REGISTRY: Record<string, ToolRenderer> = {
  npiLookup: renderNpiLookup,
  perplexity_search_api: renderPerplexitySearch,
  perplexity_deep_research: renderPerplexityDeepResearch,
}

/**
 * Convenience dispatcher used by CenterPane and StrandsChainOfThought.
 * Selects the registered renderer for `getToolName(part)` or falls back to
 * the canonical `<Tool>` envelope for unknown tools.
 */
export function renderToolPart(
  part: ToolPart,
  ctx: ToolRenderContext,
): ReactNode {
  const renderer = TOOL_COMPONENT_REGISTRY[getToolName(part)] ?? defaultToolRenderer
  return renderer(part, ctx)
}
