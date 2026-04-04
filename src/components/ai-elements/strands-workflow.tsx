"use client";

import { useState } from "react";
import { Position, type Edge as FlowEdge, type Node as FlowNode, type NodeProps as FlowNodeProps } from "@xyflow/react";
import { Canvas } from "./canvas";
import { 
  Node, 
  NodeHeader, 
  NodeTitle, 
  NodeDescription, 
  NodeContent 
} from "./node";
import { Controls } from "./controls";
import { Panel } from "./panel";
import { Toolbar } from "./toolbar";
import { Connection } from "./connection";
import { Agent, AgentHeader, AgentContent, AgentInstructions } from "./agent";
import { Task, TaskTrigger, TaskContent, TaskItem, TaskItemFile } from "./task";
import { EyeIcon, PauseIcon, CheckCircle, FileIcon, BrainIcon, WrenchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface WorkflowToolArgs {
  path?: string;
  query?: string;
}

interface ReasoningWorkflowEvent {
  type: "reasoning";
  text?: string;
}

interface ToolWorkflowEvent {
  type: "tool";
  status?: string;
  toolName?: string;
  args?: WorkflowToolArgs;
}

interface HandoffWorkflowEvent {
  type: "handoff";
  targetAgent?: string;
}

type WorkflowEvent = ReasoningWorkflowEvent | ToolWorkflowEvent | HandoffWorkflowEvent;

interface AgentState {
  agentName?: string;
  model?: string;
  systemPrompt?: string;
  events?: WorkflowEvent[];
}

interface LatestWorkflowEvent {
  type?: string;
  source?: string;
  target?: string;
}

interface AgentWorkflowNodeData extends Record<string, unknown> {
  activeAgentId?: string | null;
  agentName?: string;
  role?: string;
  status?: string;
  inspectAgent: (id: string) => void;
  pauseAgent: (id: string) => void;
}

type WorkflowNode = FlowNode<Record<string, unknown>>;
type WorkflowEdge = FlowEdge;

// Custom Agent Node for React Flow
export const AgentWorkflowNode = ({ id, data, selected }: FlowNodeProps<FlowNode<AgentWorkflowNodeData, "agentNode">>) => {
  const isActive = id === data.activeAgentId;

  return (
    <Node handles={{ target: true, source: true }} className={isActive ? "ring-2 ring-primary" : ""}>
      <NodeHeader>
        <NodeTitle>{data.agentName || "Agent"}</NodeTitle>
        <NodeDescription>{data.role || "Node"}</NodeDescription>
      </NodeHeader>
      <NodeContent>
        <div className="text-xs text-muted-foreground">
          Status: {data.status || "Idle"}
        </div>
      </NodeContent>
      
      <Toolbar isVisible={selected || isActive} position={Position.Bottom}>
        <div className="flex gap-1 bg-background border p-1 rounded-md shadow-sm">
          <Button size="sm" variant="ghost" onClick={() => data.inspectAgent(id)}>
            <EyeIcon className="size-3 mr-2" /> Inspect Log
          </Button>
          <Button size="sm" variant="destructive" onClick={() => data.pauseAgent(id)}>
            <PauseIcon className="size-3" />
          </Button>
        </div>
      </Toolbar>
    </Node>
  );
};

// Note: React Flow requires custom node types to be defined outside the render cycle
const nodeTypes = {
  agentNode: AgentWorkflowNode,
} as const;

interface StrandsMultiAgentWorkflowProps {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  latestEvent?: LatestWorkflowEvent;
  agentsDataMap: Record<string, AgentState>; // Maps nodeId to execution log / system prompt
}

export function StrandsMultiAgentWorkflow({ 
  nodes, 
  edges, 
  latestEvent, 
  agentsDataMap 
}: StrandsMultiAgentWorkflowProps) {
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);

  const handleInspectAgent = (id: string) => {
    setActiveAgentId(id);
  };

  // Inject the inspection callback into node data
  const injectedNodes = nodes.map(node => ({
    ...node,
    data: {
      ...node.data,
      activeAgentId,
      inspectAgent: handleInspectAgent,
      pauseAgent: (id: string) => console.log("Paused", id)
    }
  }));

  const activeAgentState = activeAgentId ? agentsDataMap[activeAgentId] : null;

  return (
    <div className="flex w-full h-[600px] border rounded-lg overflow-hidden bg-background">
      {/* 70% Pane: Canvas Topology */}
      <div className="w-[70%] h-full relative border-r">
        <Canvas 
          nodes={injectedNodes} 
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => setActiveAgentId(node.id)}
          connectionLineComponent={Connection} 
        >
          <Controls position="bottom-right" className="m-4 shadow-md" />
          
          <Panel position="top-left" className="m-4">
            <div className="flex flex-col gap-1 bg-background/80 backdrop-blur-md p-3 rounded-lg border shadow-sm">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Workflow Status
              </span>
              <span className="text-sm font-medium">
                {latestEvent?.type === 'multiagent_handoff' 
                  ? `Routing: ${latestEvent.source} → ${latestEvent.target}` 
                  : `Active Node: ${activeAgentId || 'None'}`}
              </span>
            </div>
          </Panel>
        </Canvas>
      </div>

      {/* 30% Pane: Deep Agent Inspection */}
      <div className="w-[30%] h-full overflow-y-auto bg-muted/30 p-4">
        {!activeAgentState ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground text-center">
            Select a node or trace an active connection to view the agent's internal thought process.
          </div>
        ) : (
          <Agent>
            <AgentHeader 
              name={activeAgentState.agentName || "Active Agent"} 
              model={activeAgentState.model || "default-model"} 
            />
            <AgentContent>
              <AgentInstructions className="text-xs">
                {activeAgentState.systemPrompt || "No system instructions provided."}
              </AgentInstructions>
              
              <div className="mt-6">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                  Execution Log
                </p>
                <Task defaultOpen={true}>
                  <TaskTrigger title="Subagent Actions" />
                  <TaskContent className="flex flex-col gap-3 max-h-[400px] overflow-y-auto pr-2">
                    {/* Render every granular action from the Strands event stream scoped to this node */}
                    {activeAgentState.events?.map((event: WorkflowEvent, idx: number) => {
                      
                      // 1. Reasoning / Thought Block
                      if (event.type === 'reasoning') {
                        return (
                          <TaskItem key={idx}>
                            <span className="inline-flex gap-2 text-muted-foreground italic text-sm">
                              <BrainIcon className="size-4 mt-0.5 shrink-0" />
                              <span>{event.text}</span>
                            </span>
                          </TaskItem>
                        );
                      }

                      // 2. Tool Execution
                      if (event.type === 'tool') {
                        return (
                          <TaskItem key={idx}>
                            <span className="flex flex-col gap-1 text-sm text-foreground">
                              <span className="inline-flex items-center gap-2 font-medium">
                                {event.status === 'active' ? <span className="animate-spin text-muted-foreground">⟳</span> : <CheckCircle className="size-4 text-green-500" />}
                                {event.toolName}
                              </span>
                              {event.toolName === 'read_file' && event.args?.path && (
                                <TaskItemFile className="ml-6">
                                  <FileIcon className="size-3" /> {event.args.path}
                                </TaskItemFile>
                              )}
                              {event.toolName === 'search_web' && (
                                <span className="ml-6 text-xs text-muted-foreground">
                                  Query: "{event.args?.query}"
                                </span>
                              )}
                            </span>
                          </TaskItem>
                        );
                      }

                      // 3. Handoffs / Connections (Yields)
                      if (event.type === 'handoff') {
                        return (
                          <TaskItem key={idx}>
                            <span className="inline-flex items-center gap-2 text-sm font-medium text-primary">
                              <WrenchIcon className="size-4" />
                              Yielding control to: {event.targetAgent}
                            </span>
                          </TaskItem>
                        );
                      }

                      return null;
                    })}
                  </TaskContent>
                </Task>
              </div>
            </AgentContent>
          </Agent>
        )}
      </div>
    </div>
  );
}
