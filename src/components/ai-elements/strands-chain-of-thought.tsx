import { getToolName, isToolUIPart, type UIMessage } from "ai";
import {
  CheckCircle,
  CodeIcon,
  FileIcon,
  GlobeIcon,
  ImageIcon,
  ListTodoIcon,
  MessageSquareIcon,
  TerminalIcon,
  WrenchIcon,
  UserIcon,
  SearchIcon,
} from "lucide-react";

// AI Elements Imports
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "./reasoning";
import {
  ChainOfThought,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
  ChainOfThoughtContent,
  ChainOfThoughtSearchResults,
  ChainOfThoughtSearchResult,
} from "./chain-of-thought";
import { Terminal } from "./terminal";
import {
  Task,
  TaskTrigger,
  TaskContent,
  TaskItem,
  TaskItemFile,
} from "./task";
import { CodeBlock } from "./code-block";
import {
  Artifact,
  ArtifactHeader,
  ArtifactTitle,
  ArtifactDescription,
  ArtifactContent,
} from "./artifact";
import {
  WebPreview,
  WebPreviewNavigation,
  WebPreviewUrl,
  WebPreviewBody,
} from "./web-preview";
import { CDPBrowserViewer } from "./CDPBrowserViewer";
import {
  Attachments,
  Attachment,
  AttachmentPreview,
  AttachmentInfo,
} from "./attachments";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "./tool";
import {
  Confirmation,
  ConfirmationTitle,
  ConfirmationRequest,
  ConfirmationActions,
  ConfirmationAction,
} from "./confirmation";
import {
  EnvironmentVariables,
  EnvironmentVariableGroup,
  EnvironmentVariable,
} from "./environment-variables";
import { Sandbox, SandboxHeader, SandboxContent } from "./sandbox";
import { PackageInfo, PackageInfoDescription } from "./package-info";
import { SchemaDisplay, SchemaDisplayDescription } from "./schema-display";
import { TestResults, TestSuite, Test } from "./test-results";
import { Agent, AgentHeader, AgentContent, AgentInstructions } from "./agent";

interface StrandsChainOfThoughtProps {
  message: UIMessage;
  isStreaming?: boolean;
}

interface SearchSource {
  url?: string;
  link?: string;
  title?: string;
  name?: string;
}

