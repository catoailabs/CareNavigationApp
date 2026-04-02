export interface ProviderLocation {
  id: string
  purpose: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  state: string | null
  postalCode: string | null
  countryCode: string | null
  phone: string | null
  fax: string | null
  text: string
}

export interface ProviderTaxonomy {
  code: string | null
  description: string | null
  primary: boolean
  state: string | null
  license: string | null
}

export interface ProviderImageCandidate {
  url: string
  sourceUrl: string | null
  sourceTitle: string | null
  sourceSnippet: string | null
  sourceDomain: string | null
  score: number
}

export interface ProviderSource {
  title: string
  url: string
  snippet: string
  domain: string
  date: string | null
}

export interface ProviderWebGroup {
  id: string
  query: string
  sources: ProviderSource[]
  imageCandidates: ProviderImageCandidate[]
}

export interface ProviderSearchResult {
  searchRunId: string
  npi: string
  displayName: string
  sortName: string
  enumerationType: string | null
  organizationName: string | null
  credential: string | null
  gender: string | null
  status: string | null
  primaryTaxonomy: string | null
  taxonomies: ProviderTaxonomy[]
  locations: ProviderLocation[]
  mailingLocations: ProviderLocation[]
  city: string | null
  state: string | null
  image: ProviderImageCandidate | null
  imageConfidence: 'high' | 'low' | 'none'
  webGroups: ProviderWebGroup[]
  reviewSources: ProviderSource[]
  educationSources: ProviderSource[]
  publicationSources: ProviderSource[]
  awardSources: ProviderSource[]
  generalSources: ProviderSource[]
  rawRecord: Record<string, unknown>
}

export interface ProviderSearchRun {
  id: string
  title: string
  query: Record<string, unknown>
  apiResultCount: number
  resultCount: number
  providers: ProviderSearchResult[]
  errors: string[]
}

export interface ProviderResearchCitation {
  title: string
  url: string
}

export interface ProviderResearchSection {
  id: string
  heading: string
  content: string
}

export interface ProviderResearchJob {
  toolCallId: string
  status: string
  requestId: string | null
  topic: string
  depth: string | null
  attempts: number
  nextPollInSeconds: number | null
  sourcesAnalyzed: number
  error: string | null
  report: string | null
  citations: ProviderResearchCitation[]
  sections: ProviderResearchSection[]
}

export interface ProviderCompareRow {
  label: string
  values: Array<string | null>
}

export interface ProviderThreadSnapshot {
  searchRuns: ProviderSearchRun[]
  researchJobs: ProviderResearchJob[]
}
