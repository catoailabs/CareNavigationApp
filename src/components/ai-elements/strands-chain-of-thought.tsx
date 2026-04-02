import React from "react";
import type { UIMessage } from "ai";
import {
  BrainIcon,
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
  ChainOfThought,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
  ChainOfThoughtContent,
  ChainOfThoughtSearchResults,
  ChainOfThoughtSearchResult,
} from "./chain-of-thought";
import {
  Task,
  TaskTrigger,
  TaskContent,
  TaskItem,
  TaskItemFile,
} from "./task";
import { Terminal } from "./terminal";
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
import { JSXPreview, JSXPreviewContent, JSXPreviewError } from "./jsx-preview";

interface StrandsChainOfThoughtProps {
  message: UIMessage;
  isStreaming?: boolean;
}

export function StrandsChainOfThought({ message, isStreaming = false }: StrandsChainOfThoughtProps) {
  const timelineParts = message.parts?.filter(
    (part) => part.type === "reasoning" || part.type === "tool-invocation"
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
              <ChainOfThoughtStep
                key={`reasoning-${index}`}
                icon={BrainIcon}
                label={part.reasoning || "Thinking..."}
                status={status}
              />
            );
          }

          // B. Tool Invocations
          if (part.type === "tool-invocation") {
            const toolName = part.toolInvocation.toolName;
            const args = part.toolInvocation.args as any;
            const result = part.toolInvocation.state === 'result' ? part.toolInvocation.result : undefined;
            const isToolComplete = part.toolInvocation.state === "result";
            const nameLower = toolName.toLowerCase();

            // 1. Agent.tsx (Subagents)
            if (["subagent", "agent_skills", "skill", "call_subagent", "use_agent"].some(name => nameLower.includes(name))) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={UserIcon} label={`Invoked Subagent: ${toolName}`} status={isToolComplete ? "complete" : "active"}>
                  <div className="mt-3 ml-4">
                    <Agent>
                      <AgentHeader name={args.agent_name || toolName} model={args.model || "default-model"} />
                      <AgentContent>
                        <AgentInstructions className="text-xs">{args.instructions || "Executing delegated task..."}</AgentInstructions>
                      </AgentContent>
                    </Agent>
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 2. ChainOfThoughtSearchResults (Web and Doc Searches)
            if (["search_web", "search_docs", "search_health", "search_pubmed", "search_clinical_trials"].some(name => nameLower.includes(name))) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={SearchIcon} label={`Searching: ${args.query || toolName}`} status={isToolComplete ? "complete" : "active"}>
                  <div className="mt-2 ml-4">
                    {isToolComplete && result?.sources && Array.isArray(result.sources) && (
                      <ChainOfThoughtSearchResults>
                        {result.sources.slice(0, 5).map((src: any, i: number) => (
                          <ChainOfThoughtSearchResult key={i} href={src.url || src.link || "#"}>
                            {src.title || src.name || src.url || "Source Result"}
                          </ChainOfThoughtSearchResult>
                        ))}
                      </ChainOfThoughtSearchResults>
                    )}
                    {isToolComplete && !result?.sources && (
                      <div className="text-xs text-muted-foreground">Search completed.</div>
                    )}
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 3. Task.tsx (editor.py, Tool_Catalog, Clients, and general API calls)
            if ([
              "read_file", "write_file", "edit_file", "editor", "view_file", "str_replace", "create_file",
              "load_tool", "unload_tool", "tool_catalog", "a2a client", "a2a_client", "mcp client", "mcp_client",
              "review_image", "search_video", "forge_", "fhir.", "get_observations", "search_indicators", 
              "filter_data", "analyze_trends", "get_fda_drug_info", "npi_lookup",
              "playwright_navigate", "playwright_click", "playwright_fill", "gmail_helpers", "slack"
            ].some(name => nameLower.includes(name))) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={ListTodoIcon} label={`Action: ${toolName}`} status={isToolComplete ? "complete" : "active"}>
                  <div className="mt-2 ml-4 border p-2 rounded-md">
                    <Task defaultOpen={!isToolComplete}>
                      <TaskTrigger title={`Executing ${toolName}`} />
                      <TaskContent>
                        <TaskItem>
                          {nameLower.includes("file") && args.path ? (
                            <span className="inline-flex items-center gap-1">Processing <TaskItemFile><FileIcon className="size-3" /> <span>{args.path}</span></TaskItemFile></span>
                          ) : (
                            <span>{JSON.stringify(args).substring(0, 80)}...</span>
                          )}
                        </TaskItem>
                        {isToolComplete && (
                          <TaskItem><span className="inline-flex items-center gap-2 text-muted-foreground text-xs"><CheckCircle className="size-3 text-green-500" /> Completed successfully</span></TaskItem>
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
                  <div className="mt-3 ml-4">
                    <Confirmation className="w-full max-w-md">
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
                  <div className="mt-3 ml-4">
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
                <ChainOfThoughtStep key={`tool-${index}`} icon={TerminalIcon} label="Isolated Sandbox Execution" status={isToolComplete ? "complete" : "active"}>
                  <div className="mt-3 ml-4">
                    <Sandbox defaultOpen={true}>
                      <SandboxHeader title="Code Interpreter" />
                      <SandboxContent>
                        <CodeBlock code={args.code || ""} language="python" />
                        {isToolComplete && <div className="mt-2 text-xs bg-muted p-2 rounded">Output: {result?.stdout || result?.error || "Success"}</div>}
                      </SandboxContent>
                    </Sandbox>
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 8. PackageInfo.tsx (Dynamic Package & NPM)
            if (["dynamic_package", "npm", "npm_install", "add_dependency"].some(name => nameLower.includes(name))) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={FileIcon} label="Managing Dependencies" status="complete">
                  <div className="mt-3 ml-4">
                    <PackageInfo name={args.package_name || args.package || args.dependency || "unknown-package"} version={args.version || "latest"}>
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
                  <div className="mt-3 ml-4">
                    <SchemaDisplay method={args.method?.toUpperCase() || "GET"} path={args.url || "/"}>
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
                  <div className="mt-3 ml-4">
                    {isToolComplete && result ? (
                      <TestResults summary={{ passed: result.passed || 1, failed: result.failed || 0, skipped: 0, duration: result.duration || 0 }}>
                        <TestSuite name="Automated Tests" duration={result.duration || 0}>
                           <Test name="Agent execution" status={(result.failed || 0) > 0 ? "failed" : "passed"} duration={result.duration || 0} />
                        </TestSuite>
                      </TestResults>
                    ) : (
                      <div className="text-sm text-muted-foreground">Running tests...</div>
                    )}
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 11. Terminal.tsx (Shell commands & outputs)
            if (["shell", "command", "bash", "execute_bash", "run_script", "run_shell_command", "python_repl", "electron_eval_main", "electron_cdp_send", "playwright_evaluate", "playwright_console_logs"].some(name => nameLower.includes(name))) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={TerminalIcon} label={`$ ${args.command || args.script || toolName}`} status={isToolComplete ? "complete" : "active"}>
                  <div className="mt-3 ml-4">
                    <Terminal output={isToolComplete ? (result?.output || result?.stdout || String(result)) : "Executing..."} isStreaming={!isToolComplete} autoScroll={true} />
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 12. CodeBlock.tsx (Written code)
            if (["write_code", "generate_script", "refactor_file", "forge_mcp_export_tools", "emit_jsx", "emit_queue", "emit_plan", "write"].some(name => nameLower.includes(name))) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={CodeIcon} label="Generated Code" status="complete">
                  <div className="mt-3 ml-4">
                    <CodeBlock code={isToolComplete ? (result?.code || result?.content || args.code || "") : (args.code || "...")} language={args.language || "typescript"} />
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 13. WebPreview / Artifact (Browser automation, Virtual Desktop & run projects)
            if (["browser_automation", "use_computer", "run_project", "electron_embed_browser", "ronbrowser", "browser_tools", "virtual_desktop", "generate_document", "app_project", "local_chromium_browser"].some(name => nameLower.includes(name))) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={GlobeIcon} label={nameLower.includes('computer') || nameLower.includes('desktop') ? 'Computer Automation' : 'Live Preview'} status={isToolComplete ? "complete" : "active"}>
                  <div className="mt-4 ml-2">
                    <Artifact>
                      <ArtifactHeader>
                        <ArtifactTitle>{args.project_name || args.app_name || args.action || toolName}</ArtifactTitle>
                        <ArtifactDescription>Agent generated view</ArtifactDescription>
                      </ArtifactHeader>
                      <ArtifactContent className="p-0 overflow-hidden h-[400px]">
                        {isToolComplete && result?.url ? (
                          <WebPreview defaultUrl={result.url}>
                            <WebPreviewNavigation><WebPreviewUrl /></WebPreviewNavigation>
                            <WebPreviewBody src={result.url} />
                          </WebPreview>
                        ) : (
                          <div className="p-4 text-sm text-muted-foreground font-mono">{isToolComplete ? JSON.stringify(result).substring(0, 100) : "Initializing view..."}</div>
                        )}
                      </ArtifactContent>
                    </Artifact>
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 14. Attachments (Images/Files uploaded)
            if (["image", "video", "upload", "take_photo", "analyze_screen", "playwright_screenshot", "nova_reels", "generate_image_stability"].some(name => nameLower.includes(name)) || result?.url?.match(/\.(png|jpg|jpeg|mp4|pdf)$/i) || result?.image_url) {
              return (
                <ChainOfThoughtStep key={`tool-${index}`} icon={ImageIcon} label="Media Attachment" status={isToolComplete ? "complete" : "active"}>
                  <div className="mt-3 ml-4">
                    {isToolComplete && (result?.url || result?.image_url) && (
                      <Attachments variant="inline">
                        <Attachment data={{ id: part.toolInvocation.toolCallId, type: "file", url: result.url || result.image_url, mediaType: "image/png", filename: "output.png" }}>
                          <AttachmentPreview />
                          <AttachmentInfo />
                        </Attachment>
                      </Attachments>
                    )}
                  </div>
                </ChainOfThoughtStep>
              );
            }

            // 15. Default Tool Fallback
            return (
              <ChainOfThoughtStep key={`tool-${index}`} icon={WrenchIcon} label={`Using tool: ${toolName}`} status={isToolComplete ? "complete" : "active"}>
                <div className="mt-3 ml-4 border-l-2 border-muted pl-4 pb-2">
                  <Tool defaultOpen={!isToolComplete}>
                    <ToolHeader type={`tool-${toolName}`} state={isToolComplete ? "output-available" : "input-streaming"} toolName={toolName} />
                    <ToolContent>
                      <ToolInput input={args} />
                      {isToolComplete && <ToolOutput output={<div className="text-xs font-mono break-all">{JSON.stringify(result, null, 2)}</div>} />}
                    </ToolContent>
                  </Tool>
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