export function StrandsChainOfThought({ message, isStreaming = false }: StrandsChainOfThoughtProps) {
  const timelineParts = message.parts?.filter(
    (part) => part.type === "reasoning" || isToolUIPart(part)
  ) || [];

  if (timelineParts.length === 0) return null;

  return (
    <ChainOfThought defaultOpen>
      <ChainOfThoughtHeader>Agent Execution Timeline</ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {timelineParts.map((part, index) => {
          const isLastPart = index === timelineParts.length - 1;
          const status = isLastPart && isStreaming ? "active" : "complete";

          // A. Reasoning Block
          if (part.type === "reasoning") {
            return (
              <Reasoning key={`reasoning-${index}`} isStreaming={status === "active"}>
                <ReasoningTrigger />
                <ReasoningContent>{part.text || ""}</ReasoningContent>
              </Reasoning>
            );
          }

          // B. Tool Invocations
          if (isToolUIPart(part)) {
            const toolPart = part;
            const baseToolName = getToolName(toolPart);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const args = (toolPart.input || {}) as Record<string, any>;
            
            // If this is an MCP Client invocation, the true tool name is inside args
            const toolName = baseToolName === "mcp_client" && args.tool_name ? args.tool_name : baseToolName;
            
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = (toolPart.output || {}) as Record<string, any>;
            const state = toolPart.state;
            const isToolComplete = state === "output-available" || state === "output-error" || state === "output-denied";
            const nameLower = toolName.toLowerCase();

            // 1. Agent.tsx (Subagents)
            if (["subagent", "agent_skills", "skill", "call_subagent", "use_agent"].some(name => nameLower.includes(name))) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={UserIcon} label={`Invoked Subagent: ${toolName}`} status={isToolComplete ? "complete" : "active"}>
                  <div className="mt-2 ml-1">
                    <Agent>
                      <AgentHeader name={args.agent_name || toolName} model={args.model || "default-model"} />
                      <AgentContent>
                        <AgentInstructions className="text-xs">{String(args.instructions || "Executing delegated task...")}</AgentInstructions>
                      </AgentContent>
                    </Agent>
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 2. ChainOfThoughtSearchResults (Web, Doc, MCP Searches, Docker searches)
            const isSearchTool = 
              ["search", "query", "lookup", "find", "fetch_data"].some(term => nameLower.includes(term)) ||
              (isToolComplete && (Array.isArray(result?.sources) || Array.isArray(result?.results)));

            if (isSearchTool) {
              const query = args.query || args.q || args.search_query || args.topic || args.keyword || toolName;
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={SearchIcon} label={`Searching: ${query}`} status={isToolComplete ? "complete" : "active"}>
                  <div className="mt-2 ml-1 flex flex-col gap-2">
                    <Task defaultOpen={!isToolComplete}>
                      <TaskTrigger title={`Executing ${toolName}`} />
                      <TaskContent>
                        <TaskItem>
                          <span className="bg-secondary px-2 py-0.5 rounded text-secondary-foreground text-sm font-mono">{query}</span>
                        </TaskItem>
                        {isToolComplete && (
                          <TaskItem><span className="inline-flex items-center gap-2 text-muted-foreground text-xs font-sans"><CheckCircle className="size-3 text-green-500" /> Search execution complete</span></TaskItem>
                        )}
                      </TaskContent>
                    </Task>
                    
                    {isToolComplete && result?.sources && Array.isArray(result.sources) && (
                      <ChainOfThoughtSearchResults>
                        {(result.sources as SearchSource[]).slice(0, 5).map((src: SearchSource, i: number) => (
                          <ChainOfThoughtSearchResult key={i} title={src.url || src.link || undefined}>
                            <a href={src.url || src.link || "#"} target="_blank" rel="noreferrer" className="hover:text-primary">
                              {src.title || src.name || src.url || "Source Result"}
                            </a>
                          </ChainOfThoughtSearchResult>
                        ))}
                      </ChainOfThoughtSearchResults>
                    )}
                    {isToolComplete && result?.results && Array.isArray(result.results) && (
                      <ChainOfThoughtSearchResults>
                        {(result.results as SearchSource[]).slice(0, 5).map((src: SearchSource, i: number) => (
                          <ChainOfThoughtSearchResult key={i} title={src.url || src.link || undefined}>
                            <a href={src.url || src.link || "#"} target="_blank" rel="noreferrer" className="hover:text-primary">
                              {src.title || src.name || src.url || "Source Result"}
                            </a>
                          </ChainOfThoughtSearchResult>
                        ))}
                      </ChainOfThoughtSearchResults>
                    )}
                    {isToolComplete && !result?.sources && !result?.results && (
                      <div className="text-xs text-muted-foreground mt-1">Search completed.</div>
                    )}
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 3. Task.tsx (editor.py, Tool_Catalog, Clients, and general API calls)
            if ([
              "read_file", "write_file", "edit_file", "editor", "view_file", "str_replace", "create_file",
              "load_tool", "unload_tool", "tool_catalog", "a2a client", "a2a_client",
              "review_image", "search_video", "forge_", "fhir.", "get_observations", "search_indicators", 
              "filter_data", "analyze_trends", "get_fda_drug_info", "npi_lookup",
              "playwright_navigate", "playwright_click", "playwright_fill", "gmail_helpers", "slack"
            ].some(name => nameLower.includes(name))) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={ListTodoIcon} label={`Action: ${toolName}`} status={isToolComplete ? "complete" : "active"}>
                  <div className="mt-1.5 ml-1">
                    <Task defaultOpen={!isToolComplete}>
                      <TaskTrigger title={`Executing ${toolName}`} />
                      <TaskContent>
                        <TaskItem>
                          {nameLower.includes("file") && args.path ? (
                            <span className="inline-flex items-center gap-2 font-sans">Processing <TaskItemFile><FileIcon className="size-3" /> <span>{args.path}</span></TaskItemFile></span>
                          ) : (
                            <span className="text-sm font-mono">{JSON.stringify(args).substring(0, 100)}{JSON.stringify(args).length > 100 ? "..." : ""}</span>
                          )}
                        </TaskItem>
                        {isToolComplete && (
                          <TaskItem><span className="inline-flex items-center gap-2 text-muted-foreground text-xs font-sans"><CheckCircle className="size-3 text-green-500" /> Completed successfully</span></TaskItem>
                        )}
                      </TaskContent>
                    </Task>
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 5. Confirmation.tsx (HITL)
            if (["hitl", "ask_user", "request_confirmation"].some(name => nameLower.includes(name))) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={MessageSquareIcon} label="Awaiting User Input" status={isToolComplete ? "complete" : "active"}>
                  <div className="mt-2 ml-1">
                    <Confirmation className="w-full max-w-md" state={isToolComplete ? "output-available" : "input-available"}>
                      <ConfirmationTitle>{args.question || "Confirmation Required"}</ConfirmationTitle>
                      <ConfirmationRequest>Please review the requested action before the agent proceeds.</ConfirmationRequest>
                      {!isToolComplete && (
                        <ConfirmationActions>
                          <ConfirmationAction variant="outline" size="sm">Reject</ConfirmationAction>
                          <ConfirmationAction size="sm">Approve</ConfirmationAction>
                        </ConfirmationActions>
                      )}
                    </Confirmation>
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 6. EnvironmentVariables.tsx
            if (["environment", "set_env", "get_env", "list_env"].some(name => nameLower.includes(name))) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={WrenchIcon} label="Modifying Environment" status="complete">
                  <div className="mt-2 ml-1">
                    <EnvironmentVariables showValues={true}>
                      <EnvironmentVariableGroup title="Agent Environment">
                        <EnvironmentVariable name={args.key || "ENV_VAR"} value={args.value || "********"} />
                      </EnvironmentVariableGroup>
                    </EnvironmentVariables>
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 7. Sandbox.tsx (Code Interpretation)
            if (["code_interpretation", "code_interpreter", "interpreter", "run_python_sandbox", "agent_core_code", "docker_code", "local_code", "electron_code"].some(name => nameLower.includes(name))) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={FileIcon} label="Isolated Sandbox Execution" status={isToolComplete ? "complete" : "active"}>
                  <div className="mt-2 ml-1">
                    <Sandbox defaultOpen={!isToolComplete}>
                      <SandboxHeader title="Code Interpreter" state={isToolComplete ? "output-available" : "input-available"} />
                      <SandboxContent>
                        <CodeBlock code={args.code || ""} language="python" />
                        {isToolComplete && <div className="mt-2 text-xs bg-muted p-3 rounded-md text-foreground overflow-auto max-h-48 whitespace-pre-wrap font-mono border border-border"><span className="text-muted-foreground mb-1 block uppercase tracking-wider text-[10px]">Output</span>{result?.stdout || result?.error || "Execution Success"}</div>}
                      </SandboxContent>
                    </Sandbox>
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 7.5. Terminal.tsx (Shell Execution)
            if (["shell", "terminal", "run_command", "bash", "zsh", "cmd"].some(name => nameLower.includes(name) || nameLower === name)) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={TerminalIcon} label={`Terminal: ${args.command || "Exec"}`} status={isToolComplete ? "complete" : "active"}>
                  <div className="mt-2 ml-1">
                    <Terminal 
                      output={result?.stdout || result?.stderr || result?.output || args.command || "Executing..."} 
                      isStreaming={!isToolComplete} 
                      autoScroll={true} 
                    />
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 8. PackageInfo.tsx (Dynamic Package & NPM)
            if (["dynamic_package", "npm", "npm_install", "add_dependency"].some(name => nameLower.includes(name))) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={FileIcon} label="Managing Dependencies" status="complete">
                  <div className="mt-2 ml-1">
                    <PackageInfo name={args.package_name || args.package || args.dependency || "unknown-package"} newVersion={args.version || "latest"}>
                      <PackageInfoDescription>Installed during agent execution.</PackageInfoDescription>
                    </PackageInfo>
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 9. SchemaDisplay.tsx (HTTP Requests)
            if (["http_request", "api_fetch"].some(name => nameLower.includes(name))) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={GlobeIcon} label={`Network Request: ${args.url || 'API'}`} status={isToolComplete ? "complete" : "active"}>
                  <div className="mt-2 ml-1">
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    <SchemaDisplay method={String(args.method || "GET").toUpperCase() as any} path={args.url || "/"}>
                      <SchemaDisplayDescription>{isToolComplete ? "Status: " + (result?.status || result?.status_code || 200) : "Fetching..."}</SchemaDisplayDescription>
                    </SchemaDisplay>
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 10. TestResults.tsx
            if (["test", "run_tests", "pytest", "jest"].some(name => nameLower.includes(name))) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={CheckCircle} label="Executing Test Suite" status={isToolComplete ? "complete" : "active"}>
                  <div className="mt-2 ml-1">
                    {isToolComplete && result ? (
                      <TestResults summary={{ passed: Number(result.passed || 1), failed: Number(result.failed || 0), skipped: 0, total: Number(result.passed || 0) + Number(result.failed || 0) }}>
                        <TestSuite name="Automated Tests" status={Number(result.failed || 0) > 0 ? "failed" : "passed"}>
                           <Test name="Agent execution" status={Number(result.failed || 0) > 0 ? "failed" : "passed"} />
                        </TestSuite>
                      </TestResults>
                    ) : (
                      <div className="text-sm text-muted-foreground">Running tests...</div>
                    )}
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 11. CodeBlock.tsx (Written code)
            if (["write_code", "generate_script", "refactor_file", "forge_mcp_export_tools", "emit_jsx", "emit_queue", "emit_plan", "write"].some(name => nameLower.includes(name))) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={CodeIcon} label="Generated Code" status="complete">
                  <div className="mt-2 ml-1">
                    <CodeBlock code={isToolComplete ? (result?.code || result?.content || args.code || "") : (args.code || "...")} language={args.language || "typescript"} />
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 12. WebPreview / Artifact (Browser automation & run projects)
            if (["browser", "browser_automation", "run_project", "electron_embed_browser", "ronbrowser", "browser_tools", "generate_document", "app_project", "local_chromium_browser"].some(name => nameLower.includes(name) || nameLower === name)) {
              const isCDPManaged = ["local_chromium_browser", "ronbrowser", "browser_tools", "browser_automation", "browser"].some(name => nameLower === name);
              
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={GlobeIcon} label="Live Preview" status={isToolComplete ? "complete" : "active"}>
                  <div className="mt-3 ml-1">
                    <Artifact className="rounded-lg overflow-hidden border border-border shadow-sm">
                      <ArtifactHeader className="bg-muted border-b border-border py-2 px-4">
                        <ArtifactTitle className="text-sm font-medium tracking-tight text-foreground">{args.project_name || args.app_name || args.action || toolName}</ArtifactTitle>
                        <ArtifactDescription className="text-xs text-muted-foreground">{isCDPManaged ? "Active Session" : "Generated View"}</ArtifactDescription>
                      </ArtifactHeader>
                      <ArtifactContent className="p-0 overflow-hidden h-[400px]">
                        {isCDPManaged ? (
                          <CDPBrowserViewer />
                        ) : isToolComplete && result?.url ? (
                          <WebPreview defaultUrl={result.url}>
                            <WebPreviewNavigation><WebPreviewUrl /></WebPreviewNavigation>
                            <WebPreviewBody />
                          </WebPreview>
                        ) : (
                          <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground font-mono">{isToolComplete ? JSON.stringify(result).substring(0, 100) : "Initializing viewport..."}</div>
                        )}
                      </ArtifactContent>
                    </Artifact>
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 12.5. Virtual Desktop (NoVNC HITL)
            if (["use_computer", "virtual_desktop", "computer", "agent_desktop"].some(name => nameLower.includes(name) || nameLower === name)) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={GlobeIcon} label="Virtual Desktop (HITL)" status={isToolComplete ? "complete" : "active"}>
                  <div className="mt-3 ml-1">
                    <Artifact className="rounded-lg overflow-hidden border border-border shadow-sm">
                      <ArtifactHeader className="bg-muted border-b border-border py-2 px-4 flex justify-between items-center">
                        <div>
                          <ArtifactTitle className="text-sm font-medium tracking-tight text-foreground">{args.action || "OS Desktop Session"}</ArtifactTitle>
                          <ArtifactDescription className="text-xs text-muted-foreground">NoVNC Remote Connection</ArtifactDescription>
                        </div>
                        <div className="flex gap-2 items-center">
                          <span className="flex h-2 w-2 rounded-full bg-green-500 animate-pulse"></span>
                          <span className="text-[10px] text-muted-foreground font-mono">LIVE / localhost:3001</span>
                        </div>
                      </ArtifactHeader>
                      <ArtifactContent className="p-0 overflow-hidden h-[500px]">
                        <iframe src="http://localhost:3001" className="w-full h-full border-0 select-none bg-black" title="Agent Desktop NoVNC" allow="clipboard-read; clipboard-write; display-capture" />
                      </ArtifactContent>
                    </Artifact>
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 13. Attachments (Images/Files uploaded)
            if (["image", "video", "upload", "take_photo", "analyze_screen", "playwright_screenshot", "nova_reels", "generate_image_stability"].some(name => nameLower.includes(name)) || result?.url?.match(/\.(png|jpg|jpeg|mp4|pdf)$/i) || result?.image_url) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={ImageIcon} label="Media Attachment" status={isToolComplete ? "complete" : "active"}>
                  <div className="mt-2 ml-1">
                    {isToolComplete && (result?.url || result?.image_url) && (
                      <Attachments variant="inline">
                        <Attachment data={{ id: toolPart.toolCallId, type: "file", url: result.url || result.image_url, mediaType: "image/png", filename: "output.png" }}>
                          <AttachmentPreview />
                          <AttachmentInfo />
                        </Attachment>
                      </Attachments>
                    )}
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 14. Default Tool Fallback
            return (
              <ChainOfThoughtStep key={`tool-${index}`} icon={WrenchIcon} label={`Using tool: ${toolName}`} status={isToolComplete ? "complete" : "active"}>
                <div className="mt-1 ml-1 relative">
                  <div className="absolute top-4 bottom-4 left-0 w-px bg-border" />
                  <div className="pl-4">
                    <Tool defaultOpen={!isToolComplete}>
                      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                      <ToolHeader type={toolPart.type as any} state={isToolComplete ? "output-available" : "input-streaming"} toolName={toolName} />
                      <ToolContent>
                        <ToolInput input={args} />
                        {isToolComplete && <ToolOutput output={result || JSON.stringify(result, null, 2)} errorText={'errorText' in toolPart ? toolPart.errorText : undefined} />}
                      </ToolContent>
                    </Tool>
                  </div>
                </div>
              </ChainOfThoughtStep>
            );
          }

          return null;
        })}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}
