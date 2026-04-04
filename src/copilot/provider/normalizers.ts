import type { ToolCall } from '@ag-ui/core'
import {
  PROVIDER_AWARD_KEYWORDS,
  PROVIDER_EDUCATION_KEYWORDS,
  PROVIDER_PUBLICATION_KEYWORDS,
  PROVIDER_REVIEW_KEYWORDS,
} from './constants'
import type {
  ProviderCompareRow,
  ProviderImageCandidate,
  ProviderLocation,
  ProviderResearchCitation,
  ProviderResearchJob,
  ProviderResearchSection,
  ProviderSearchResult,
  ProviderSearchRun,
  ProviderSource,
  ProviderThreadSnapshot,
  ProviderWebGroup,
} from './types'

type JsonRecord = Record<string, unknown>

interface ToolExecution {
  toolCallId: string
  toolName: string
  parameters: JsonRecord
  result: JsonRecord | null
  toolMessage: AgentToolMessage | undefined
}

interface AgentMessageLike {
  id: string
  role: string
  content?: unknown
  toolCalls?: ToolCall[]
  toolCallId?: string
  error?: string
}

interface AgentToolMessage extends AgentMessageLike {
  role: 'tool'
  toolCallId: string
  content: string
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true'
  }
  return false
}

function safeJsonParse(value: string | undefined): JsonRecord | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function parseToolResultObject(value: string | undefined): JsonRecord | null {
  return safeJsonParse(value)
}

