import { AnimatePresence, motion } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowTopRightOnSquareIcon,
  ArrowTrendingUpIcon,
  BuildingOffice2Icon,
  CheckBadgeIcon,
  ChevronRightIcon,
  MapPinIcon,
  ShieldCheckIcon,
  SparklesIcon,
  StarIcon,
  UserGroupIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { cn } from '@/utils/cn'
import { buildGoogleMapsDirectionsUrl, buildGoogleMapsSearchUrl } from '@/copilot/provider/normalizers'
import { useProviderThreadState } from '@/copilot/provider/ProviderThreadState'
import type { ProviderResearchJob, ProviderSearchResult, ProviderSearchRun, ProviderSource } from '@/copilot/provider/types'

const EASE = [0.16, 1, 0.3, 1] as const

export function SurfaceCard({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-[28px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(15,15,27,0.96)_0%,rgba(10,10,18,0.92)_100%)] shadow-[0_24px_120px_-52px_rgba(99,102,241,0.45)] backdrop-blur-2xl',
        className,
      )}
    >
      {children}
    </div>
  )
}

function SectionCard({
  title,
  eyebrow,
  children,
  className,
}: {
  title: string
  eyebrow?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <SurfaceCard className={cn('p-5', className)}>
      <div className="mb-4">
        {eyebrow ? (
          <div className="mb-1 text-[10px] uppercase tracking-[0.24em] text-white/45">{eyebrow}</div>
        ) : null}
        <h3 className="text-sm font-medium text-white">{title}</h3>
      </div>
      {children}
    </SurfaceCard>
  )
}

function ProviderAvatar({ provider, large = false }: { provider: ProviderSearchResult; large?: boolean }) {
  const size = large ? 'h-28 w-28' : 'h-20 w-20'
  const image = provider.image?.url

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-[26px] border border-white/[0.08] bg-[radial-gradient(circle_at_top,rgba(129,140,248,0.2),rgba(14,14,24,0.96))]',
        size,
      )}
    >
      {image ? (
        <img src={image} alt={provider.displayName} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(180deg,rgba(99,102,241,0.2),rgba(12,12,20,0.96))]">
          <span className={cn('font-light tracking-[0.22em] text-white/75', large ? 'text-xl' : 'text-sm')}>
            {provider.displayName
              .split(' ')
              .slice(0, 2)
              .map((part) => part.charAt(0))
              .join('')
              .toUpperCase()}
          </span>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[#050505] to-transparent" />
      {provider.imageConfidence === 'high' ? (
        <div className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-emerald-200">
          <CheckBadgeIcon className="h-3.5 w-3.5" />
          Verified
        </div>
      ) : null}
    </div>
  )
}

function ProviderStat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] px-3 py-3">
      <div className="mb-2 flex items-center gap-2 text-white/45">{icon}</div>
      <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">{label}</div>
      <div className="mt-1 text-sm font-medium text-white">{value}</div>
    </div>
  )
}

function SourceList({
  sources,
  empty,
}: {
  sources: ProviderSource[]
  empty: string
}) {
  if (sources.length === 0) {
    return <p className="text-sm leading-relaxed text-white/48">{empty}</p>
  }

  return (
    <div className="space-y-3">
      {sources.slice(0, 6).map((source) => (
        <a
          key={`${source.url}-${source.title}`}
          href={source.url}
          target="_blank"
          rel="noreferrer"
          className="group block rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 transition-colors hover:border-indigo-400/30 hover:bg-indigo-400/[0.06]"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-white group-hover:text-indigo-100">{source.title}</div>
              <div className="mt-1 text-xs uppercase tracking-[0.18em] text-white/35">{source.domain}</div>
            </div>
            <ArrowTopRightOnSquareIcon className="mt-0.5 h-4 w-4 shrink-0 text-white/35 group-hover:text-indigo-200" />
          </div>
          {source.snippet ? (
            <p className="mt-3 text-sm leading-relaxed text-white/58">{source.snippet}</p>
          ) : null}
        </a>
      ))}
    </div>
  )
}

