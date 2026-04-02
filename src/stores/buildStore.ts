import { create } from 'zustand'
import type { BuildMessage, BuildSession, CodingProject } from '@/components/build/types'

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

type BuildStore = {
  sessions: BuildSession[];
  projects: CodingProject[];
  messages: Record<string, BuildMessage[]>;
  activeSessionId: string | null;
  activeProjectId: string | null;
  activeAgentId: string | null;
  isStreaming: boolean;
  navigationCounter: number;
  
  activeMessages: () => BuildMessage[];
  incrementNavigation: () => void;
  ensureActiveSession: () => void;
  createSession: (agentId: string) => void;
  setActiveSession: (id: string) => void;
  selectProject: (id: string) => void;
  addUserMessage: (text: string, tabAttachments?: BuildMessage['tabAttachments']) => void;
  appendAssistantMessageChunk: (text: string) => void;
  finalizeAssistantMessage: () => void;
  setStreaming: (isStreaming: boolean) => void;
  recordSessionPrompt: (text: string) => void;
};

export const useBuildStore = create<BuildStore>((set, get) => ({
  sessions: [],
  projects: [],
  messages: {},
  activeSessionId: null,
  activeProjectId: null,
  activeAgentId: 'provider_research_agent',
  isStreaming: false,
  navigationCounter: 0,

  activeMessages: () => {
    const state = get()
    if (!state.activeSessionId) return []
    return state.messages[state.activeSessionId] || []
  },

  incrementNavigation: () => set((state) => ({ navigationCounter: state.navigationCounter + 1 })),
  
  ensureActiveSession: () => {
    const state = get()
    if (!state.activeSessionId && state.activeAgentId) {
      state.createSession(state.activeAgentId)
    }
  },

  createSession: (agentId: string) => {
    const id = generateId()
    const newSession: BuildSession = {
      id,
      agentId,
      title: 'New chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    set((state) => ({
      sessions: [newSession, ...state.sessions],
      activeSessionId: id,
      messages: { ...state.messages, [id]: [] }
    }))
  },

  setActiveSession: (id: string) => set({ activeSessionId: id }),
  selectProject: (id: string) => set({ activeProjectId: id }),

  addUserMessage: (text: string, tabAttachments?: BuildMessage['tabAttachments']) => {
    const state = get()
    const sessionId = state.activeSessionId
    if (!sessionId) return

    const newMessage: BuildMessage = {
      id: generateId(),
      role: 'user',
      blocks: [{ type: 'text', content: text }],
      timestamp: Date.now(),
      tabAttachments: tabAttachments?.length ? tabAttachments : undefined,
    }

    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: [...(state.messages[sessionId] || []), newMessage]
      }
    }))
  },

  appendAssistantMessageChunk: (text: string) => {
    const state = get()
    const sessionId = state.activeSessionId
    if (!sessionId) return

    set((state) => {
      const sessionMessages = state.messages[sessionId] || []
      const lastMessage = sessionMessages[sessionMessages.length - 1]

      if (lastMessage && lastMessage.role === 'assistant' && lastMessage.isStreaming) {
        // Append to existing streaming message
        const newBlocks = [...lastMessage.blocks]
        const textBlock = newBlocks.find(b => b.type === 'text')
        if (textBlock && textBlock.type === 'text') {
            textBlock.content += text
        } else {
            newBlocks.push({ type: 'text', content: text })
        }
        
        const updatedMessage = { ...lastMessage, blocks: newBlocks }
        return {
          messages: {
            ...state.messages,
            [sessionId]: [...sessionMessages.slice(0, -1), updatedMessage]
          }
        }
      } else {
        // Create new streaming message
        const newMessage: BuildMessage = {
          id: generateId(),
          role: 'assistant',
          blocks: [{ type: 'text', content: text }],
          timestamp: Date.now(),
          isStreaming: true,
        }
        return {
          messages: {
            ...state.messages,
            [sessionId]: [...sessionMessages, newMessage]
          }
        }
      }
    })
  },

  finalizeAssistantMessage: () => {
    const state = get()
    const sessionId = state.activeSessionId
    if (!sessionId) return

    set((state) => {
      const sessionMessages = state.messages[sessionId] || []
      const lastMessage = sessionMessages[sessionMessages.length - 1]

      if (lastMessage && lastMessage.role === 'assistant' && lastMessage.isStreaming) {
        const updatedMessage = { ...lastMessage, isStreaming: false }
        return {
          messages: {
            ...state.messages,
            [sessionId]: [...sessionMessages.slice(0, -1), updatedMessage]
          }
        }
      }
      return state
    })
  },

  setStreaming: (isStreaming: boolean) => set({ isStreaming }),

  recordSessionPrompt: (text: string) => {
    const sessionId = get().activeSessionId
    if (!sessionId) return

    const normalizedTitle = text
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 72)

    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session
        const existingTitle = session.title.trim()
        return {
          ...session,
          title: existingTitle === 'New chat' && normalizedTitle ? normalizedTitle : existingTitle,
          updatedAt: Date.now(),
        }
      }),
    }))
  },
}));