function parseToolArguments(toolCall: ToolCall): JsonRecord {
  try {
    const parsed = JSON.parse(toolCall.function.arguments)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function isToolMessage(message: AgentMessageLike): message is AgentToolMessage {
  return message.role === 'tool' && typeof message.toolCallId === 'string' && typeof message.content === 'string'
}

function normalizeLocation(input: unknown, fallbackIndex: number): ProviderLocation | null {
  if (!isRecord(input)) return null
  const addressLine1 = asString(input.address_1) ?? asString(input.address1)
  const addressLine2 = asString(input.address_2) ?? asString(input.address2)
  const city = asString(input.city)
  const state = asString(input.state)
  const postalCode = asString(input.postal_code)
  const countryCode = asString(input.country_code)
  const phone = asString(input.telephone_number)
  const fax = asString(input.fax_number)
  const purpose = asString(input.address_purpose)
  const text = [addressLine1, addressLine2, city, state, postalCode, countryCode]
    .filter(Boolean)
    .join(', ')

  if (!text) return null

  return {
    id: `${purpose ?? 'address'}-${fallbackIndex}-${postalCode ?? 'na'}`,
    purpose,
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
    countryCode,
    phone,
    fax,
    text,
  }
}

function normalizeTaxonomy(input: unknown): ProviderSearchResult['taxonomies'][number] | null {
  if (!isRecord(input)) return null
  return {
    code: asString(input.code),
    description: asString(input.desc),
    primary: asBoolean(input.primary),
    state: asString(input.state),
    license: asString(input.license),
  }
}

function buildDisplayName(record: JsonRecord): string {
  const basic = isRecord(record.basic) ? record.basic : {}
  const organizationName = asString(basic.organization_name)
  if (organizationName) return organizationName

  const nameParts = [
    asString(basic.first_name),
    asString(basic.middle_name),
    asString(basic.last_name),
  ].filter(Boolean)
  const credential = asString(basic.credential)

  if (nameParts.length === 0) {
    return asString(record.name) ?? asString(record.number) ?? 'Provider'
  }

  return credential ? `${nameParts.join(' ')}, ${credential}` : nameParts.join(' ')
}

function normalizeProviderRecord(searchRunId: string, record: unknown): ProviderSearchResult | null {
  if (!isRecord(record)) return null

  const number = asString(record.number)
  if (!number) return null

  const basic = isRecord(record.basic) ? record.basic : {}
  const taxonomyList = Array.isArray(record.taxonomies)
    ? record.taxonomies.map(normalizeTaxonomy).filter((item): item is NonNullable<typeof item> => item !== null)
    : []
  const addresses = Array.isArray(record.addresses)
    ? record.addresses.map(normalizeLocation).filter((item): item is ProviderLocation => item !== null)
    : []

  const locations = addresses.filter((location) => location.purpose === 'LOCATION' || location.purpose === 'PRIMARY')
  const mailingLocations = addresses.filter((location) => location.purpose === 'MAILING')
  const leadLocation = locations[0] ?? mailingLocations[0] ?? addresses[0] ?? null
  const primaryTaxonomy = taxonomyList.find((taxonomy) => taxonomy.primary)?.description ?? taxonomyList[0]?.description ?? null
  const organizationName = asString(basic.organization_name)
  const displayName = buildDisplayName(record)

  return {
    searchRunId,
    npi: number,
    displayName,
    sortName: displayName.toLowerCase(),
    enumerationType: asString(record.enumeration_type),
    organizationName,
    credential: asString(basic.credential),
    gender: asString(basic.gender),
    status: asString(record.status),
    primaryTaxonomy,
    taxonomies: taxonomyList,
    locations,
    mailingLocations,
    city: leadLocation?.city ?? null,
    state: leadLocation?.state ?? null,
    image: null,
    imageConfidence: 'none',
    webGroups: [],
    reviewSources: [],
    educationSources: [],
    publicationSources: [],
    awardSources: [],
    generalSources: [],
    rawRecord: record,
  }
}

function normalizeSource(input: unknown): ProviderSource | null {
  if (!isRecord(input)) return null
  const url = asString(input.url)
  if (!url) return null

  return {
    title: asString(input.title) ?? url,
    url,
    snippet: asString(input.snippet) ?? '',
    domain: asString(input.domain) ?? (() => {
      try {
        return new URL(url).hostname
      } catch {
        return url
      }
    })(),
    date: asString(input.date) ?? asString(input.last_updated),
  }
}

function keywordScore(source: ProviderSource, keywords: readonly string[]): number {
  const haystack = `${source.title} ${source.snippet} ${source.domain}`.toLowerCase()
  return keywords.reduce((score, keyword) => score + (haystack.includes(keyword) ? 1 : 0), 0)
}

function createResearchSections(report: string | null): ProviderResearchSection[] {
  if (!report) return []
  const lines = report.split(/\r?\n/)
  const sections: ProviderResearchSection[] = []
  let current: ProviderResearchSection | null = null
  const pushSection = (section: ProviderResearchSection | null) => {
    if (section && section.content.trim()) {
      sections.push(section)
    }
  }

  lines.forEach((line) => {
    const headingMatch = line.match(/^#{2,3}\s+(.+)$/)
    if (headingMatch) {
      pushSection(current)
      current = {
        id: headingMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        heading: headingMatch[1].trim(),
        content: '',
      }
      return
    }

    if (!current) {
      current = {
        id: 'overview',
        heading: 'Overview',
        content: '',
      }
    }

    current.content = current.content.length > 0 ? `${current.content}\n${line}` : line
  })

  pushSection(current)
  return sections
}

function collectToolExecutions(messages: AgentMessageLike[]): ToolExecution[] {
  const toolMessages = new Map<string, AgentToolMessage>()

  messages.forEach((message) => {
    if (isToolMessage(message)) {
      toolMessages.set(message.toolCallId, message)
    }
  })

  const executions: ToolExecution[] = []

  messages.forEach((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.toolCalls)) return

    message.toolCalls.forEach((toolCall) => {
      const toolMessage = toolMessages.get(toolCall.id)
      executions.push({
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        parameters: parseToolArguments(toolCall),
        result: safeJsonParse(toolMessage?.content),
        toolMessage,
      })
    })
  })

  return executions
}

function normalizeNpiSearchRun(execution: ToolExecution): ProviderSearchRun | null {
  if (execution.toolName !== 'npiLookup' || !execution.result) return null

  const results = Array.isArray(execution.result.results) ? execution.result.results : []
  const providers = results
    .map((record) => normalizeProviderRecord(execution.toolCallId, record))
    .filter((provider): provider is ProviderSearchResult => provider !== null)
    .sort((left, right) => left.sortName.localeCompare(right.sortName))

  const errors = Array.isArray(execution.result.errors)
    ? execution.result.errors.map((error) => (typeof error === 'string' ? error : JSON.stringify(error)))
    : execution.result.error
      ? [String(execution.result.error)]
      : []

  return {
    id: execution.toolCallId,
    title: providers.length === 1 ? providers[0].displayName : `${providers.length} providers`,
    query: execution.parameters,
    apiResultCount: asNumber(execution.result.api_result_count) ?? providers.length,
    resultCount: asNumber(execution.result.result_count) ?? providers.length,
    providers,
    errors,
  }
}

export function normalizeNpiLookupResult(
  parameters: Record<string, unknown>,
  result: string | undefined,
  searchRunId = 'npiLookup',
): ProviderSearchRun | null {
  const parsedResult = safeJsonParse(result)
  if (!parsedResult) return null

  return normalizeNpiSearchRun({
    toolCallId: searchRunId,
    toolName: 'npiLookup',
    parameters,
    result: parsedResult,
    toolMessage: undefined,
  })
}

function buildProviderIdentityStrings(provider: ProviderSearchResult): string[] {
  return [
    provider.displayName,
    provider.organizationName,
    provider.city,
    provider.state,
    provider.npi,
    provider.primaryTaxonomy,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase())
}

function scoreProviderMatch(provider: ProviderSearchResult, query: string): number {
  const normalizedQuery = query.toLowerCase()
  return buildProviderIdentityStrings(provider).reduce((score, token) => (
    normalizedQuery.includes(token) ? score + 2 : normalizedQuery.includes(token.split(' ')[0] ?? '') ? score + 1 : score
  ), 0)
}

function scoreSourceForProvider(provider: ProviderSearchResult, source: ProviderSource): number {
  const haystack = `${source.title} ${source.snippet} ${source.domain}`.toLowerCase()
  return buildProviderIdentityStrings(provider).reduce((score, token) => (
    haystack.includes(token) ? score + 2 : haystack.includes(token.split(' ')[0] ?? '') ? score + 1 : score
  ), 0)
}

function normalizePerplexityGroups(execution: ToolExecution): ProviderWebGroup[] {
  if (execution.toolName !== 'perplexity_search_api' || !execution.result) return []
  const groups = Array.isArray(execution.result.results) ? execution.result.results : []
  const globalImages = Array.isArray(execution.result.images) ? execution.result.images : []

  return groups.flatMap((group, groupIndex) => {
    if (!isRecord(group)) return []
    const query = asString(group.query) ?? `Query ${groupIndex + 1}`
    const sources = Array.isArray(group.results)
      ? group.results.map(normalizeSource).filter((item): item is ProviderSource => item !== null)
      : []

    const sourceUrls = new Set(sources.map((source) => source.url))
    const imageCandidates = globalImages.flatMap((candidate) => {
      if (!isRecord(candidate)) return []
      const url = asString(candidate.url)
      const sourceUrl = asString(candidate.source_url)
      if (!url) return []
      if (sourceUrl && sourceUrls.size > 0 && !sourceUrls.has(sourceUrl)) return []

      const source = sources.find((item) => item.url === sourceUrl) ?? null
      return [{
        url,
        sourceUrl,
        sourceTitle: source?.title ?? null,
        sourceSnippet: source?.snippet ?? null,
        sourceDomain: source?.domain ?? null,
        score: 0,
      } satisfies ProviderImageCandidate]
    })

    return [{
      id: `${execution.toolCallId}-${groupIndex}`,
      query,
      sources,
      imageCandidates,
    } satisfies ProviderWebGroup]
  })
}

function mergeWebGroupsIntoProviders(
  providers: ProviderSearchResult[],
  groups: ProviderWebGroup[],
): ProviderSearchResult[] {
  if (providers.length === 0 || groups.length === 0) return providers

  return providers.map((provider) => {
    const matchingGroups = groups
      .map((group) => ({
        group,
        score: Math.max(
          scoreProviderMatch(provider, group.query),
          ...group.sources.map((source) => scoreSourceForProvider(provider, source)),
        ),
      }))
      .filter((match) => match.score >= 2)
      .sort((left, right) => right.score - left.score)
      .map((match) => match.group)

    if (matchingGroups.length === 0) return provider

    const sourcePool = matchingGroups.flatMap((group) => group.sources)
    const images = matchingGroups.flatMap((group) => group.imageCandidates)
      .map((candidate) => {
        const matchingSource = sourcePool.find((source) => source.url === candidate.sourceUrl) ?? null
        const score = (
          (matchingSource ? scoreSourceForProvider(provider, matchingSource) : 0) +
          (candidate.sourceUrl && buildProviderIdentityStrings(provider).some((token) => candidate.sourceUrl?.toLowerCase().includes(token)) ? 2 : 0)
        )

        return {
          ...candidate,
          score,
        }
      })
      .sort((left, right) => right.score - left.score)

    const image = images[0] ?? null
    const imageConfidence = !image ? 'none' : image.score >= 4 ? 'high' : 'low'

    return {
      ...provider,
      webGroups: matchingGroups,
      image: imageConfidence === 'high' ? image : null,
      imageConfidence,
      reviewSources: sourcePool.filter((source) => keywordScore(source, PROVIDER_REVIEW_KEYWORDS) > 0),
      educationSources: sourcePool.filter((source) => keywordScore(source, PROVIDER_EDUCATION_KEYWORDS) > 0),
      publicationSources: sourcePool.filter((source) => keywordScore(source, PROVIDER_PUBLICATION_KEYWORDS) > 0),
      awardSources: sourcePool.filter((source) => keywordScore(source, PROVIDER_AWARD_KEYWORDS) > 0),
      generalSources: sourcePool,
    }
  })
}

function normalizeResearchJob(execution: ToolExecution): ProviderResearchJob | null {
  if (execution.toolName !== 'perplexity_deep_research' || !execution.result) return null
  const citations = Array.isArray(execution.result.citations)
    ? execution.result.citations.flatMap((citation) => {
      if (isRecord(citation)) {
        const title = asString(citation.title) ?? asString(citation.name) ?? asString(citation.url)
        const url = asString(citation.url)
        if (!title || !url) return []
        return [{ title, url } satisfies ProviderResearchCitation]
      }

      if (typeof citation === 'string') {
        return [{ title: citation, url: citation } satisfies ProviderResearchCitation]
      }

      return []
    })
    : []

  const report = asString(execution.result.report)

  return {
    toolCallId: execution.toolCallId,
    status: asString(execution.result.status) ?? 'UNKNOWN',
    requestId: asString(execution.result.request_id),
    topic: asString(execution.result.topic) ?? '',
    depth: asString(execution.result.depth),
    attempts: asNumber(execution.result.attempts) ?? 0,
    nextPollInSeconds: asNumber(execution.result.next_poll_in_seconds),
    sourcesAnalyzed: asNumber(execution.result.sources_analyzed) ?? citations.length,
    error: asString(execution.result.error) ?? asString(execution.result.last_error),
    report,
    citations,
    sections: createResearchSections(report),
  }
}

export function normalizeDeepResearchResult(
  result: string | undefined,
  toolCallId = 'perplexity_deep_research',
): ProviderResearchJob | null {
  const parsedResult = safeJsonParse(result)
  if (!parsedResult) return null

  return normalizeResearchJob({
    toolCallId,
    toolName: 'perplexity_deep_research',
    parameters: {},
    result: parsedResult,
    toolMessage: undefined,
  })
}

function mergeResearchIntoProviders(
  providers: ProviderSearchResult[],
  researchJobs: ProviderResearchJob[],
): ProviderSearchResult[] {
  if (providers.length === 0 || researchJobs.length === 0) return providers

  return providers.map((provider) => {
    const normalizedProviderName = provider.displayName.toLowerCase()
    const matchingJobs = researchJobs.filter((job) => {
      const topic = job.topic.toLowerCase()
      return topic.includes(provider.npi.toLowerCase()) ||
        topic.includes(normalizedProviderName) ||
        (provider.organizationName ? topic.includes(provider.organizationName.toLowerCase()) : false)
    })

    if (matchingJobs.length === 0) return provider

    const citations = matchingJobs.flatMap((job) => job.citations.map((citation) => ({
      title: citation.title,
      url: citation.url,
      snippet: '',
      domain: (() => {
        try {
          return new URL(citation.url).hostname
        } catch {
          return citation.url
        }
      })(),
      date: null,
    } satisfies ProviderSource)))

    return {
      ...provider,
      generalSources: [...provider.generalSources, ...citations],
      reviewSources: [...provider.reviewSources, ...citations.filter((source) => keywordScore(source, PROVIDER_REVIEW_KEYWORDS) > 0)],
      educationSources: [...provider.educationSources, ...citations.filter((source) => keywordScore(source, PROVIDER_EDUCATION_KEYWORDS) > 0)],
      publicationSources: [...provider.publicationSources, ...citations.filter((source) => keywordScore(source, PROVIDER_PUBLICATION_KEYWORDS) > 0)],
      awardSources: [...provider.awardSources, ...citations.filter((source) => keywordScore(source, PROVIDER_AWARD_KEYWORDS) > 0)],
    }
  })
}

export function createProviderThreadSnapshot(messages: AgentMessageLike[]): ProviderThreadSnapshot {
  const executions = collectToolExecutions(messages)
  const researchJobs = executions
    .map(normalizeResearchJob)
    .filter((job): job is ProviderResearchJob => job !== null)

  const allWebGroups = executions.flatMap(normalizePerplexityGroups)

  const searchRuns = executions
    .map(normalizeNpiSearchRun)
    .filter((run): run is ProviderSearchRun => run !== null)
    .map((run) => ({
      ...run,
      providers: mergeResearchIntoProviders(
        mergeWebGroupsIntoProviders(run.providers, allWebGroups),
        researchJobs,
      ),
    }))

  return {
    searchRuns,
    researchJobs,
  }
}

export function buildProviderCompareRows(providers: ProviderSearchResult[]): ProviderCompareRow[] {
  return [
    {
      label: 'Specialty',
      values: providers.map((provider) => provider.primaryTaxonomy),
    },
    {
      label: 'Organization',
      values: providers.map((provider) => provider.organizationName),
    },
    {
      label: 'Primary location',
      values: providers.map((provider) => provider.locations[0]?.text ?? provider.mailingLocations[0]?.text ?? null),
    },
    {
      label: 'Location count',
      values: providers.map((provider) => String(provider.locations.length || provider.mailingLocations.length || 0)),
    },
    {
      label: 'Review sources',
      values: providers.map((provider) => String(provider.reviewSources.length)),
    },
    {
      label: 'Education sources',
      values: providers.map((provider) => String(provider.educationSources.length)),
    },
    {
      label: 'Publication sources',
      values: providers.map((provider) => String(provider.publicationSources.length)),
    },
    {
      label: 'Award sources',
      values: providers.map((provider) => String(provider.awardSources.length)),
    },
  ]
}

export function buildGoogleMapsSearchUrl(location: ProviderLocation): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location.text)}`
}

export function buildGoogleMapsDirectionsUrl(location: ProviderLocation): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(location.text)}`
}

export function findProviderByNpi(searchRuns: ProviderSearchRun[], npi: string | null): ProviderSearchResult | null {
  if (!npi) return null
  for (const run of searchRuns) {
    const match = run.providers.find((provider) => provider.npi === npi)
    if (match) return match
  }
  return null
}
