/**
 * Build Workbench - Left Rail
 * Simplified: Only chats and projects (matches SuperAgentInterface aesthetic)
 * Dark Rich Purple accents
 */

import { memo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useBuildStore } from '@/stores/buildStore'
import { cn } from '@/utils/cn'
import { FolderIcon, PlusIcon, ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline'

// Dark rich purple colors
const PURPLE = {
  deep: '#3730A3',
  rich: '#4C1D95',
  vibrant: '#6366F1',
  muted: '#818CF8',
}

// ─────────────────────────────────────────────────────────────────────────────
// Section Header
// ─────────────────────────────────────────────────────────────────────────────

interface SectionHeaderProps {
  title: string
  count?: number
  action?: React.ReactNode
}

const SectionHeader = memo(function SectionHeader({ title, count, action }: SectionHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium text-ink-inverse-muted uppercase tracking-[0.15em]">
          {title}
        </span>
        {count !== undefined && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-800 text-ink-inverse-muted">
            {count}
          </span>
        )}
      </div>
      {action}
    </div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Project Item
// ─────────────────────────────────────────────────────────────────────────────

interface ProjectItemProps {
  id: string
  name: string
  status: string
  isActive: boolean
  onClick: () => void
}

const ProjectItem = memo(function ProjectItem({ name, status, isActive, onClick }: ProjectItemProps) {
  const statusColors: Record<string, string> = {
    ready: 'bg-green-500',
    building: `bg-[${PURPLE.vibrant}] animate-pulse`,
    error: 'bg-red-500',
    idle: 'bg-surface-600',
  }

  return (
    <motion.button
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      onClick={onClick}
      className={cn(
        "group relative w-full p-3 rounded-xl text-left transition-all duration-200",
        isActive
          ? "bg-surface-800 border"
          : "bg-surface-800/30 hover:bg-surface-800/60 border border-transparent hover:border-surface-700"
      )}
      style={isActive ? { borderColor: `${PURPLE.rich}50` } : undefined}
    >
      <div className="relative flex items-center gap-3">
        <div 
          className={cn(
            "w-8 h-8 rounded-lg flex items-center justify-center",
            isActive
              ? "bg-[#4C1D95]/20"
              : "bg-surface-700/50 group-hover:bg-surface-700"
          )}
        >
          <FolderIcon 
            className={cn(
              "w-4 h-4",
              isActive ? "text-[#6366F1]" : "text-ink-inverse-muted group-hover:text-ink-inverse-secondary"
            )} 
          />
        </div>
        
        <div className="flex-1 min-w-0">
          <span className={cn(
            "text-sm font-light truncate block",
            isActive ? "text-ink-inverse" : "text-ink-inverse-secondary group-hover:text-ink-inverse"
          )}>
            {name}
          </span>
        </div>
        
        <span 
          className={cn(
            "w-2 h-2 rounded-full flex-shrink-0",
            statusColors[status] || statusColors.idle
          )} 
          style={status === 'building' ? { backgroundColor: PURPLE.vibrant } : undefined}
        />
      </div>
    </motion.button>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Chat Session Item
// ─────────────────────────────────────────────────────────────────────────────

interface ChatItemProps {
  title: string
  updatedAt: number
  isActive: boolean
  onClick: () => void
}

function formatSessionDate(timestamp: number): string {
  if (!timestamp) return ''
  try {
    const date = new Date(timestamp)
    const now = new Date()
    const isToday = date.toDateString() === now.toDateString()
    
    if (isToday) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

const ChatItem = memo(function ChatItem({ title, updatedAt, isActive, onClick }: ChatItemProps) {
  const timestamp = formatSessionDate(updatedAt)
  return (
    <motion.button
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      onClick={onClick}
      className={cn(
        "group relative w-full p-3 rounded-xl text-left transition-all duration-200",
        isActive
          ? "bg-surface-800 border"
          : "bg-surface-800/30 hover:bg-surface-800/60 border border-transparent hover:border-surface-700"
      )}
      style={isActive ? { borderColor: `${PURPLE.rich}50` } : undefined}
    >
      <div className="relative flex items-center gap-3">
        <div 
          className={cn(
            "w-8 h-8 rounded-lg flex items-center justify-center",
            isActive
              ? "bg-[#4C1D95]/20"
              : "bg-surface-700/50 group-hover:bg-surface-700"
          )}
        >
          <ChatBubbleLeftRightIcon 
            className={cn(
              "w-4 h-4",
              isActive ? "text-[#6366F1]" : "text-ink-inverse-muted group-hover:text-ink-inverse-secondary"
            )} 
          />
        </div>
        <div className="flex-1 min-w-0">
          <span className={cn(
            "text-sm font-light truncate block",
            isActive ? "text-ink-inverse" : "text-ink-inverse-secondary group-hover:text-ink-inverse"
          )}>
            {title}
          </span>
          {timestamp && (
            <span className="text-[10px] text-ink-inverse-muted/60">
              {timestamp}
            </span>
          )}
        </div>
      </div>
    </motion.button>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Projects List
// ─────────────────────────────────────────────────────────────────────────────

const ProjectsList = memo(function ProjectsList() {
  const { projects, activeProjectId, selectProject } = useBuildStore()

  if (projects.length === 0) {
    return (
      <div className="p-4 rounded-xl bg-surface-800/20 border border-surface-800 text-center">
        <p className="text-xs text-ink-inverse-muted font-light">
          No projects yet
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <AnimatePresence mode="popLayout">
        {projects.map((project) => (
          <ProjectItem
            key={project.id}
            id={project.id}
            name={project.name}
            status={project.status}
            isActive={project.id === activeProjectId}
            onClick={() => selectProject(project.id)}
          />
        ))}
      </AnimatePresence>
    </div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Sessions List
// ─────────────────────────────────────────────────────────────────────────────

const SessionsList = memo(function SessionsList() {
  const { sessions, activeSessionId, activeAgentId, setActiveSession, createSession } = useBuildStore()
  const agentId = activeAgentId || 'sandbox-agent'
  const agentSessions = sessions
    .filter((session) => session.agentId === agentId)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)

  if (agentSessions.length === 0) {
    return (
      <div className="p-4 rounded-xl bg-surface-800/20 border border-surface-800 text-center">
        <p className="text-xs text-ink-inverse-muted font-light mb-2">
          No chats yet
        </p>
        <button
          onClick={() => createSession(agentId)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-[#6366F1] hover:bg-[#4C1D95]/20 transition-colors"
          style={{ background: 'rgba(76, 29, 149, 0.1)' }}
        >
          <PlusIcon className="w-3.5 h-3.5" />
          Start new chat
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <AnimatePresence mode="popLayout">
        {agentSessions.map((session) => (
          <ChatItem
            key={session.id}
            title={session.title}
            updatedAt={session.updatedAt}
            isActive={session.id === activeSessionId}
            onClick={() => setActiveSession(session.id)}
          />
        ))}
      </AnimatePresence>
    </div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Main Left Rail Component
// ─────────────────────────────────────────────────────────────────────────────

export function LeftRail() {
  const { projects, sessions, activeAgentId, createSession } = useBuildStore()
  const agentId = activeAgentId || 'sandbox-agent'
  const sessionCount = sessions.filter((session) => session.agentId === agentId).length

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-700/50">
        
        <SectionHeader
          title="Chats"
          count={sessionCount}
          action={
            <button
              onClick={() => createSession(agentId)}
              className="p-1.5 rounded-lg text-ink-inverse-muted hover:text-[#6366F1] hover:bg-[#4C1D95]/10 transition-colors"
              title="New chat"
              aria-label="New chat"
            >
              <PlusIcon className="w-4 h-4" />
            </button>
          }
        />
        <SessionsList />

        <div className="mt-6" />
        <SectionHeader 
          title="Projects" 
          count={projects.length}
        />
        <ProjectsList />
        
        <div className="h-8" />
      </div>
      
      <div className="flex-none h-8 bg-gradient-to-t from-surface-900 to-transparent pointer-events-none" />
    </div>
  )
}
