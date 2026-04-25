import { createServer } from 'http'
const s = createServer((req, res) => {
  let body = ''
  req.on('data', c => body += c)
  req.on('end', () => {
    console.log(body)
    res.end()
  })
})
s.listen(3002)