export function InlineToolStatusCard({
  title,
  subtitle,
  status,
  action,
}: {
  title: string
  subtitle: string
  status: 'inProgress' | 'executing' | 'complete'
  action?: React.ReactNode
}) {
  return (
    <SurfaceCard className="mt-3 overflow-hidden">
      <div className="flex items-center justify-between gap-4 border-b border-white/[0.06] px-4 py-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Provider Workflow</div>
          <div className="mt-1 text-sm font-medium text-white">{title}</div>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-indigo-400/20 bg-indigo-400/10 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-indigo-100">
          <span className={cn('h-2 w-2 rounded-full', status === 'complete' ? 'bg-emerald-400' : 'bg-indigo-300 animate-pulse')} />
          {status === 'complete' ? 'Complete' : 'Running'}
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 px-4 py-4">
        <p className="text-sm leading-relaxed text-white/62">{subtitle}</p>
        {action}
      </div>
    </SurfaceCard>
  )
}

function ProviderCard({ provider }: { provider: ProviderSearchResult }) {
  const { openProfile, toggleCompare, comparedProviders } = useProviderThreadState()
  const isCompared = comparedProviders.some((candidate) => candidate.npi === provider.npi)

  return (
    <SurfaceCard className="group overflow-hidden p-4 transition-transform duration-300 hover:-translate-y-0.5">
      <div className="grid gap-4 sm:grid-cols-[auto,1fr]">
        <ProviderAvatar provider={provider} />
        <div>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">
                {provider.enumerationType ?? 'Provider'}
              </div>
              <h3 className="mt-2 text-lg font-medium text-white">{provider.displayName}</h3>
              <p className="mt-1 text-sm text-white/58">{provider.primaryTaxonomy ?? 'Specialty unavailable'}</p>
            </div>
            <div className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-white/45">
              NPI {provider.npi}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {provider.organizationName ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-xs text-white/62">
                <BuildingOffice2Icon className="h-4 w-4" />
                {provider.organizationName}
              </span>
            ) : null}
            {provider.city || provider.state ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-xs text-white/62">
                <MapPinIcon className="h-4 w-4" />
                {[provider.city, provider.state].filter(Boolean).join(', ')}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-xs text-white/62">
              <SparklesIcon className="h-4 w-4" />
              {provider.generalSources.length > 0 ? `${provider.generalSources.length} cited web signals` : 'Awaiting web enrichment'}
            </span>
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              onClick={() => void openProfile(provider)}
              className="inline-flex items-center gap-2 rounded-full bg-[linear-gradient(135deg,#6366F1,#4C1D95)] px-4 py-2 text-sm font-medium text-white shadow-[0_18px_50px_-28px_rgba(99,102,241,0.8)] transition-transform hover:scale-[1.02]"
            >
              See Profile
              <ChevronRightIcon className="h-4 w-4" />
            </button>
            <button
              onClick={() => toggleCompare(provider)}
              className={cn(
                'inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors',
                isCompared
                  ? 'border-emerald-300/30 bg-emerald-400/12 text-emerald-100'
                  : 'border-white/[0.08] bg-white/[0.03] text-white/62 hover:border-indigo-300/25 hover:text-white',
              )}
            >
              <UserGroupIcon className="h-4 w-4" />
              {isCompared ? 'Added' : 'Compare'}
            </button>
          </div>
        </div>
      </div>
    </SurfaceCard>
  )
}

export function ProviderResultsGrid({ searchRun }: { searchRun: ProviderSearchRun }) {
  if (searchRun.providers.length === 0) {
    return (
      <InlineToolStatusCard
        title="Provider discovery"
        subtitle={searchRun.errors[0] ?? 'The registry call returned no providers for this search.'}
        status="complete"
      />
    )
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-center justify-between gap-4 px-1">
        <div>
          <div className="text-[10px] uppercase tracking-[0.24em] text-white/35">Provider discovery</div>
          <h2 className="mt-2 text-sm font-medium text-white">
            {searchRun.providers.length === 1 ? '1 provider found' : `${searchRun.providers.length} providers found`}
          </h2>
        </div>
        <div className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-white/45">
          CMS NPPES
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {searchRun.providers.map((provider) => (
          <ProviderCard key={`${searchRun.id}-${provider.npi}`} provider={provider} />
        ))}
      </div>
    </div>
  )
}

