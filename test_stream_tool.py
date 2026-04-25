import asyncio
from agent import build_agent
async def main():
    agent = build_agent()
    async for event in agent.stream_async("check environment variables with shell tool"):
        print(event.get("type"))
        print(list(event.keys()))
        
if __name__ == "__main__":
    asyncio.run(main())
