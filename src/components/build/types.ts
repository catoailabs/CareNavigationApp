export interface Citation {
  label: string
  url: string
  excerpt?: string
}

export interface Source {
  title: string
  url: string
  type: 'web' | 'file' | 'api' | 'code' | 'other'
  favicon?: string
}

export interface TextBlock {
  type: 'text'
  content: string
}

export interface CodeBlock {
  type: 'code'
  language: string
  content: string
  filename?: string
}

export interface PreviewBlock {
  type: 'preview'
  url: string
  title?: string
}

export interface ArtifactBlock {
  type: 'artifact'
  id: string
  name: string
  kind: 'code' | 'image' | 'document' | 'data' | 'other'
  size?: number
}

export interface CitationsBlock {
  type: 'citations'
  items: Citation[]
}

export interface SourcesBlock {
  type: 'sources'
  items: Source[]
}

export interface ToolCallBlock {
  type: 'tool_call'
  toolName: string
  status: 'pending' | 'running' | 'success' | 'error'
  input?: Record<string, unknown>
  output?: string
  error?: string
  duration?: number
}

export interface ReasoningBlock {
  type: 'reasoning'
  summary: string
  details: string
  isComplete?: boolean
}

export type MessageBlock =
  | TextBlock
  | CodeBlock
  | PreviewBlock
  | ArtifactBlock
  | CitationsBlock
  | SourcesBlock
  | ToolCallBlock
  | ReasoningBlock

export interface BuildMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  blocks: MessageBlock[]
  timestamp: number
  isStreaming?: boolean
  /** Tab attachments that persist in sent messages */
  tabAttachments?: Array<{
    id: string
    name: string
    url?: string
    title?: string
    favicon?: string
    screenshotUrl?: string
  }>
}

export interface BuildSession {
  id: string
  agentId: string
  title: string
  createdAt: number
  updatedAt: number
}

export type PlanStepStatus = 'queued' | 'running' | 'done' | 'blocked' | 'error'

export interface PlanStep {
  id: string
  label: string
  status: PlanStepStatus
  notes?: string
}

export interface ExecutionPlan {
  id: string
  title: string
  steps: PlanStep[]
  lastUpdatedAt: string
}

export interface AgentProfile {
  id: string
  name: string
  description: string
  tools: string[]
  avatar?: string
  createdAt?: string
  updatedAt?: string
}

export type ProjectStatus = 'draft' | 'building' | 'ready' | 'error'

export interface ProjectFile {
  path: string
  content?: string
  language?: string
  isFolder?: boolean
  children?: ProjectFile[]
}

export interface CodingProject {
  id: string
  name: string
  description?: string
  previewUrl?: string
  artifactIds: string[]
  files?: ProjectFile[]
  status: ProjectStatus
  createdAt?: string
  updatedAt?: string
}

export type CenterView = 'chat' | 'project'