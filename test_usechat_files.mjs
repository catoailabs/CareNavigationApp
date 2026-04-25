import { DefaultChatTransport } from 'ai'

const transport = new DefaultChatTransport({ api: 'http://localhost:3005/api/chat' })

// This simulates what Vercel AI SDK does internally when we call
// sendMessage({ text: 'Hello', files: [...] })
const messages = [{
  id: '1',
  role: 'user',
  // IT GENERATES CONTENT AS A STRING AND ADDS EXPERIMENTAL_ATTACHMENTS OR FILES
  content: 'Hello from Vercel AI SDK text field',
  experimental_attachments: [
    { url: '...', contentType: 'image/png' }
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
