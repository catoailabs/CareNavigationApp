import asyncio
from agent import build_agent
async def main():
    agent = build_agent()
    async for event in agent.stream_async("test"):
        print(event.get("type"))
        print(event)
        
if __name__ == "__main__":
    asyncio.run(main())
