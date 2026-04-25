import json
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
import uvicorn
import asyncio

app = FastAPI()

@app.post("/api/chat")
async def chat_endpoint(request: Request):
    body = await request.json()
    print("RECEIVED BODY:", json.dumps(body, indent=2))
    async def stream():
        yield "data: {\"type\": \"text-delta\", \"delta\": \"Got it\"}\n\n"
    return StreamingResponse(stream(), media_type="text/event-stream")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
