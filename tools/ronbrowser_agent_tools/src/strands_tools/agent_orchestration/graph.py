"""Graph tool using new Strands SDK Graph implementation.

This module provides functionality to create and manage multi-agent systems
using the new Strands SDK Graph implementation. Unlike the old message-passing approach,
this uses deterministic DAG execution with output propagation.

Usage with Strands Agent:

```python
from strands import Agent
from graph import graph

agent = Agent(tools=[graph])

# Create a agent graph
result = agent.tool.graph(
    action="create",
    graph_id="analysis_pipeline",
    topology={
        "nodes": [
            {
                "id": "researcher",
                "role": "researcher",
                "system_prompt": "You research topics thoroughly.",
                "model_provider": "bedrock",
                "model_settings": {"model_id": "us.anthropic.claude-sonnet-4-20250514-v1:0"}
            },
            {
                "id": "analyst",
                "role": "analyst",
                "system_prompt": "You analyze research data.",
                "model_provider": "bedrock",
                "model_settings": {"model_id": "us.anthropic.claude-3-5-haiku-20241022-v1:0"}
            },
            {
                "id": "reporter",
                "role": "reporter",
                "system_prompt": "You create comprehensive reports.",
                "tools": ["file_write", "editor"]
            }
        ],
        "edges": [
            {"from": "researcher", "to": "analyst"},
            {"from": "analyst", "to": "reporter"}
        ],
        "entry_points": ["researcher"]
    }
)

# Execute a task through the graph
result = agent.tool.graph(
    action="execute",
    graph_id="analysis_pipeline",
    task="Research and analyze the impact of AI on healthcare"
)
```
"""

import logging
import time
import traceback
from typing import Any, AsyncIterator, Dict, List, Optional

from rich.box import ROUNDED
from rich.console import Console
from rich.panel import Panel
from strands import Agent, tool
from strands.multiagent.graph import GraphBuilder

from strands_tools.utils import console_util
from strands_tools.utils.models.model import create_model

logger = logging.getLogger(__name__)


def create_rich_status_panel(console: Console, status: Dict) -> str:
    """Create a rich formatted status panel"""
    content = []
    content.append(f"[bold blue]Graph ID:[/bold blue] {status['graph_id']}")
    content.append(f"[bold blue]Total Nodes:[/bold blue] {status['total_nodes']}")
    content.append(
        f"[bold blue]Entry Points:[/bold blue] {', '.join([ep['node_id'] for ep in status['entry_points']])}"
    )
    content.append(f"[bold blue]Status:[/bold blue] {status['execution_status']}")

    if status.get("last_execution"):
        exec_info = status["last_execution"]
        content.append("\n[bold magenta]Last Execution:[/bold magenta]")
        content.append(f"  [bold green]Completed Nodes:[/bold green] {exec_info['completed_nodes']}")
        content.append(f"  [bold green]Failed Nodes:[/bold green] {exec_info['failed_nodes']}")
        content.append(f"  [bold green]Execution Time:[/bold green] {exec_info['execution_time']}ms")

    content.append("\n[bold magenta]Nodes:[/bold magenta]")
    for node_info in status["nodes"]:
        node_content = [
            f"  [bold green]ID:[/bold green] {node_info['id']}",
            f"  [bold green]Role:[/bold green] {node_info['role']}",
            f"  [bold green]Model:[/bold green] {node_info.get('model_provider', 'default')}",
            f"  [bold green]Tools:[/bold green] {node_info.get('tools_count', 'default')}",
            f"  [bold green]Dependencies:[/bold green] {len(node_info.get('dependencies', []))}",
            "",
        ]
        content.extend(node_content)

    panel = Panel("\n".join(content), title="Graph Status", box=ROUNDED)
    with console.capture() as capture:
        console.print(panel)
    return capture.get()


