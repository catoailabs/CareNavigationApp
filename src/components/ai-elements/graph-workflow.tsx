"use client";

import { type NodeProps as RFNodeProps } from "@xyflow/react";
import { BotIcon, PlayIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

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
  /** True when this node is a graph entry point (no upstream dependency). */
  isEntry?: boolean;
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
  running: "bg-primary animate-pulse",
  completed: "bg-primary",
  failed: "bg-destructive",
};

const STATUS_LABEL: Record<GraphNodeStatus, string> = {
  pending: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

/** Ring accent applied to a node card so its state reads at a glance. */
const STATUS_RING: Record<GraphNodeStatus, string> = {
  pending: "",
  running: "shadow-md ring-2 ring-ring/60",
  completed: "ring-1 ring-primary/25",
  failed: "ring-2 ring-destructive/50",
};

/** Compact status key shown in the canvas corner so the dots are legible. */
const LEGEND: { status: GraphNodeStatus; label: string }[] = [
  { status: "running", label: "Running" },
  { status: "completed", label: "Done" },
  { status: "failed", label: "Failed" },
  { status: "pending", label: "Queued" },
];

/** Horizontal / vertical distance between node cards in the auto-layout. */
const COLUMN_GAP = 340;
const ROW_GAP = 190;

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

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
        <Agent className="w-80 border-none bg-transparent">
          <AgentHeader model={node.model ?? "parent"} name={node.id} />
          <AgentContent>
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <span
                className={cn("size-2 rounded-full", STATUS_DOT[node.status])}
              />
              <span className="font-medium text-foreground">
                {STATUS_LABEL[node.status]}
              </span>
              {typeof node.executionTime === "number" && (
                <span className="ml-auto font-mono text-[10px]">
                  {formatDuration(node.executionTime)}
                </span>
              )}
            </div>
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
        className={cn(
          "w-64 shadow-sm transition-all",
          STATUS_RING[node.status],
          node.isEntry && node.status === "pending" && "ring-1 ring-primary/40"
        )}
        handles={{ target: true, source: true }}
      >
        <NodeHeader>
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <BotIcon className="size-4 shrink-0 text-muted-foreground" />
              <NodeTitle className="truncate text-sm">{node.id}</NodeTitle>
            </div>
            {node.isEntry && (
              <PlayIcon
                aria-label="Entry point"
                className="size-3.5 shrink-0 text-primary"
              />
            )}
          </div>
          {node.role && (
            <NodeDescription className="truncate text-xs capitalize">
              {node.role}
            </NodeDescription>
          )}
        </NodeHeader>
        <NodeContent className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <span className={cn("size-2 rounded-full", STATUS_DOT[node.status])} />
            <span className="font-medium">{STATUS_LABEL[node.status]}</span>
            {typeof node.executionTime === "number" && (
              <span className="ml-auto font-mono text-[10px]">
                {formatDuration(node.executionTime)}
              </span>
            )}
          </div>
          {node.model && (
            <Badge
              className="w-fit max-w-full truncate font-mono text-[10px]"
              variant="secondary"
            >
              {node.model}
            </Badge>
          )}
        </NodeContent>
      </Node>
    </div>
  );
});
WorkflowNode.displayName = "WorkflowNode";

const nodeTypes = { workflow: WorkflowNode };
const edgeTypes = {
  connecting: Edge.Connecting,
  settled: Edge.Settled,
  temporary: Edge.Temporary,
};

/**
 * Assign columns by longest-path depth from the entry points so the DAG reads
 * left-to-right; nodes that share a depth stack into a vertically-centred
 * column so the graph stays balanced and the cards never overlap.
 */
