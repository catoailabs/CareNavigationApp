"use client";

import { type NodeProps as RFNodeProps } from "@xyflow/react";
import { BotIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import {
  Agent,
  AgentContent,
  AgentHeader,
  AgentInstructions,
} from "./agent";
import { Canvas } from "./canvas";
import { Connection } from "./connection";
import { Controls } from "./controls";
import { Edge } from "./edge";
import {
  Node,
  NodeContent,
  NodeDescription,
  NodeHeader,
  NodeTitle,
} from "./node";
import { Panel } from "./panel";
import { Task, TaskContent, TaskItem, TaskTrigger } from "./task";
import { Toolbar } from "./toolbar";

export type GraphNodeStatus = "pending" | "running" | "completed" | "failed";

export interface GraphNodeState {
  id: string;
  role?: string;
  model?: string;
  nodeType?: string;
  status: GraphNodeStatus;
  text: string;
  executionTime?: number;
}

export interface GraphEdgeState {
  from: string;
  to: string;
}

export interface GraphWorkflowState {
  nodes: GraphNodeState[];
  edges: GraphEdgeState[];
  entryPoints: string[];
}

/**
 * A single `data-graph` event payload produced by `agent.py::_graph_data_part`.
 * The discriminant is `kind`; the rest of the fields depend on it.
 */
export interface GraphEvent {
  kind: "topology" | "node_start" | "node_stop" | "node_text" | "handoff";
  toolCallId?: string;
  nodes?: { id: string; role?: string; model?: string }[];
  edges?: { from: string; to: string }[];
  entryPoints?: string[];
  nodeId?: string;
  nodeType?: string;
  status?: string;
  executionTime?: number;
  delta?: string;
  from?: string[];
  to?: string[];
}

const MAX_NODE_TEXT = 2000;

const STATUS_FROM_SDK: Record<string, GraphNodeStatus> = {
  completed: "completed",
  failed: "failed",
  executing: "running",
  pending: "pending",
};

/**
 * Fold the ordered stream of `data-graph` events into a workflow snapshot.
 * Pure and deterministic so the DAG can be rebuilt on every render from the
 * accumulated parts — no client-side mutation of the message stream.
 */
export function foldGraphEvents(events: GraphEvent[]): GraphWorkflowState {
  const nodes = new Map<string, GraphNodeState>();
  const edges = new Map<string, GraphEdgeState>();
  let entryPoints: string[] = [];

  const ensure = (id: string): GraphNodeState => {
    let node = nodes.get(id);
    if (!node) {
      node = { id, status: "pending", text: "" };
      nodes.set(id, node);
    }
    return node;
  };

  const addEdge = (from: string, to: string) => {
    if (from && to) {
      edges.set(`${from}->${to}`, { from, to });
    }
  };

  for (const event of events) {
    switch (event.kind) {
      case "topology": {
        for (const n of event.nodes ?? []) {
          const node = ensure(n.id);
          node.role = n.role ?? node.role;
          node.model = n.model ?? node.model;
        }
        for (const e of event.edges ?? []) {
          addEdge(e.from, e.to);
        }
        entryPoints = event.entryPoints ?? entryPoints;
        break;
      }
      case "node_start": {
        if (event.nodeId) {
          const node = ensure(event.nodeId);
          node.nodeType = event.nodeType ?? node.nodeType;
          if (node.status === "pending") {
            node.status = "running";
          }
        }
        break;
      }
      case "node_text": {
        if (event.nodeId && event.delta) {
          const node = ensure(event.nodeId);
          node.text = (node.text + event.delta).slice(-MAX_NODE_TEXT);
        }
        break;
      }
      case "node_stop": {
        if (event.nodeId) {
          const node = ensure(event.nodeId);
          node.status =
            (event.status && STATUS_FROM_SDK[event.status]) || "completed";
          node.executionTime = event.executionTime ?? node.executionTime;
        }
        break;
      }
      case "handoff": {
        for (const from of event.from ?? []) {
          for (const to of event.to ?? []) {
            addEdge(from, to);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
    entryPoints,
  };
}

const STATUS_DOT: Record<GraphNodeStatus, string> = {
  pending: "bg-muted-foreground/40",
  running: "bg-amber-400 animate-pulse",
  completed: "bg-emerald-500",
  failed: "bg-destructive",
};

const STATUS_LABEL: Record<GraphNodeStatus, string> = {
  pending: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

/**
 * Custom React Flow node. Renders the AI Elements `Node`; on hover it reveals a
 * `Toolbar` holding the `Agent` configuration with a nested `Task` that exposes
 * what the sub-agent is doing (or did).
 */
const WorkflowNode = memo(({ data }: RFNodeProps) => {
  const node = data as unknown as GraphNodeState;
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Toolbar isVisible={hovered}>
        <Agent className="w-80 border-none">
          <AgentHeader model={node.model ?? "parent"} name={node.id} />
          <AgentContent>
            <AgentInstructions className="text-xs">
              {node.role ? `Role: ${node.role}` : "Delegated graph node."}
            </AgentInstructions>
            <Task defaultOpen>
              <TaskTrigger title={`${STATUS_LABEL[node.status]} · task`} />
              <TaskContent>
                <TaskItem>
                  {node.text.trim()
                    ? node.text.trim().slice(-600)
                    : node.status === "pending"
                      ? "Waiting on upstream nodes…"
                      : "Working…"}
                </TaskItem>
              </TaskContent>
            </Task>
          </AgentContent>
        </Agent>
      </Toolbar>

      <Node
        className={
          node.status === "running" ? "ring-2 ring-amber-400/60" : undefined
        }
        handles={{ target: true, source: true }}
      >
        <NodeHeader>
          <div className="flex items-center gap-2">
            <BotIcon className="size-4 text-muted-foreground" />
            <NodeTitle className="text-sm">{node.id}</NodeTitle>
          </div>
          {node.role && (
            <NodeDescription className="text-xs">{node.role}</NodeDescription>
          )}
        </NodeHeader>
        <NodeContent>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={`size-2 rounded-full ${STATUS_DOT[node.status]}`} />
            <span>{STATUS_LABEL[node.status]}</span>
            {typeof node.executionTime === "number" && (
              <span className="ml-auto font-mono">{node.executionTime}ms</span>
            )}
          </div>
        </NodeContent>
      </Node>
    </div>
  );
});
WorkflowNode.displayName = "WorkflowNode";

const nodeTypes = { workflow: WorkflowNode };
const edgeTypes = { animated: Edge.Animated, temporary: Edge.Temporary };

/**
 * Assign columns by longest-path depth from the entry points so the DAG reads
 * left-to-right; rows stack nodes that share a depth.
 */
function layout(state: GraphWorkflowState): Record<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  for (const n of state.nodes) {
    depth.set(n.id, 0);
  }
  // Relax depths across edges (DAG => converges in <= nodes iterations).
  for (let i = 0; i < state.nodes.length; i++) {
    let changed = false;
    for (const edge of state.edges) {
      const next = (depth.get(edge.from) ?? 0) + 1;
      if (next > (depth.get(edge.to) ?? 0)) {
        depth.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  const rowByDepth = new Map<number, number>();
  const positions: Record<string, { x: number; y: number }> = {};
  for (const n of state.nodes) {
    const d = depth.get(n.id) ?? 0;
    const row = rowByDepth.get(d) ?? 0;
    rowByDepth.set(d, row + 1);
    positions[n.id] = { x: d * 320, y: row * 150 };
  }
  return positions;
}

export interface GraphWorkflowProps {
  data: GraphWorkflowState;
  isStreaming?: boolean;
}

/**
 * Live React Flow rendering of a Strands multi-agent Graph. Built dynamically
 * from whatever nodes/edges the agent's `graph` tool streamed.
 */
export const GraphWorkflow = memo(({ data, isStreaming }: GraphWorkflowProps) => {
  const positions = useMemo(() => layout(data), [data]);

  const rfNodes = useMemo(
    () =>
      data.nodes.map((node) => ({
        id: node.id,
        type: "workflow",
        position: positions[node.id] ?? { x: 0, y: 0 },
        data: node as unknown as Record<string, unknown>,
      })),
    [data.nodes, positions]
  );

  const rfEdges = useMemo(
    () =>
      data.edges.map((edge) => {
        const target = data.nodes.find((n) => n.id === edge.to);
        const live =
          target?.status === "running" || target?.status === "completed";
        return {
          id: `${edge.from}->${edge.to}`,
          source: edge.from,
          target: edge.to,
          type: live ? "animated" : "temporary",
        };
      }),
    [data.edges, data.nodes]
  );

  if (data.nodes.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-4 text-center text-muted-foreground text-xs">
        Waiting for graph topology…
      </div>
    );
  }

  return (
    <div className="h-[420px] w-full overflow-hidden rounded-md border">
      <Canvas
        connectionLineComponent={Connection}
        edges={rfEdges}
        edgeTypes={edgeTypes}
        nodes={rfNodes}
        nodeTypes={nodeTypes}
      >
        <Panel className="text-xs" position="top-left">
          <span className="font-medium">Agent Graph</span>
          <span className="ml-2 text-muted-foreground">
            {data.nodes.length} nodes · {data.edges.length} edges
            {isStreaming ? " · live" : ""}
          </span>
        </Panel>
        <Controls />
      </Canvas>
    </div>
  );
});
GraphWorkflow.displayName = "GraphWorkflow";