def create_agent_with_model(
    system_prompt: str,
    model_provider: Optional[str] = None,
    model_settings: Optional[Dict[str, Any]] = None,
    tools: Optional[List[str]] = None,
    parent_agent: Optional[Agent] = None,
) -> Agent:
    """Create an Agent with custom model configuration.

    Args:
        system_prompt: System prompt for the new agent
        model_provider: Model provider to use
        model_settings: Custom model settings
        tools: List of tool names to include
        parent_agent: Parent agent to inherit from

    Returns:
        Configured Agent instance
    """
    # Create model
    model = create_model(provider=model_provider or "default", config=model_settings or {})

    # Determine tools
    agent_tools = []
    if parent_agent:
        if tools:
            # Filter parent agent tools to only include specified tool names
            for tool_name in tools:
                if tool_name in parent_agent.tool_registry.registry:
                    agent_tools.append(parent_agent.tool_registry.registry[tool_name])
                else:
                    logger.warning(f"Tool '{tool_name}' not found in parent agent's tool registry")
        else:
            # Use all parent agent tools
            agent_tools = list(parent_agent.tool_registry.registry.values())

    # Create and return agent
    kwargs = {}
    if parent_agent:
        kwargs["trace_attributes"] = parent_agent.trace_attributes
        kwargs["callback_handler"] = parent_agent.callback_handler

    return Agent(system_prompt=system_prompt, model=model, tools=agent_tools, **kwargs)


