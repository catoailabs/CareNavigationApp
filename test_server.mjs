import http from 'http'

const server = http.createServer((req, res) => {
  console.log(req.method, req.url, req.headers['content-type'])
  
  let body = ''
  req.on('data', chunk => body += chunk.toString())
  req.on('end', () => {
    console.log('Body:', body.slice(0, 500))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
})

server.listen(3001, () => {
  console.log('Test server listening on 3001')
})