function layout(
  state: GraphWorkflowState
): Record<string, { x: number; y: number }> {
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

  // Group node ids by depth, preserving discovery order within each column.
  const columns = new Map<number, string[]>();
  for (const n of state.nodes) {
    const d = depth.get(n.id) ?? 0;
    const column = columns.get(d) ?? [];
    column.push(n.id);
    columns.set(d, column);
  }

  const tallest = Math.max(
    1,
    ...Array.from(columns.values(), (ids) => ids.length)
  );

  const positions: Record<string, { x: number; y: number }> = {};
  for (const [d, ids] of columns) {
    // Vertically centre shorter columns against the tallest one.
    const offset = ((tallest - ids.length) * ROW_GAP) / 2;
    ids.forEach((id, row) => {
      positions[id] = { x: d * COLUMN_GAP, y: offset + row * ROW_GAP };
    });
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

  // Entry points are the ones the graph declared, or — failing that — any node
  // with no incoming edge, so the "start here" marker is always meaningful.
  const entrySet = useMemo(() => {
    if (data.entryPoints.length) {
      return new Set(data.entryPoints);
    }
    const hasIncoming = new Set(data.edges.map((e) => e.to));
    return new Set(
      data.nodes.filter((n) => !hasIncoming.has(n.id)).map((n) => n.id)
    );
  }, [data.entryPoints, data.edges, data.nodes]);

  const rfNodes = useMemo(
    () =>
      data.nodes.map((node) => ({
        id: node.id,
        type: "workflow",
        position: positions[node.id] ?? { x: 0, y: 0 },
        data: {
          ...node,
          isEntry: entrySet.has(node.id),
        } as unknown as Record<string, unknown>,
      })),
    [data.nodes, positions, entrySet]
  );

  const rfEdges = useMemo(
    () =>
      data.edges.map((edge) => {
        const target = data.nodes.find((n) => n.id === edge.to);
        // Live hand-off into a running agent -> shared connection-line visual;
        // finished -> a quiet settled line; otherwise a pending dashed line.
        const type =
          target?.status === "running"
            ? "connecting"
            : target?.status === "completed"
              ? "settled"
              : "temporary";
        return {
          id: `${edge.from}->${edge.to}`,
          source: edge.from,
          target: edge.to,
          type,
        };
      }),
    [data.edges, data.nodes]
  );

  // Grow the canvas with the tallest column so small graphs are not a giant
  // empty box and large ones get room to breathe (fitView keeps it framed).
  const height = useMemo(() => {
    const ys = Object.values(positions).map((p) => p.y);
    const rows = ys.length ? Math.round(Math.max(...ys) / ROW_GAP) + 1 : 1;
    return Math.min(560, Math.max(300, rows * ROW_GAP + 80));
  }, [positions]);

  if (data.nodes.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-4 text-center text-muted-foreground text-xs">
        Waiting for graph topology…
      </div>
    );
  }

  return (
    <div className="w-full overflow-hidden rounded-md border" style={{ height }}>
      <Canvas
        connectionLineComponent={Connection}
        edges={rfEdges}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ maxZoom: 1, minZoom: 0.3, padding: 0.28 }}
        maxZoom={1.5}
        minZoom={0.3}
        nodes={rfNodes}
        nodeTypes={nodeTypes}
      >
        <Panel className="text-xs" position="top-left">
          <div className="flex items-center gap-2 px-1 py-0.5">
            <span className="font-medium">Agent Graph</span>
            <span className="text-muted-foreground">
              {data.nodes.length} {data.nodes.length === 1 ? "node" : "nodes"} ·{" "}
              {data.edges.length} {data.edges.length === 1 ? "edge" : "edges"}
              {isStreaming ? " · live" : ""}
            </span>
          </div>
        </Panel>
        <Panel className="text-[10px]" position="top-right">
          <div className="flex items-center gap-3 px-1 py-0.5 text-muted-foreground">
            {LEGEND.map((item) => (
              <span className="flex items-center gap-1.5" key={item.status}>
                <span
                  className={cn("size-2 rounded-full", STATUS_DOT[item.status])}
                />
                {item.label}
              </span>
            ))}
          </div>
        </Panel>
        <Controls />
      </Canvas>
    </div>
  );
});
GraphWorkflow.displayName = "GraphWorkflow";
