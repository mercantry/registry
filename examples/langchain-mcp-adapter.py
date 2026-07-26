"""Mercantry as LangChain tools, via the MCP adapter.

    pip install langchain-mcp-adapters langgraph langchain-anthropic
    export ANTHROPIC_API_KEY=sk-ant-...
    python langchain-mcp-adapter.py

`load_mcp_tools` turns every registry MCP tool into a LangChain tool with its
schema and description intact — the descriptions are written for model tool
selection (REQ-MCP-6), so leave them alone rather than paraphrasing.
"""

import asyncio
import os

from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_anthropic import ChatAnthropic
from langgraph.prebuilt import create_react_agent

REGISTRY = os.environ.get("REGISTRY_BASE", "https://agentic-commerce-registry.fly.dev")

SYSTEM = """Use the Mercantry registry for restaurant data and bookings.

- Search is never ranked: order is deterministic and means nothing about
  quality. Judge from the raw fields.
- Respect the `sandbox` flag. Sandbox merchants return SIMULATED confirmations
  and never dial a real venue — pass sandbox=false for real work, and never
  relay a sandbox confirmation as a real reservation.
- place_booking is async (returns "queued"); poll get_booking_status.
- Always send a unique client_reference_id; on a timeout, retry with the SAME
  one so a retry cannot double-book the restaurant.
- Naive datetimes are the merchant's local wall clock — check `timezone`.
"""


async def main() -> None:
    client = MultiServerMCPClient(
        {
            "mercantry": {
                "transport": "streamable_http",
                "url": f"{REGISTRY}/mcp",
                # "headers": {"Authorization": "Bearer reg_your_key_here"},
            }
        }
    )

    tools = await client.get_tools()
    print("registry tools:", [t.name for t in tools])

    agent = create_react_agent(
        ChatAnthropic(model="claude-sonnet-4-5"),
        tools,
        prompt=SYSTEM,
    )

    result = await agent.ainvoke(
        {
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "Which cities does this registry cover, how stale is the "
                        "data, and how many merchants can it actually book?"
                    ),
                }
            ]
        }
    )
    print(result["messages"][-1].content)


if __name__ == "__main__":
    asyncio.run(main())
