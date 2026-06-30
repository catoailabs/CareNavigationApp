import type { FileUIPart, UIMessage } from 'ai'
import type { ContextItem } from '@/components/agent-panel/ContextPicker'

export type ProviderTabAttachment = Pick<
  ContextItem,
  | 'id'
  | 'type'
  | 'name'
  | 'description'
  | 'favicon'
  | 'url'
  | 'title'
  | 'screenshotUrl'
  | 'pageContent'
  | 'navigationInfo'
>

export interface ProviderMessageMetadata {
  displayText?: string
  tabAttachments?: ProviderTabAttachment[]
}

export type ProviderChatMessage = UIMessage<ProviderMessageMetadata>

export type ProviderComposerFile = FileUIPart & { id: string }

export interface ProviderComposerSubmitPayload {
  displayText: string
  files: ProviderComposerFile[]
  promptText: string
  tabAttachments: ProviderTabAttachment[]
  mentions?: string[]
}