class GraphManager:
    """Manager for SDK-based Graph instances"""

    def __init__(self):
        self.graphs: Dict[str, Dict] = {}  # graph_id -> {graph: Graph, metadata: dict}

    def create_graph(
        self,
        graph_id: str,
        topology: Dict,
        parent_agent: Agent,
        model_provider: Optional[str] = None,
        model_settings: Optional[Dict[str, Any]] = None,
        tools: Optional[List[str]] = None,
    ) -> Dict:
        """Create a new Graph using SDK GraphBuilder"""

        if graph_id in self.graphs:
            return {"status": "error", "message": f"Graph {graph_id} already exists"}

        try:
            # Create GraphBuilder
            builder = GraphBuilder()

            # Create agents for each node
            node_agents = {}
            for node_def in topology["nodes"]:
                # Determine effective configuration for this node
                effective_model_provider = node_def.get("model_provider") or model_provider
                effective_model_settings = node_def.get("model_settings") or model_settings
                effective_tools = node_def.get("tools") or tools

                # Create specialized agent for this node
                if effective_model_provider or effective_model_settings:
                    # Create agent with custom model configuration
                    node_agent = create_agent_with_model(
                        system_prompt=node_def["system_prompt"],
                        model_provider=effective_model_provider,
                        model_settings=effective_model_settings,
                        tools=effective_tools,
                        parent_agent=parent_agent,
                    )
                else:
                    # Create basic agent with parent agent's model and tools
                    # Get all tools from parent agent if no specific tools configuration
                    parent_tools = (
                        list(parent_agent.tool_registry.registry.values()) if parent_agent.tool_registry else []
                    )
                    node_agent = Agent(
                        system_prompt=node_def["system_prompt"],
                        model=parent_agent.model,
                        tools=parent_tools,
                    )

                node_agents[node_def["id"]] = node_agent

                # Add node to builder
                builder.add_node(node_agent, node_def["id"])

            # Add edges
            for edge in topology.get("edges", []):
                builder.add_edge(edge["from"], edge["to"])

            # Set entry points
            for entry_point in topology.get("entry_points", []):
                builder.set_entry_point(entry_point)

            # Build the graph
            graph = builder.build()

            # Store graph with metadata
            self.graphs[graph_id] = {
                "graph": graph,
                "metadata": {
                    "graph_id": graph_id,
                    "created_at": time.time(),
                    "node_count": len(topology["nodes"]),
                    "edge_count": len(topology.get("edges", [])),
                    "entry_points": topology.get("entry_points", []),
                    "topology": topology,
                    "last_execution": None,
                },
            }

            return {
                "status": "success",
                "message": f"Graph {graph_id} created successfully with {len(topology['nodes'])} nodes",
            }

        except Exception as e:
            logger.error(f"Error creating graph {graph_id}: {str(e)}")
            return {"status": "error", "message": f"Error creating graph: {str(e)}"}

    async def stream_graph(self, graph_id: str, task: str) -> AsyncIterator[Dict[str, Any]]:
        """Stream a graph execution, yielding each SDK Graph event verbatim.

        Mirrors ``Graph.stream(input, options?)``: async generator yielding
        ``MultiAgentStreamEvent`` dicts (node start/stream/stop, handoff) and a
        final ``multiagent_result`` envelope carrying the ``MultiAgentResult``.
        """
        graph_info = self.graphs[graph_id]
        graph = graph_info["graph"]
        start_time = time.time()
        async for event in graph.stream_async(task):
            yield event

    def get_graph_status(self, graph_id: str) -> Dict:
        """Get status of a specific graph"""

        if graph_id not in self.graphs:
            return {"status": "error", "message": f"Graph {graph_id} not found"}

        try:
            graph_info = self.graphs[graph_id]
            metadata = graph_info["metadata"]
            topology = metadata["topology"]

            # Build status information
            status = {
                "graph_id": graph_id,
                "total_nodes": metadata["node_count"],
                "entry_points": [{"node_id": ep} for ep in metadata["entry_points"]],
                "execution_status": "ready",
                "last_execution": metadata.get("last_execution"),
                "nodes": [],
            }

            # Add node information
            for node_def in topology["nodes"]:
                node_info = {
                    "id": node_def["id"],
                    "role": node_def["role"],
                    "model_provider": node_def.get("model_provider", "default"),
                    "tools_count": (len(node_def.get("tools", [])) if node_def.get("tools") else "default"),
                    "dependencies": [],
                }

                # Find dependencies for this node
                for edge in topology.get("edges", []):
                    if edge["to"] == node_def["id"]:
                        node_info["dependencies"].append(edge["from"])

                status["nodes"].append(node_info)

            return {"status": "success", "data": status}

        except Exception as e:
            logger.error(f"Error getting graph status {graph_id}: {str(e)}")
            return {
                "status": "error",
                "message": f"Error getting graph status: {str(e)}",
            }

    def list_graphs(self) -> Dict:
        """List all graphs"""

        try:
            graphs_list = []
            for graph_id, graph_info in self.graphs.items():
                metadata = graph_info["metadata"]
                graph_summary = {
                    "graph_id": graph_id,
                    "node_count": metadata["node_count"],
                    "edge_count": metadata["edge_count"],
                    "entry_points": len(metadata["entry_points"]),
                    "created_at": metadata["created_at"],
                    "last_executed": (
                        metadata.get("last_execution", {}).get("timestamp") if metadata.get("last_execution") else None
                    ),
                }
                graphs_list.append(graph_summary)

            return {"status": "success", "data": graphs_list}

        except Exception as e:
            logger.error(f"Error listing graphs: {str(e)}")
            return {"status": "error", "message": f"Error listing graphs: {str(e)}"}

    def delete_graph(self, graph_id: str) -> Dict:
        """Delete a graph"""

        if graph_id not in self.graphs:
            return {"status": "error", "message": f"Graph {graph_id} not found"}

        try:
            del self.graphs[graph_id]
            return {
                "status": "success",
                "message": f"Graph {graph_id} deleted successfully",
            }

        except Exception as e:
            logger.error(f"Error deleting graph {graph_id}: {str(e)}")
            return {"status": "error", "message": f"Error deleting graph: {str(e)}"}


# Global manager instance
_manager = GraphManager()


