from strands import Agent
from strands_xai import xAIModel
import asyncio
import os

os.environ["XAI_API_KEY"] = "dummy"

async def test():
    model = xAIModel(model_id="grok-4.20-0309-reasoning", client_args={"api_key": "dummy"})
    agent = Agent(model=model, system_prompt="Test")
    prompt = [{"type": "text", "text": "Hello"}]
    
    try:
        # Just to see if stream_async accepts the prompt format
        async for e in agent.stream_async(prompt):
            pass
    except Exception as e:
        print(f"Error: {e}")

asyncio.run(test())
