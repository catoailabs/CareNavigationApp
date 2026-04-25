import { create } from 'zustand'
import type { BuildSession, CodingProject } from '@/components/build/types'

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

type BuildStore = {
  sessions: BuildSession[];
  projects: CodingProject[];
  activeSessionId: string | null;
  activeProjectId: string | null;
  activeAgentId: string | null;
  navigationCounter: number;

  incrementNavigation: () => void;
  ensureActiveSession: () => void;
  createSession: (agentId: string) => void;
  setActiveSession: (id: string) => void;
  selectProject: (id: string) => void;
  recordSessionPrompt: (text: string) => void;
};

export const useBuildStore = create<BuildStore>((set, get) => ({
  sessions: [],
  projects: [],
  activeSessionId: null,
  activeProjectId: null,
  activeAgentId: 'provider_research_agent',
  navigationCounter: 0,

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
    }))
  },

  setActiveSession: (id: string) => set({ activeSessionId: id }),
  selectProject: (id: string) => set({ activeProjectId: id }),

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
