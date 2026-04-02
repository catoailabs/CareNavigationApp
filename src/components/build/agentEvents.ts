import { useBuildStore } from '@/stores/buildStore'

export const startBuildAgentStream = async (text: string) => {
  const { appendAssistantMessageChunk, finalizeAssistantMessage, setStreaming } = useBuildStore.getState()
  
  setStreaming(true)
  
  // Simulate network delay
  await new Promise(resolve => setTimeout(resolve, 600))
  
  const responseText = "Here is a simulated response to: *" + text + "*\n\nI am the **Healthcare Agent** running in this local environment. You can see my markdown rendering working seamlessly here. I can also output code:\n\n```typescript\nfunction heal() {\n  return 'health +100';\n}\n```"
  const words = responseText.split(' ')
  
  // Stream words
  for (let i = 0; i < words.length; i++) {
    appendAssistantMessageChunk(words[i] + (i === words.length - 1 ? '' : ' '))
    await new Promise(resolve => setTimeout(resolve, 50)) // 50ms per word
  }
  
  finalizeAssistantMessage()
  setStreaming(false)
}

export const initAgentEventStream = () => () => {};
export const cleanupAgentEventStream = () => {};