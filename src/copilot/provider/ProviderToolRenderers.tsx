import { useRenderToolCall } from '@copilotkit/react-core'
import { InlineToolStatusCard, ProviderResultsGrid } from '@/components/provider/ProviderUi'
import {
  normalizeDeepResearchResult,
  normalizeNpiLookupResult,
  parseToolResultObject,
} from './normalizers'

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

type ToolParameter = {
  name: string
  type?: 'string' | 'number' | 'boolean' | 'object' | 'string[]' | 'number[]' | 'boolean[]' | 'object[]'
  description?: string
  required?: boolean
  enum?: string[]
  attributes?: ToolParameter[]
}

const npiLookupRenderParameters = [
  { name: 'number', type: 'string', required: false, description: 'Direct NPI number lookup.' },
  { name: 'first_name', type: 'string', required: false, description: 'Provider first name.' },
  { name: 'last_name', type: 'string', required: false, description: 'Provider last name.' },
  { name: 'organization_name', type: 'string', required: false, description: 'Organization or practice name.' },
  { name: 'city', type: 'string', required: false, description: 'Provider city.' },
  { name: 'state', type: 'string', required: false, description: 'Provider state.' },
] satisfies ToolParameter[]

const perplexitySearchRenderParameters = [
  { name: 'query', type: 'string', required: false, description: 'Primary enrichment query.' },
  { name: 'queries', type: 'string[]', required: false, description: 'Batch enrichment queries.' },
] satisfies ToolParameter[]

const perplexityDeepResearchRenderParameters = [
  { name: 'topic', type: 'string', required: true, description: 'Research topic for the dossier.' },
] satisfies ToolParameter[]

function buildProviderLookupLabel(parameters: Record<string, unknown>) {
  const parts = [
    typeof parameters.first_name === 'string' ? parameters.first_name : null,
    typeof parameters.last_name === 'string' ? parameters.last_name : null,
    typeof parameters.organization_name === 'string' ? parameters.organization_name : null,
    typeof parameters.city === 'string' ? parameters.city : null,
    typeof parameters.state === 'string' ? parameters.state : null,
    typeof parameters.number === 'string' ? `NPI ${parameters.number}` : null,
  ].filter(Boolean)

  return parts.length > 0 ? parts.join(' · ') : 'provider registry search'
}

function buildPerplexityLabel(parameters: Record<string, unknown>) {
  if (typeof parameters.query === 'string' && parameters.query.trim()) {
    return parameters.query.trim()
  }

  if (Array.isArray(parameters.queries) && parameters.queries.length > 0) {
    const firstQuery = parameters.queries.find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    if (firstQuery) {
      return parameters.queries.length === 1 ? firstQuery : `${firstQuery} + ${parameters.queries.length - 1} more`
    }
  }

  return 'provider web enrichment'
}

export function ProviderToolRenderers() {
  useRenderToolCall(
    {
      name: 'npiLookup',
      parameters: npiLookupRenderParameters,
      render: ({ status, args, result }) => {
        if (status !== 'complete') {
          return (
            <InlineToolStatusCard
              title="Provider discovery"
              subtitle={`Running NPPES lookup for ${buildProviderLookupLabel(args)}.`}
              status={status}
            />
          )
        }

        const searchRun = normalizeNpiLookupResult(args, result)
        if (!searchRun) {
          return (
            <InlineToolStatusCard
              title="Provider discovery"
              subtitle="The registry lookup completed, but the result payload could not be parsed into the verified NPPES result shape."
              status="complete"
            />
          )
        }

        return <ProviderResultsGrid searchRun={searchRun} />
      },
    },
  )

  useRenderToolCall(
    {
      name: 'perplexity_search_api',
      parameters: perplexitySearchRenderParameters,
      render: ({ status, args, result }) => {
        if (status !== 'complete') {
          return (
            <InlineToolStatusCard
              title="Web enrichment"
              subtitle={`Searching provider web sources for ${buildPerplexityLabel(args)}.`}
              status={status}
            />
          )
        }

        const parsed = parseToolResultObject(result)
        const groupCount = Array.isArray(parsed?.results) ? parsed.results.length : 0
        const imageCount = Array.isArray(parsed?.images) ? parsed.images.length : 0

        return (
          <InlineToolStatusCard
            title="Web enrichment"
            subtitle={`Completed provider enrichment for ${buildPerplexityLabel(args)} with ${pluralize(groupCount, 'source group')} and ${pluralize(imageCount, 'image candidate')}.`}
            status="complete"
          />
        )
      },
    },
  )

  useRenderToolCall(
    {
      name: 'perplexity_deep_research',
      parameters: perplexityDeepResearchRenderParameters,
      render: ({ status, args, result }) => {
        if (status !== 'complete') {
          return (
            <InlineToolStatusCard
              title="Deep research"
              subtitle={`Research job requested for ${args.topic}.`}
              status={status}
            />
          )
        }

        const researchJob = normalizeDeepResearchResult(result)
        if (!researchJob) {
          return (
            <InlineToolStatusCard
              title="Deep research"
              subtitle="The research tool completed, but the returned payload could not be normalized into the verified job contract."
              status="complete"
            />
          )
        }

        const subtitle = researchJob.status === 'COMPLETED'
          ? `Research dossier ready for ${researchJob.topic} with ${pluralize(researchJob.citations.length, 'citation')}.`
          : researchJob.error
            ? `Research status ${researchJob.status}. ${researchJob.error}`
            : `Research status ${researchJob.status} for ${researchJob.topic}.`

        return (
          <InlineToolStatusCard
            title="Deep research"
            subtitle={subtitle}
            status="complete"
          />
        )
      },
    },
  )

  return null
}
