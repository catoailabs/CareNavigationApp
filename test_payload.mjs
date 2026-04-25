import { DefaultChatTransport } from 'ai'
const transport = new DefaultChatTransport({ api: 'http://localhost/api/chat' })
const messages = [{
  id: '1',
  role: 'user',
  content: 'Hello',
  parts: [
    { type: 'text', text: 'Hello' }
  ]
}]

// Mock fetch to capture payload
global.fetch = async (url, init) => {
  console.log("PAYLOAD:", init.body)
  return {
    ok: true,
    body: new ReadableStream({ start(c) { c.close() } }),
    headers: new Map()
  }
}

transport.sendMessages({ messages, trigger: 'submit-message', chatId: '1' }).catch(console.error)
