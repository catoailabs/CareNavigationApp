import { useMemo } from 'react'

const MENTION_RE = /@(env|tool|connector|skill|openapi|toolset):[A-Za-z0-9_-]+/g

export function usePromptMentions() {
  const extractMentions = (text: string): string[] => {
    const matches = text.match(MENTION_RE) ?? []
    return Array.from(new Set(matches))
  }

  return useMemo(
    () => ({
      extractMentions,
    }),
    [],
  )
}
