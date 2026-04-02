import { useDefaultRenderTool, useRenderTool } from '@copilotkit/react-core/v2'
import { InlineToolStatusCard, ProviderResultsGrid } from '@/components/provider/ProviderUi'
import { PROVIDER_AGENT_ID } from './constants'
import {
  normalizeDeepResearchResult,
  normalizeNpiLookupResult,
  parseToolResultObject,
} from './normalizers'
import {
  npiLookupParametersSchema,
  perplexityDeepResearchParametersSchema,
  perplexitySearchParametersSchema,
} from './schemas'

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

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
  useRenderTool(
    {
      name: 'npiLookup',
      agentId: PROVIDER_AGENT_ID,
      parameters: npiLookupParametersSchema,
      render: ({ status, parameters, result }) => {
        if (status !== 'complete') {
          return (
            <InlineToolStatusCard
              title="Provider discovery"
              subtitle={`Running NPPES lookup for ${buildProviderLookupLabel(parameters)}.`}
              status={status}
            />
          )
        }

        const searchRun = normalizeNpiLookupResult(parameters, result)
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
    [],
  )

  useRenderTool(
    {
      name: 'perplexity_search_api',
      agentId: PROVIDER_AGENT_ID,
      parameters: perplexitySearchParametersSchema,
      render: ({ status, parameters, result }) => {
        if (status !== 'complete') {
          return (
            <InlineToolStatusCard
              title="Web enrichment"
              subtitle={`Searching provider web sources for ${buildPerplexityLabel(parameters)}.`}
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
            subtitle={`Completed provider enrichment for ${buildPerplexityLabel(parameters)} with ${pluralize(groupCount, 'source group')} and ${pluralize(imageCount, 'image candidate')}.`}
            status="complete"
          />
        )
      },
    },
    [],
  )

  useRenderTool(
    {
      name: 'perplexity_deep_research',
      agentId: PROVIDER_AGENT_ID,
      parameters: perplexityDeepResearchParametersSchema,
      render: ({ status, parameters, result }) => {
        if (status !== 'complete') {
          return (
            <InlineToolStatusCard
              title="Deep research"
              subtitle={`Research job requested for ${parameters.topic}.`}
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
    [],
  )

  useDefaultRenderTool(
    {
      render: ({ name, status, parameters, result }) => (
        <InlineToolStatusCard
          title={name}
          subtitle={
            status === 'complete'
              ? typeof result === 'string' && result.trim().length > 0
                ? `Completed with payload available.`
                : 'Completed.'
              : `Tool call is ${status}.`
          }
          status={status}
          action={
            status === 'complete' && parameters
              ? (
                <div className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-white/38">
                  Fallback renderer
                </div>
              )
              : undefined
          }
        />
      ),
    },
    [],
  )

  return null
}
