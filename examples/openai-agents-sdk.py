"""Mercantry as an MCP server for the OpenAI Agents SDK.

    pip install openai-agents
    export OPENAI_API_KEY=sk-...
    python openai-agents-sdk.py

The registry needs no credential of its own: reads and sandbox bookings are
unauthenticated. A developer key is optional (attribution + abuse control) and
goes in the `headers` dict below if you want your calls attributed.
"""

import asyncio
import os

from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp

REGISTRY = os.environ.get("REGISTRY_BASE", "https://agentic-commerce-registry.fly.dev")

# The instructions are where the registry's contract becomes the agent's
# behavior. Each line below prevents a specific, real failure:
#   - the sandbox rule stops a simulated confirmation being relayed as real;
#   - the idempotency rule stops a retried timeout double-booking a restaurant;
#   - the ranking note stops the model treating result order as a quality signal.
INSTRUCTIONS = """You help people find restaurants and book tables using the Mercantry registry.

Rules that matter:
- Search is filter-based and NEVER ranked. Result order is deterministic
  (merchant_id, or distance when a geo filter is used) and carries no quality
  signal. Read the raw fields and form your own judgement.
- Every merchant record has a `sandbox` flag. Sandbox merchants are test
  fixtures: they return SIMULATED confirmations and never dial a real venue.
  Pass sandbox=false for anything a user will act on, and never present a
  sandbox confirmation as a real reservation.
- place_booking is asynchronous: it returns state "queued" immediately. Poll
  get_booking_status for the outcome; do not assume success.
- ALWAYS pass a unique client_reference_id to place_booking. If a call times
  out, retry with the SAME value — that returns the existing booking instead
  of booking the restaurant twice. Never retry without one.
- A naive datetime means the MERCHANT's local wall clock, not the user's.
  Check the merchant's `timezone` before you translate a user's time.
- Cancel bookings the user abandons. No-shows are tracked and throttled.
"""


async def main() -> None:
    async with MCPServerStreamableHttp(
        name="mercantry",
        params={
            "url": f"{REGISTRY}/mcp",
            # "headers": {"Authorization": "Bearer reg_your_key_here"},
        },
        # Tool definitions are stable between calls; cache instead of re-listing.
        cache_tools_list=True,
    ) as registry:
        agent = Agent(
            name="Restaurant concierge",
            instructions=INSTRUCTIONS,
            mcp_servers=[registry],
        )

        result = await Runner.run(
            agent,
            "Find a bookable restaurant that seats 2, then show me its full "
            "record — including where each field came from and how stale it is.",
        )
        print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
