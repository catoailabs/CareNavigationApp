import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/utils/cn'
import { EnvironmentVariablesSection } from './EnvironmentVariablesSection'
import { GoogleConnectSection } from './GoogleConnectSection'
import {
  Cog6ToothIcon,
  CubeIcon,
  PuzzlePieceIcon,
  DocumentTextIcon,
  CpuChipIcon,
  SwatchIcon,
  ServerIcon,
  LinkIcon,
} from '@heroicons/react/24/outline'

type SettingsSection =
  | 'environment'
  | 'connections'
  | 'tools'
  | 'skills'
  | 'openapi'
  | 'models'
  | 'preferences'
  | 'system'

interface SettingsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const SECTIONS: {
  id: SettingsSection
  label: string
  icon: React.ComponentType<{ className?: string }>
}[] = [
  { id: 'environment', label: 'Environment Variables', icon: ServerIcon },
  { id: 'connections', label: 'Connections', icon: LinkIcon },
  { id: 'tools', label: 'Tools & Connectors', icon: CubeIcon },
  { id: 'skills', label: 'Agent Skills', icon: PuzzlePieceIcon },
  { id: 'openapi', label: 'OpenAPI Specs', icon: DocumentTextIcon },
  { id: 'models', label: 'Models', icon: CpuChipIcon },
  { id: 'preferences', label: 'Preferences', icon: SwatchIcon },
  { id: 'system', label: 'System', icon: Cog6ToothIcon },
]

function PlaceholderSection({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-surface-900/60 p-8 text-center">
      <h3 className="text-lg font-medium text-white">{title}</h3>
      <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-white/55">{description}</p>
    </div>
  )
}

export function SettingsModal({ open, onOpenChange }: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('environment')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className={cn(
          'fixed left-1/2 top-1/2 flex h-[min(92vh,800px)] w-[calc(100%-1.5rem)] -translate-x-1/2 -translate-y-1/2',
          'max-w-none gap-0 p-0',
          'sm:w-[min(96vw,1200px)] sm:max-w-none',
          'lg:w-[min(94vw,1600px)]',
          'overflow-hidden rounded-2xl border-white/[0.08] bg-surface-900/95 text-white shadow-[0_32px_120px_-48px_rgba(0,0,0,0.8)] backdrop-blur-xl',
        )}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        {/* Sidebar */}
        <aside className="flex w-56 flex-col border-r border-white/[0.08] bg-surface-950/50 sm:w-64 lg:w-72">
          <div className="border-b border-white/[0.08] px-5 py-4">
            <h2 className="text-sm font-medium text-white">Settings</h2>
            <p className="mt-1 text-xs text-white/45">Manage your agent workspace</p>
          </div>
          <nav className="flex-1 overflow-y-auto p-3">
            <div className="space-y-1">
              {SECTIONS.map((section) => {
                const Icon = section.icon
                const isActive = activeSection === section.id
                return (
                  <button
                    key={section.id}
                    onClick={() => setActiveSection(section.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors',
                      isActive
                        ? 'bg-indigo-500/15 text-indigo-100'
                        : 'text-white/65 hover:bg-white/[0.05] hover:text-white',
                    )}
                  >
                    <Icon className={cn('h-4 w-4', isActive ? 'text-indigo-300' : 'text-white/45')} />
                    {section.label}
                  </button>
                )
              })}
            </div>
          </nav>
        </aside>

        {/* Content */}
        <main className="flex flex-1 flex-col min-w-0">
          <div className="border-b border-white/[0.08] px-6 py-4">
            <h3 className="text-base font-medium text-white">
              {SECTIONS.find((s) => s.id === activeSection)?.label}
            </h3>
          </div>
          <div className="flex-1 overflow-y-auto p-6">
            {activeSection === 'environment' && <EnvironmentVariablesSection />}
            {activeSection === 'connections' && <GoogleConnectSection />}
            {activeSection === 'tools' && (
              <PlaceholderSection
                title="Tools & Connectors"
                description="Load, unload, and discover tools and MCP servers. This section will surface catalog actions and connector management in the next iteration."
              />
            )}
            {activeSection === 'skills' && (
              <PlaceholderSection
                title="Agent Skills"
                description="Browse SKILL.md files, assign skills to the agent, and manage skill lifecycle. Full wiring is coming in the next phase."
              />
            )}
            {activeSection === 'openapi' && (
              <PlaceholderSection
                title="OpenAPI Specs"
                description="Upload, paste, and convert OpenAPI specs into MCP servers. This section is a placeholder for the upcoming spec management flow."
              />
            )}
            {activeSection === 'models' && (
              <PlaceholderSection
                title="Models"
                description="Configure model providers, default models, and API keys. Model management will be added in a future update."
              />
            )}
            {activeSection === 'preferences' && (
              <PlaceholderSection
                title="Preferences"
                description="Theme, keyboard shortcuts, and display preferences. Preference controls are planned for a future update."
              />
            )}
            {activeSection === 'system' && (
              <PlaceholderSection
                title="System"
                description="View system status, logs, and agent runtime settings. System-level controls will be added in a future update."
              />
            )}
          </div>
        </main>
      </DialogContent>
    </Dialog>
  )
}