@tool
async def graph(
    action: str,
    graph_id: Optional[str] = None,
    topology: Optional[Dict] = None,
    task: Optional[str] = None,
    model_provider: Optional[str] = None,
    model_settings: Optional[Dict[str, Any]] = None,
    tools: Optional[List[str]] = None,
    agent: Optional[Any] = None,
) -> AsyncIterator[Dict[str, Any]]:
    """Create and manage multi-agent graphs using Strands SDK Graph implementation.

    This function provides functionality to create and manage multi-agent systems using
    the new Strands SDK Graph implementation. Unlike the old message-passing approach,
    this uses deterministic DAG (Directed Acyclic Graph) execution with output propagation.

    How It Works:
    ------------
    1. Creates graphs where agents are nodes with dependency relationships
    2. Execution follows topological order based on dependencies
    3. Output from one agent propagates as input to dependent agents
    4. Supports conditional routing and parallel execution where possible
    5. Each agent can use different model providers and configurations

    Key Differences from Old agent_graph:
    -----------------------------------
    - **Execution Model**: Task execution vs persistent message-passing
    - **Communication**: Output propagation vs real-time message queues
    - **Lifecycle**: Task-based execution vs long-running agent networks
    - **Architecture**: Uses SDK Graph classes vs custom implementation

    Args:
        action: Action to perform with the graph.
            Options: "create", "execute", "status", "list", "delete"
        graph_id: Unique identifier for the graph (required for most actions).
        topology: Graph topology definition (required for create).
            Format: {
                "nodes": [
                    {
                        "id": str,
                        "role": str,
                        "system_prompt": str,
                        "model_provider": str (optional),
                        "model_settings": dict (optional),
                        "tools": list[str] (optional)
                    }, ...
                ],
                "edges": [{"from": str, "to": str}, ...],
                "entry_points": [str, ...] (optional, auto-detected if not provided)
            }
        task: Task to execute through the graph (required for execute action).
        model_provider: Default model provider for all agents in the graph.
            Individual nodes can override this with their own model_provider.
            Options: "bedrock", "anthropic", "litellm", "ollama", "openai", etc.
        model_settings: Default model configuration for all agents.
            Individual nodes can override this with their own model_settings.
            Example: {"model_id": "us.anthropic.claude-sonnet-4-20250514-v1:0"}
        tools: Default list of tool names for all agents.
            Individual nodes can override this with their own tools list.
        agent: The parent agent (automatically passed by Strands framework).

    Returns:
        Dict containing status and response content in the format:
        {
            "status": "success|error",
            "content": [{"text": "Operation result message"}]
        }

    Examples:
    --------
    # Create a research pipeline
    result = agent.tool.graph(
        action="create",
        graph_id="research_pipeline",
        topology={
            "nodes": [
                {
                    "id": "researcher",
                    "role": "researcher",
                    "system_prompt": "You research topics thoroughly.",
                    "model_provider": "bedrock",
                    "model_settings": {"model_id": "us.anthropic.claude-sonnet-4-20250514-v1:0"}
                },
                {
                    "id": "analyst",
                    "role": "analyst",
                    "system_prompt": "You analyze research data.",
                    "model_provider": "bedrock",
                    "model_settings": {"model_id": "us.anthropic.claude-3-5-haiku-20241022-v1:0"}
                },
                {
                    "id": "reporter",
                    "role": "reporter",
                    "system_prompt": "You create comprehensive reports.",
                    "tools": ["file_write", "editor"]
                }
            ],
            "edges": [
                {"from": "researcher", "to": "analyst"},
                {"from": "analyst", "to": "reporter"}
            ],
            "entry_points": ["researcher"]
        }
    )

    # Execute a task through the graph
    result = agent.tool.graph(
        action="execute",
        graph_id="research_pipeline",
        task="Research and analyze the impact of AI on healthcare"
    )

    # Get graph status
    result = agent.tool.graph(action="status", graph_id="research_pipeline")

    # List all graphs
    result = agent.tool.graph(action="list")

    # Delete a graph
    result = agent.tool.graph(action="delete", graph_id="research_pipeline")

    Notes:
        - Graphs execute tasks deterministically based on DAG structure
        - Entry points receive the original task; other nodes receive dependency outputs
        - Per-node model and tool configuration enables optimization and specialization
        - Execution is task-based rather than persistent like the old agent_graph
        - Uses the new Strands SDK Graph implementation for reliability and performance
    """
    console = console_util.create()

    try:
        if action == "execute":
            if not graph_id or not task:
                yield {
                    "status": "error",
                    "content": [{"text": "graph_id and task are required for execute action"}],
                }
                return

            # One-shot ergonomics: auto-create from topology when not yet built.
            if graph_id not in _manager.graphs:
                if not topology:
                    yield {
                        "status": "error",
                        "content": [{"text": f"Graph {graph_id} not found; pass topology to create it"}],
                    }
                    return
                if agent is None:
                    yield {
                        "status": "error",
                        "content": [{"text": "A parent agent is required to create the graph"}],
                    }
                    return
                create = _manager.create_graph(graph_id, topology, agent, model_provider, model_settings, tools)
                if create["status"] != "success":
                    yield {"status": "error", "content": [{"text": create["message"]}]}
                    return

            graph_meta = _manager.graphs[graph_id]["metadata"]["topology"]
            yield {"type": "graph_topology", "graph_id": graph_id, "topology": graph_meta}

            start_time = time.time()
            final = None
            async for event in _manager.stream_graph(graph_id, task):
                final = event
                yield event  # raw SDK MultiAgentStreamEvent dict -> ToolStreamEvent

            execution_time = round((time.time() - start_time) * 1000)
            completed = getattr(final.get("result"), "completed_nodes", 0) if isinstance(final, dict) else 0
            failed = getattr(final.get("result"), "failed_nodes", 0) if isinstance(final, dict) else 0
            _manager.graphs[graph_id]["metadata"]["last_execution"] = {
                "task": task,
                "completed_nodes": completed,
                "failed_nodes": failed,
                "execution_time": execution_time,
                "timestamp": time.time(),
            }
            yield {
                "status": "success",
                "content": [
                    {"text": f"Graph {graph_id} executed in {execution_time}ms ({completed} nodes, {failed} failed)."}
                ],
            }
            return

        if action == "create":
            if not graph_id or not topology:
                yield {
                    "status": "error",
                    "content": [{"text": "graph_id and topology are required for create action"}],
                }
                return
            if agent is None:
                yield {
                    "status": "error",
                    "content": [{"text": "A parent agent is required for create action"}],
                }
                return
            result = _manager.create_graph(graph_id, topology, agent, model_provider, model_settings, tools)
            node_count = len(topology["nodes"]) if topology else 0
            message = (
                f"Graph {graph_id} created with {node_count} nodes."
                if result["status"] == "success"
                else result["message"]
            )
            yield {"status": result["status"], "content": [{"text": message}]}
            return

        if action == "status":
            if not graph_id:
                yield {"status": "error", "content": [{"text": "graph_id is required for status action"}]}
                return
            result = _manager.get_graph_status(graph_id)
            if result["status"] == "success":
                result["rich_output"] = create_rich_status_panel(console, result["data"])
                yield {"status": "success", "content": [{"text": f"Graph {graph_id} status retrieved."}]}
            else:
                yield {"status": "error", "content": [{"text": result["message"]}]}
            return

        if action == "list":
            result = _manager.list_graphs()
            yield {"status": "success", "content": [{"text": f"Listed {len(result['data'])} graphs."}]}
            return

        if action == "delete":
            if not graph_id:
                yield {"status": "error", "content": [{"text": "graph_id is required for delete action"}]}
                return
            result = _manager.delete_graph(graph_id)
            message = (
                f"Graph {graph_id} deleted successfully."
                if result["status"] == "success"
                else result["message"]
            )
            yield {"status": result["status"], "content": [{"text": message}]}
            return

        yield {
            "status": "error",
            "content": [
                {"text": f"Unknown action: {action}. Valid actions: create, execute, status, list, delete"}
            ],
        }

    except Exception as e:
        error_trace = traceback.format_exc()
        logger.error(f"\n[GRAPH TOOL ERROR]\n{str(e)}\n{error_trace}")
        yield {
            "status": "error",
            "content": [{"text": f"⚠️ Graph Error: {str(e)}"}],
        }
