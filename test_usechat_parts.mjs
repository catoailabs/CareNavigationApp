import { DefaultChatTransport, useChat } from 'ai'

const transport = new DefaultChatTransport({ api: 'http://localhost:3005/api/chat' })
const messages = [{
  id: '1',
  role: 'user',
  // Send what we put in CenterPane.tsx
  parts: [
    { type: 'text', text: 'Hello from parts' }
  ]
}]

global.fetch = async (url, init) => {
  console.log("PAYLOAD:", init.body)
  return {
    ok: true,
    body: new ReadableStream({ start(c) { c.close() } }),
    headers: new Map()
  }
}
transport.sendMessages({ messages, trigger: 'submit-message', chatId: '1' }).catch(console.error)