export function ProviderProfileSheet() {
  const {
    selectedProvider,
    isProfileOpen,
    closeProfile,
    openResearch,
  } = useProviderThreadState()

  return (
    <AnimatePresence>
      {isProfileOpen && selectedProvider ? (
        <motion.div
          initial={{ opacity: 0, x: 48 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 48 }}
          transition={{ duration: 0.32, ease: EASE }}
          className="absolute inset-y-0 right-0 z-40 w-full max-w-[720px] border-l border-white/[0.08] bg-[#05050b]/96 px-5 py-5 backdrop-blur-2xl"
        >
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between gap-4 pb-4">
              <div>
                <div className="text-[10px] uppercase tracking-[0.24em] text-white/35">Provider profile</div>
                <h2 className="mt-2 text-2xl font-medium text-white">{selectedProvider.displayName}</h2>
              </div>
              <button
                onClick={closeProfile}
                className="rounded-full border border-white/[0.08] bg-white/[0.03] p-2 text-white/58 transition-colors hover:text-white"
                aria-label="Close provider profile"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto pr-1">
              <div className="grid gap-4 lg:grid-cols-[240px,1fr]">
                <SurfaceCard className="p-4">
                  <ProviderAvatar provider={selectedProvider} large />
                  <div className="mt-4 space-y-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.24em] text-white/35">NPI</div>
                      <div className="mt-1 text-sm text-white">{selectedProvider.npi}</div>
                    </div>
                    {selectedProvider.primaryTaxonomy ? (
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.24em] text-white/35">Primary specialty</div>
                        <div className="mt-1 text-sm text-white">{selectedProvider.primaryTaxonomy}</div>
                      </div>
                    ) : null}
                    {selectedProvider.organizationName ? (
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.24em] text-white/35">Organization</div>
                        <div className="mt-1 text-sm text-white">{selectedProvider.organizationName}</div>
                      </div>
                    ) : null}
                    <button
                      onClick={() => void openResearch(selectedProvider)}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[linear-gradient(135deg,#1f3a8a,#4C1D95)] px-4 py-3 text-sm font-medium text-white"
                    >
                      <ArrowTrendingUpIcon className="h-4 w-4" />
                      Deep Research
                    </button>
                  </div>
                </SurfaceCard>

                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <ProviderStat
                      icon={<MapPinIcon className="h-5 w-5" />}
                      label="Locations"
                      value={String(selectedProvider.locations.length || selectedProvider.mailingLocations.length || 0)}
                    />
                    <ProviderStat
                      icon={<ShieldCheckIcon className="h-5 w-5" />}
                      label="Review sources"
                      value={String(selectedProvider.reviewSources.length)}
                    />
                    <ProviderStat
                      icon={<SparklesIcon className="h-5 w-5" />}
                      label="Education sources"
                      value={String(selectedProvider.educationSources.length)}
                    />
                    <ProviderStat
                      icon={<StarIcon className="h-5 w-5" />}
                      label="Publication sources"
                      value={String(selectedProvider.publicationSources.length)}
                    />
                  </div>

                  <SectionCard title="Locations" eyebrow="Directions ready">
                    <div className="space-y-3">
                      {(selectedProvider.locations.length > 0 ? selectedProvider.locations : selectedProvider.mailingLocations).map((location) => (
                        <div
                          key={location.id}
                          className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-3"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <div className="text-xs uppercase tracking-[0.18em] text-white/35">
                                {location.purpose ?? 'Practice location'}
                              </div>
                              <div className="mt-2 text-sm leading-relaxed text-white">{location.text}</div>
                            </div>
                            <div className="flex gap-2">
                              <a
                                href={buildGoogleMapsSearchUrl(location)}
                                target="_blank"
                                rel="noreferrer"
                                className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-white/62 transition-colors hover:text-white"
                              >
                                Map
                              </a>
                              <a
                                href={buildGoogleMapsDirectionsUrl(location)}
                                target="_blank"
                                rel="noreferrer"
                                className="rounded-full border border-indigo-300/20 bg-indigo-400/10 px-3 py-2 text-xs text-indigo-100 transition-colors hover:bg-indigo-400/15"
                              >
                                Directions
                              </a>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </SectionCard>

                  <SectionCard title="Patient reviews" eyebrow="Source attributed">
                    <SourceList
                      sources={selectedProvider.reviewSources}
                      empty="No verified review sources have been found for this provider yet."
                    />
                  </SectionCard>

                  <SectionCard title="Education and training" eyebrow="Web-enriched">
                    <SourceList
                      sources={selectedProvider.educationSources}
                      empty="No confirmed education or training sources have been surfaced yet."
                    />
                  </SectionCard>

                  <SectionCard title="Publications and articles" eyebrow="Source attributed">
                    <SourceList
                      sources={selectedProvider.publicationSources}
                      empty="No publications or article sources have been confirmed for this provider yet."
                    />
                  </SectionCard>

                  <SectionCard title="Awards and recognition" eyebrow="Source attributed">
                    <SourceList
                      sources={selectedProvider.awardSources}
                      empty="No awards or recognition sources have been confirmed for this provider yet."
                    />
                  </SectionCard>

                  <SectionCard title="All cited web signals" eyebrow="Inspectable">
                    <SourceList
                      sources={selectedProvider.generalSources}
                      empty="Web enrichment is still loading or did not return provider-specific sources."
                    />
                  </SectionCard>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export function ProviderCompareTray() {
  const {
    comparedProviders,
    toggleCompare,
    openCompare,
  } = useProviderThreadState()

  if (comparedProviders.length === 0) return null

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-28 z-30 flex justify-center px-4">
      <SurfaceCard className="pointer-events-auto w-full max-w-3xl px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {comparedProviders.map((provider) => (
              <button
                key={provider.npi}
                onClick={() => toggleCompare(provider)}
                className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-white/68 transition-colors hover:text-white"
              >
                {provider.displayName}
                <XMarkIcon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
          <button
            onClick={openCompare}
            disabled={comparedProviders.length < 2}
            className={cn(
              'rounded-full px-4 py-2 text-sm font-medium transition-colors',
              comparedProviders.length >= 2
                ? 'bg-[linear-gradient(135deg,#6366F1,#4C1D95)] text-white'
                : 'bg-white/[0.04] text-white/30',
            )}
          >
            Compare providers
          </button>
        </div>
      </SurfaceCard>
    </div>
  )
}

export function ProviderCompareSheet() {
  const {
    isCompareOpen,
    closeCompare,
    comparedProviders,
    compareRows,
  } = useProviderThreadState()

  return (
    <AnimatePresence>
      {isCompareOpen && comparedProviders.length >= 2 ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 z-50 bg-[#030306]/84 p-4 backdrop-blur-xl"
        >
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="mx-auto flex h-full max-w-6xl flex-col"
          >
            <SurfaceCard className="flex h-full flex-col overflow-hidden p-5">
              <div className="mb-5 flex items-center justify-between gap-4">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.24em] text-white/35">Provider comparison</div>
                  <h2 className="mt-2 text-2xl font-medium text-white">Side-by-side provider view</h2>
                </div>
                <button
                  onClick={closeCompare}
                  className="rounded-full border border-white/[0.08] bg-white/[0.03] p-2 text-white/58 transition-colors hover:text-white"
                  aria-label="Close comparison"
                >
                  <XMarkIcon className="h-5 w-5" />
                </button>
              </div>

              <div className="grid gap-3 border-b border-white/[0.06] pb-5 md:grid-cols-[220px,repeat(auto-fit,minmax(0,1fr))]">
                <div />
                {comparedProviders.map((provider) => (
                  <div key={provider.npi} className="rounded-[24px] border border-white/[0.08] bg-white/[0.02] p-4">
                    <div className="flex items-start gap-3">
                      <ProviderAvatar provider={provider} />
                      <div>
                        <div className="text-xs uppercase tracking-[0.18em] text-white/35">{provider.npi}</div>
                        <div className="mt-2 text-lg font-medium text-white">{provider.displayName}</div>
                        <div className="mt-1 text-sm text-white/58">{provider.primaryTaxonomy ?? 'Specialty unavailable'}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex-1 overflow-y-auto pt-5">
                <div className="overflow-x-auto">
                  <div className="min-w-[840px] space-y-2">
                    {compareRows.map((row) => (
                      <div
                        key={row.label}
                        className="grid gap-3 md:grid-cols-[220px,repeat(auto-fit,minmax(0,1fr))]"
                      >
                        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-sm font-medium text-white/72">
                          {row.label}
                        </div>
                        {row.values.map((value, index) => (
                          <div
                            key={`${row.label}-${comparedProviders[index]?.npi ?? index}`}
                            className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-sm leading-relaxed text-white/62"
                          >
                            {value ?? 'Not surfaced'}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </SurfaceCard>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

function ResearchStatusBadge({ job }: { job: ProviderResearchJob | null }) {
  const label = job?.status ?? 'NOT_STARTED'
  const isComplete = label === 'COMPLETED'
  const isProblem = ['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(label)

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.18em]',
        isComplete
          ? 'border-emerald-300/20 bg-emerald-400/10 text-emerald-100'
          : isProblem
            ? 'border-rose-300/20 bg-rose-400/10 text-rose-100'
            : 'border-indigo-300/20 bg-indigo-400/10 text-indigo-100',
      )}
    >
      <span className={cn('h-2 w-2 rounded-full', isComplete ? 'bg-emerald-400' : isProblem ? 'bg-rose-300' : 'bg-indigo-300 animate-pulse')} />
      {label.replaceAll('_', ' ')}
    </div>
  )
}

export function ProviderResearchDossierModal() {
  const {
    selectedProvider,
    selectedResearchJob,
    isResearchOpen,
    closeResearch,
    refreshResearch,
  } = useProviderThreadState()

  return (
    <AnimatePresence>
      {isResearchOpen && selectedProvider ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 z-[60] bg-[#020205]/92 p-4 backdrop-blur-2xl"
        >
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="mx-auto flex h-full max-w-7xl flex-col"
          >
            <SurfaceCard className="flex h-full flex-col overflow-hidden p-5">
              <div className="grid gap-4 border-b border-white/[0.06] pb-5 lg:grid-cols-[340px,1fr,auto]">
                <div className="flex items-start gap-4">
                  <ProviderAvatar provider={selectedProvider} large />
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.24em] text-white/35">Deep research dossier</div>
                    <h2 className="mt-2 text-2xl font-medium text-white">{selectedProvider.displayName}</h2>
                    <p className="mt-2 max-w-sm text-sm leading-relaxed text-white/58">
                      Premium provider research across history, reputation, training, publications, awards, and location footprint.
                    </p>
                    <div className="mt-4">
                      <ResearchStatusBadge job={selectedResearchJob} />
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <ProviderStat
                    icon={<SparklesIcon className="h-5 w-5" />}
                    label="Attempts"
                    value={String(selectedResearchJob?.attempts ?? 0)}
                  />
                  <ProviderStat
                    icon={<ArrowTrendingUpIcon className="h-5 w-5" />}
                    label="Sources analyzed"
                    value={String(selectedResearchJob?.sourcesAnalyzed ?? 0)}
                  />
                  <ProviderStat
                    icon={<MapPinIcon className="h-5 w-5" />}
                    label="Locations"
                    value={String(selectedProvider.locations.length || selectedProvider.mailingLocations.length || 0)}
                  />
                </div>

                <div className="flex items-start gap-3 justify-self-end">
                  <button
                    onClick={() => void refreshResearch(selectedProvider, selectedResearchJob)}
                    className="rounded-full border border-indigo-300/20 bg-indigo-400/10 px-4 py-2 text-sm font-medium text-indigo-100 transition-colors hover:bg-indigo-400/15"
                  >
                    {selectedResearchJob?.requestId ? 'Refresh dossier' : 'Start research'}
                  </button>
                  <button
                    onClick={closeResearch}
                    className="rounded-full border border-white/[0.08] bg-white/[0.03] p-2 text-white/58 transition-colors hover:text-white"
                    aria-label="Close research dossier"
                  >
                    <XMarkIcon className="h-5 w-5" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto pt-5">
                <div className="grid gap-4 xl:grid-cols-[320px,1fr]">
                  <div className="space-y-4">
                    <SectionCard title="Location network" eyebrow="Directions ready">
                      <div className="space-y-3">
                        {(selectedProvider.locations.length > 0 ? selectedProvider.locations : selectedProvider.mailingLocations).map((location) => (
                          <div key={location.id} className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-3">
                            <div className="text-xs uppercase tracking-[0.18em] text-white/35">{location.purpose ?? 'Practice location'}</div>
                            <div className="mt-2 text-sm leading-relaxed text-white">{location.text}</div>
                            <div className="mt-3 flex gap-2">
                              <a
                                href={buildGoogleMapsSearchUrl(location)}
                                target="_blank"
                                rel="noreferrer"
                                className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-white/62 transition-colors hover:text-white"
                              >
                                Open map
                              </a>
                              <a
                                href={buildGoogleMapsDirectionsUrl(location)}
                                target="_blank"
                                rel="noreferrer"
                                className="rounded-full border border-indigo-300/20 bg-indigo-400/10 px-3 py-2 text-xs text-indigo-100 transition-colors hover:bg-indigo-400/15"
                              >
                                Directions
                              </a>
                            </div>
                          </div>
                        ))}
                      </div>
                    </SectionCard>

                    <SectionCard title="Citations" eyebrow="Inspectable">
                      {selectedResearchJob?.citations.length ? (
                        <div className="space-y-2">
                          {selectedResearchJob.citations.map((citation) => (
                            <a
                              key={`${citation.url}-${citation.title}`}
                              href={citation.url}
                              target="_blank"
                              rel="noreferrer"
                              className="group flex items-start justify-between gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 transition-colors hover:border-indigo-300/25 hover:text-white"
                            >
                              <span className="text-sm leading-relaxed text-white/62 group-hover:text-white">{citation.title}</span>
                              <ArrowTopRightOnSquareIcon className="mt-0.5 h-4 w-4 shrink-0 text-white/35" />
                            </a>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm leading-relaxed text-white/48">
                          Citations will populate here once the deep research report is fetched.
                        </p>
                      )}
                    </SectionCard>
                  </div>

                  <div className="space-y-4">
                    <SectionCard title="Narrative report" eyebrow="Perplexity deep research">
                      {selectedResearchJob?.report ? (
                        <div className="prose prose-invert max-w-none prose-p:text-white/70 prose-headings:text-white prose-strong:text-white">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {selectedResearchJob.report}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <p className="text-sm leading-relaxed text-white/52">
                          {selectedResearchJob?.status && selectedResearchJob.status !== 'COMPLETED'
                            ? `Research is still in progress. Current status: ${selectedResearchJob.status}.`
                            : 'Start deep research to generate the long-form provider dossier.'}
                        </p>
                      )}
                    </SectionCard>

                    {selectedResearchJob?.sections.length ? (
                      <div className="grid gap-4 xl:grid-cols-2">
                        {selectedResearchJob.sections.map((section) => (
                          <SectionCard key={section.id} title={section.heading} eyebrow="Report section">
                            <div className="prose prose-invert max-w-none prose-p:text-white/68">
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {section.content}
                              </ReactMarkdown>
                            </div>
                          </SectionCard>
                        ))}
                      </div>
                    ) : null}

                    {selectedResearchJob?.error ? (
                      <SectionCard title="Research error" eyebrow="Needs attention">
                        <p className="text-sm leading-relaxed text-rose-100/80">{selectedResearchJob.error}</p>
                      </SectionCard>
                    ) : null}
                  </div>
                </div>
              </div>
            </SurfaceCard>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export function ProviderEmptyHint({
  onSubmit,
}: {
  onSubmit?: (message: string) => void
}) {
  const suggestions = [
    'Find cardiologists named Sarah Chen in Los Angeles.',
    'Compare orthopedic surgeons in Austin for knee replacement care.',
    'Research a provider by NPI and then open the full profile.',
  ]

  return (
    <div className="flex h-full items-center justify-center px-4">
      <div className="w-full max-w-4xl">
        <div className="mx-auto max-w-2xl text-center">
          <div className="text-[11px] uppercase tracking-[0.28em] text-white/35">Provider intelligence</div>
          <h1 className="mt-4 text-4xl font-light leading-tight text-white">
            Search, compare, and research providers in one workspace.
          </h1>
          <p className="mt-5 text-base leading-relaxed text-white/55">
            The experience is tuned for provider discovery: registry-backed identity first, cited web enrichment second, deep research on demand.
          </p>
        </div>

        <div className="mt-8 grid gap-3 md:grid-cols-3">
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion}
              onClick={() => onSubmit?.(suggestion)}
              disabled={!onSubmit}
              className="rounded-[24px] border border-white/[0.08] bg-white/[0.03] px-4 py-4 text-left text-sm leading-relaxed text-white/62 transition-all hover:-translate-y-0.5 hover:border-indigo-300/20 hover:text-white"
              style={{ animationDelay: `${index * 120}ms` }}
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export { SectionCard, SourceList, ProviderAvatar }
