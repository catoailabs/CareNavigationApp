import { DefaultChatTransport } from 'ai'
const transport = new DefaultChatTransport({ api: 'http://localhost:3001/api/chat' })
const messages = [{
  id: '1',
  role: 'user',
  content: 'Hello',
  parts: [
    { type: 'text', text: 'Hello' },
    { type: 'file', url: 'data:image/png;base64,123', mediaType: 'image/png', filename: 'image.png' }
  ]
}]
transport.sendMessages({ messages, trigger: 'submit-message', chatId: '1' }).catch(e => console.error(e))
