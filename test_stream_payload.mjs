import { DefaultChatTransport } from 'ai'
const transport = new DefaultChatTransport({ api: '/api/chat' })
const messages = [{
  role: 'user',
  content: 'Hello',
  data: { metadata: 'meta' }
}]
transport.sendMessages({ messages, trigger: 'submit-message', chatId: '1' }).catch(() => {})
