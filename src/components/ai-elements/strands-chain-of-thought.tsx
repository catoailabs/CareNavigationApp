"use client";

import {
  getToolName,
  isToolUIPart,
  type DynamicToolUIPart,
  type FileUIPart,
  type SourceUrlUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import {
  BookIcon,
  CheckCircle2Icon,
  CheckCircleIcon,
  CodeIcon,
  FileIcon,
  GlobeIcon,
  ImageIcon,
  ListTodoIcon,
  MessageSquareIcon,
  SearchIcon,
  Share2Icon,
  TerminalIcon,
  UserIcon,
  WrenchIcon,
} from "lucide-react";
import { memo, useMemo } from "react";

import { Agent, AgentContent, AgentHeader, AgentInstructions } from "./agent";
import {
  foldGraphEvents,
  GraphWorkflow,
  type GraphEvent,
} from "./graph-workflow";
import {
  JSXPreview,
  JSXPreviewContent,
  JSXPreviewError,
} from "./jsx-preview";
import type { TProps as JsxParserProps } from "react-jsx-parser";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  Attachments,
} from "./attachments";
import {
  Artifact,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
} from "./artifact";
import { CodeBlock } from "./code-block";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtImage,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from "./chain-of-thought";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "./confirmation";
import {
  EnvironmentVariable,
  EnvironmentVariables,
  EnvironmentVariablesContent,
  EnvironmentVariablesHeader,
  EnvironmentVariablesTitle,
  EnvironmentVariablesToggle,
} from "./environment-variables";
import {
  PackageInfo,
  PackageInfoDescription,
  PackageInfoHeader,
  PackageInfoName,
  PackageInfoVersion,
} from "./package-info";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "./reasoning";
import {
  Sandbox,
  SandboxContent,
  SandboxHeader,
  SandboxTabContent,
  SandboxTabs,
  SandboxTabsBar,
  SandboxTabsList,
  SandboxTabsTrigger,
} from "./sandbox";
import {
  SchemaDisplay,
  SchemaDisplayContent,
  SchemaDisplayDescription,
  SchemaDisplayHeader,
  SchemaDisplayMethod,
  SchemaDisplayParameters,
  SchemaDisplayPath,
} from "./schema-display";
import {
  MessageResponse,
} from "./message";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskItemFile,
  TaskTrigger,
} from "./task";
import {
  Terminal,
  TerminalActions,
  TerminalContent,
  TerminalCopyButton,
  TerminalHeader,
  TerminalStatus,
  TerminalTitle,
} from "./terminal";
import {
  Test,
  TestResults,
  TestResultsContent,
  TestResultsDuration,
  TestResultsHeader,
  TestResultsSummary,
  TestSuite,
  TestSuiteContent,
  TestSuiteName,
  TestSuiteStats,
} from "./test-results";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "./tool";
import { Source, Sources, SourcesContent, SourcesTrigger } from "./sources";
import {
  RunProjectPreview,
  WebPreview,
  WebPreviewBody,
  WebPreviewNavigation,
  WebPreviewUrl,
} from "./web-preview";

interface StrandsChainOfThoughtProps {
  message: UIMessage;
  isStreaming?: boolean;
}

interface SearchSource {
  url?: string;
  link?: string;
  title?: string;
  name?: string;
  snippet?: string;
  description?: string;
  content?: string;
}

type ToolPart = ToolUIPart | DynamicToolUIPart;

const SUBAGENT_TOOL_NAMES = [
  "subagent",
  "agent_skills",
  "skill",
  "call_subagent",
  "use_agent",
];

const GRAPH_TOOL_NAMES = ["graph", "agent_graph", "swarm", "workflow"];

const SEARCH_TOOL_NAMES = ["search", "query", "lookup", "find", "fetch_data"];

const FILE_ACTION_TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "editor",
  "view_file",
  "str_replace",
  "create_file",
  "load_tool",
  "unload_tool",
  "tool_catalog",
  "a2a client",
  "a2a_client",
  "review_image",
  "search_video",
  "forge_",
  "fhir.",
  "get_observations",
  "search_indicators",
  "filter_data",
  "analyze_trends",
  "get_fda_drug_info",
  "npi_lookup",
  "playwright_navigate",
  "playwright_click",
  "playwright_fill",
  "gmail_helpers",
  "slack",
];

const HITL_TOOL_NAMES = ["hitl", "ask_user", "request_confirmation"];

const ENV_TOOL_NAMES = ["environment", "set_env", "get_env", "list_env"];

const CODE_TOOL_NAMES = [
  "code_interpretation",
  "code_interpreter",
  "interpreter",
  "run_python_sandbox",
  "agent_core_code",
  "docker_code",
  "local_code",
  "electron_code",
];

// Tools that *run* a code project / dev server and should render a live
// web-preview of the running app rather than a plain terminal or sandbox.
const RUN_PROJECT_TOOL_NAMES = ["run_project", "app_project", "dev_server"];

const SHELL_TOOL_NAMES = [
  "shell",
  "terminal",
  "run_command",
  "bash",
  "zsh",
  "cmd",
];

const PACKAGE_TOOL_NAMES = [
  "dynamic_package",
  "npm",
  "npm_install",
  "add_dependency",
];

const HTTP_TOOL_NAMES = ["http_request", "api_fetch"];

const TEST_TOOL_NAMES = ["test", "run_tests", "pytest", "jest"];

const CODEGEN_TOOL_NAMES = [
  "write_code",
  "generate_script",
  "refactor_file",
  "forge_mcp_export_tools",
  "emit_jsx",
  "emit_queue",
  "emit_plan",
  "write",
];

const BROWSER_TOOL_NAMES = [
  "browser",
  "browser_automation",
  "electron_embed_browser",
  "ronbrowser",
  "browser_tools",
  "generate_document",
  "local_chromium_browser",
];

const DESKTOP_TOOL_NAMES = [
  "use_computer",
  "virtual_desktop",
  "computer",
  "agent_desktop",
];

const MEDIA_TOOL_NAMES = [
  "image",
  "video",
  "upload",
  "take_photo",
  "analyze_screen",
  "playwright_screenshot",
  "nova_reels",
  "generate_image_stability",
];

function isToolNameMatch(name: string, patterns: string[]): boolean {
  const lower = name.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}

function isBrowserTool(name: string): boolean {
  const lower = name.toLowerCase();
  return BROWSER_TOOL_NAMES.some(
    (pattern) => lower === pattern || lower.includes(pattern.toLowerCase())
  );
}

function isDesktopTool(name: string): boolean {
  const lower = name.toLowerCase();
  return DESKTOP_TOOL_NAMES.some(
    (pattern) => lower === pattern || lower.includes(pattern.toLowerCase())
  );
}

function isMediaTool(name: string, result: unknown): boolean {
  const lower = name.toLowerCase();
  const hasMediaResult =
    typeof result === "object" &&
    result !== null &&
    ("url" in result || "image_url" in result);
  return (
    MEDIA_TOOL_NAMES.some((pattern) => lower.includes(pattern.toLowerCase())) ||
    (hasMediaResult &&
      typeof (result as Record<string, string>).url === "string" &&
      /\.(png|jpg|jpeg|mp4|pdf)$/i.test((result as Record<string, string>).url))
  );
}

// A code project is "run" when a dev-server command is executed (npm run dev,
// vite, flask run, rails server, …). Such tools render their running app in a
// web-preview iframe instead of a plain terminal.
const RUN_PROJECT_COMMAND_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b|\bvite\b|\bnext\s+(?:dev|start)\b|\bng\s+serve\b|\bnuxt\b|\bastro\s+dev\b|\bnodemon\b|\bserve\b|\bflask\s+run\b|\bmanage\.py\s+runserver\b|\buvicorn\b|\bgunicorn\b|\bstreamlit\s+run\b|\bpython\s+-m\s+http\.server\b|\brails\s+s(?:erver)?\b|\bphp\s+-S\b|\bphp\s+artisan\s+serve\b|\bdotnet\s+(?:run|watch)\b|\bcargo\s+run\b/i;

// First loopback URL printed in the dev server's output (e.g. http://localhost:5173).
function findLocalUrl(text: string): string | undefined {
  const match = text.match(
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}\S*/i
  );
  return match ? match[0].replace(/0\.0\.0\.0/, "localhost") : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isRunProjectTool(toolName: string, args: Record<string, any>): boolean {
  const lower = toolName.toLowerCase();
  if (RUN_PROJECT_TOOL_NAMES.some((name) => lower.includes(name))) return true;
  return RUN_PROJECT_COMMAND_RE.test(String(args?.command ?? args?.cmd ?? ""));
}

function getSourceUrl(src: SearchSource): string | undefined {
  return src.url || src.link;
}

function getSourceTitle(src: SearchSource): string {
  return src.title || src.name || "Source";
}

function getSourceSnippet(src: SearchSource): string | undefined {
  return src.snippet || src.description || src.content;
}

function getDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function normalizeSources(raw: unknown): SearchSource[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): SearchSource | null => {
      if (typeof item === "string" && item.startsWith("http")) {
        return { url: item };
      }
      if (typeof item === "object" && item !== null) {
        return item as SearchSource;
      }
      return null;
    })
    .filter((item): item is SearchSource => item !== null);
}

function SearchSourceItem({ src, index }: { src: SearchSource; index: number }) {
  const url = getSourceUrl(src);
  const title = getSourceTitle(src);
  const snippet = getSourceSnippet(src);
  const domain = getDomain(url);

  return (
    <ChainOfThoughtSearchResult
      key={index}
      className="h-auto max-w-md flex-col items-start gap-1 py-2"
      title={url}
    >
      <a
        className="flex w-full flex-col gap-0.5 hover:text-primary"
        href={url || "#"}
        rel="noreferrer"
        target="_blank"
      >
        <span className="font-medium text-foreground">{title}</span>
        {domain && (
          <span className="text-muted-foreground text-[10px]">{domain}</span>
        )}
        {snippet && (
          <span className="line-clamp-3 font-normal text-muted-foreground text-xs">
            {snippet}
          </span>
        )}
      </a>
    </ChainOfThoughtSearchResult>
  );
}

function SearchResults({ sources }: { sources: SearchSource[] }) {
  const items = normalizeSources(sources);
  if (items.length === 0) return null;

  return (
    <ChainOfThoughtSearchResults>
      {items.slice(0, 8).map((src, i) => (
        <SearchSourceItem key={i} index={i} src={src} />
      ))}
    </ChainOfThoughtSearchResults>
  );
}

function SubagentTool({
  toolName,
  args,
  isComplete,
}: {
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  isComplete: boolean;
}) {
  return (
    <ChainOfThoughtStep
      icon={UserIcon}
      label={`Invoked Subagent: ${toolName}`}
      status={isComplete ? "complete" : "active"}
    >
      <Agent className="mt-2 ml-1">
        <AgentHeader
          model={args.model || "default-model"}
          name={args.agent_name || toolName}
        />
        <AgentContent>
          <AgentInstructions className="text-xs">
            {String(args.instructions || "Executing delegated task...")}
          </AgentInstructions>
        </AgentContent>
      </Agent>
    </ChainOfThoughtStep>
  );
}

/**
 * Renders a Strands multi-agent Graph as a live React Flow DAG. The tool call is
 * linked to a JSX Preview variant: the `<GraphWorkflow>` element is registered
 * in the parser's component map and fed the folded event state via bindings, so
 * the workflow is rendered dynamically from whatever the agent streamed.
 */
function GraphWorkflowTool({
  events,
  isComplete,
  isStreaming,
}: {
  events: GraphEvent[];
  isComplete: boolean;
  isStreaming: boolean;
}) {
  const state = useMemo(() => foldGraphEvents(events), [events]);

  return (
    <ChainOfThoughtStep
      icon={Share2Icon}
      label="Agent Graph"
      status={isComplete ? "complete" : "active"}
    >
      <JSXPreview
        bindings={{ graph: state, streaming: isStreaming }}
        className="mt-2 ml-1"
        components={{
          GraphWorkflow: GraphWorkflow,
        } as unknown as JsxParserProps["components"]}
        isStreaming={isStreaming}
        jsx="<GraphWorkflow data={graph} isStreaming={streaming} />"
      >
        <JSXPreviewContent />
        <JSXPreviewError />
      </JSXPreview>
    </ChainOfThoughtStep>
  );
}

function SearchTool({
  toolName,
  args,
  result,
  isComplete,
}: {
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: Record<string, any>;
  isComplete: boolean;
}) {
  const query =
    args.query || args.q || args.search_query || args.topic || args.keyword;

  return (
    <ChainOfThoughtStep
      icon={SearchIcon}
      label={query ? `Searching: ${query}` : `Searching with ${toolName}`}
      status={isComplete ? "complete" : "active"}
    >
      <div className="mt-2 ml-1 flex flex-col gap-2">
        <Task defaultOpen={!isComplete}>
          <TaskTrigger title={`Executing ${toolName}`} />
          <TaskContent>
            <TaskItem>
              <span className="rounded bg-secondary px-2 py-0.5 font-mono text-secondary-foreground text-sm">
                {query || toolName}
              </span>
            </TaskItem>
            {isComplete && (
              <TaskItem>
                <span className="inline-flex items-center gap-2 font-sans text-muted-foreground text-xs">
                  <CheckCircleIcon className="size-3 text-green-500" />
                  Search execution complete
                </span>
              </TaskItem>
            )}
          </TaskContent>
        </Task>
        {isComplete && <SearchResults sources={result?.sources} />}
        {isComplete && <SearchResults sources={result?.results} />}
        {isComplete && !result?.sources && !result?.results && (
          <div className="mt-1 text-xs text-muted-foreground">
            Search completed.
          </div>
        )}
      </div>
    </ChainOfThoughtStep>
  );
}

function FileActionTool({
  toolName,
  args,
  isComplete,
}: {
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  isComplete: boolean;
}) {
  const nameLower = toolName.toLowerCase();
  const argsJson = JSON.stringify(args);

  return (
    <ChainOfThoughtStep
      icon={ListTodoIcon}
      label={`Action: ${toolName}`}
      status={isComplete ? "complete" : "active"}
    >
      <div className="mt-1.5 ml-1">
        <Task defaultOpen={!isComplete}>
          <TaskTrigger title={`Executing ${toolName}`} />
          <TaskContent>
            <TaskItem>
              {nameLower.includes("file") && args.path ? (
                <span className="inline-flex items-center gap-2 font-sans">
                  Processing
                  <TaskItemFile>
                    <FileIcon className="size-3" />
                    <span>{args.path}</span>
                  </TaskItemFile>
                </span>
              ) : (
                <span className="font-mono text-sm">
                  {argsJson.substring(0, 100)}
                  {argsJson.length > 100 ? "..." : ""}
                </span>
              )}
            </TaskItem>
            {isComplete && (
              <TaskItem>
                <span className="inline-flex items-center gap-2 font-sans text-muted-foreground text-xs">
                  <CheckCircleIcon className="size-3 text-green-500" />
                  Completed successfully
                </span>
              </TaskItem>
            )}
          </TaskContent>
        </Task>
      </div>
    </ChainOfThoughtStep>
  );
}

function HitlTool({
  args,
  isComplete,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  isComplete: boolean;
}) {
  return (
    <ChainOfThoughtStep
      icon={MessageSquareIcon}
      label="Awaiting User Input"
      status={isComplete ? "complete" : "active"}
    >
      <Confirmation
        approval={{ id: "hitl" }}
        className="mt-2 ml-1 w-full max-w-md"
        state={isComplete ? "output-available" : "approval-requested"}
      >
        <ConfirmationTitle>
          {args.question || "Confirmation Required"}
        </ConfirmationTitle>
        <ConfirmationRequest>
          Please review the requested action before the agent proceeds.
        </ConfirmationRequest>
        <ConfirmationAccepted>
          <div className="text-xs text-green-600">Approved</div>
        </ConfirmationAccepted>
        <ConfirmationRejected>
          <div className="text-xs text-red-600">Rejected</div>
        </ConfirmationRejected>
        {!isComplete && (
          <ConfirmationActions>
            <ConfirmationAction size="sm" variant="outline">
              Reject
            </ConfirmationAction>
            <ConfirmationAction size="sm">Approve</ConfirmationAction>
          </ConfirmationActions>
        )}
      </Confirmation>
    </ChainOfThoughtStep>
  );
}

function EnvTool({
  args,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
}) {
  return (
    <ChainOfThoughtStep
      icon={WrenchIcon}
      label="Modifying Environment"
      status="complete"
    >
      <EnvironmentVariables className="mt-2 ml-1" showValues>
        <EnvironmentVariablesHeader>
          <EnvironmentVariablesTitle>Agent Environment</EnvironmentVariablesTitle>
          <EnvironmentVariablesToggle />
        </EnvironmentVariablesHeader>
        <EnvironmentVariablesContent>
          <EnvironmentVariable
            name={args.key || "ENV_VAR"}
            value={args.value || "********"}
          />
        </EnvironmentVariablesContent>
      </EnvironmentVariables>
    </ChainOfThoughtStep>
  );
}

function SandboxTool({
  args,
  result,
  isComplete,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: Record<string, any>;
  isComplete: boolean;
}) {
  const output = result?.stdout || result?.stderr || result?.error || "";

  return (
    <ChainOfThoughtStep
      icon={FileIcon}
      label="Isolated Sandbox Execution"
      status={isComplete ? "complete" : "active"}
    >
      <Sandbox className="mt-2 ml-1" defaultOpen={!isComplete}>
        <SandboxHeader
          state={isComplete ? "output-available" : "input-available"}
          title="Code Interpreter"
        />
        <SandboxContent>
          <SandboxTabs defaultValue="code">
            <SandboxTabsBar>
              <SandboxTabsList>
                <SandboxTabsTrigger value="code">Code</SandboxTabsTrigger>
                {isComplete && (
                  <SandboxTabsTrigger value="output">Output</SandboxTabsTrigger>
                )}
              </SandboxTabsList>
            </SandboxTabsBar>
            <SandboxTabContent value="code">
              <CodeBlock code={args.code || ""} language="python" />
            </SandboxTabContent>
            {isComplete && (
              <SandboxTabContent value="output">
                <div className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-muted p-3 font-mono text-xs">
                  {output || "Execution completed with no output."}
                </div>
              </SandboxTabContent>
            )}
          </SandboxTabs>
        </SandboxContent>
      </Sandbox>
    </ChainOfThoughtStep>
  );
}

function ShellTool({
  toolName,
  args,
  result,
  isComplete,
}: {
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: Record<string, any>;
  isComplete: boolean;
}) {
  const output =
    result?.stdout || result?.stderr || result?.output || args.command || "";

  return (
    <ChainOfThoughtStep
      icon={TerminalIcon}
      label={`Terminal: ${args.command || toolName}`}
      status={isComplete ? "complete" : "active"}
    >
      <div className="mt-2 ml-1">
        <Terminal autoScroll output={output} isStreaming={!isComplete}>
          <TerminalHeader>
            <TerminalTitle />
            <div className="flex items-center gap-1">
              <TerminalStatus />
              <TerminalActions>
                <TerminalCopyButton />
              </TerminalActions>
            </div>
          </TerminalHeader>
          <TerminalContent />
        </Terminal>
      </div>
    </ChainOfThoughtStep>
  );
}

function PackageTool({
  args,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
}) {
  const name =
    args.package_name || args.package || args.dependency || "unknown-package";
  const version = args.version || "latest";

  return (
    <ChainOfThoughtStep
      icon={FileIcon}
      label="Managing Dependencies"
      status="complete"
    >
      <PackageInfo
        className="mt-2 ml-1"
        name={name}
        newVersion={version}
      >
        <PackageInfoHeader>
          <PackageInfoName />
        </PackageInfoHeader>
        <PackageInfoDescription>
          Installed during agent execution.
        </PackageInfoDescription>
        <PackageInfoVersion />
      </PackageInfo>
    </ChainOfThoughtStep>
  );
}

function HttpTool({
  args,
  result,
  isComplete,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: Record<string, any>;
  isComplete: boolean;
}) {
  const method = String(args.method || "GET").toUpperCase();
  const url = args.url || "/";

  return (
    <ChainOfThoughtStep
      icon={GlobeIcon}
      label={`Network Request: ${url}`}
      status={isComplete ? "complete" : "active"}
    >
      <SchemaDisplay
        className="mt-2 ml-1"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        method={method as any}
        path={url}
      >
        <SchemaDisplayHeader>
          <SchemaDisplayMethod />
          <SchemaDisplayPath />
        </SchemaDisplayHeader>
        <SchemaDisplayDescription>
          {isComplete
            ? `Status: ${result?.status || result?.status_code || 200}`
            : "Fetching..."}
        </SchemaDisplayDescription>
        <SchemaDisplayContent>
          <SchemaDisplayParameters />
        </SchemaDisplayContent>
      </SchemaDisplay>
    </ChainOfThoughtStep>
  );
}

function TestTool({
  result,
  isComplete,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: Record<string, any>;
  isComplete: boolean;
}) {
  const passed = Number(result?.passed || 0);
  const failed = Number(result?.failed || 0);
  const skipped = Number(result?.skipped || 0);
  const total = passed + failed + skipped;
  const status = failed > 0 ? "failed" : "passed";

  return (
    <ChainOfThoughtStep
      icon={CheckCircle2Icon}
      label="Executing Test Suite"
      status={isComplete ? "complete" : "active"}
    >
      <div className="mt-2 ml-1">
        {isComplete && result ? (
          <TestResults summary={{ passed, failed, skipped, total }}>
            <TestResultsHeader>
              <TestResultsSummary />
              <TestResultsDuration />
            </TestResultsHeader>
            <TestResultsContent>
              <TestSuite name="Automated Tests" status={status}>
                <TestSuiteName>
                  <div className="flex w-full items-center gap-2">
                    <span>Agent execution</span>
                    <TestSuiteStats
                      failed={failed}
                      passed={passed}
                      skipped={skipped}
                    />
                  </div>
                </TestSuiteName>
                <TestSuiteContent>
                  <Test duration={result?.duration} name="Run" status={status} />
                </TestSuiteContent>
              </TestSuite>
            </TestResultsContent>
          </TestResults>
        ) : (
          <div className="text-sm text-muted-foreground">Running tests...</div>
        )}
      </div>
    </ChainOfThoughtStep>
  );
}

function CodegenTool({
  args,
  result,
  isComplete,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: Record<string, any>;
  isComplete: boolean;
}) {
  const code = isComplete
    ? result?.code || result?.content || args.code || ""
    : args.code || "";

  return (
    <ChainOfThoughtStep
      icon={CodeIcon}
      label="Generated Code"
      status="complete"
    >
      <div className="mt-2 ml-1">
        <CodeBlock
          code={code}
          language={args.language || "typescript"}
        />
      </div>
    </ChainOfThoughtStep>
  );
}

/**
 * Live preview for a *run* code project. Renders the dev server's startup logs
 * in a terminal and, once it prints a local URL, the running app in a
 * {@link RunProjectPreview} iframe.
 */
function RunProjectTool({
  toolName,
  args,
  result,
  isComplete,
  isStreaming,
}: {
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: Record<string, any>;
  isComplete: boolean;
  isStreaming: boolean;
}) {
  const command = String(args?.command ?? args?.cmd ?? toolName);
  const output = String(result?.output ?? result?.stdout ?? result?.stderr ?? "");
  const url =
    (typeof result?.url === "string" && result.url) ||
    findLocalUrl(output) ||
    findLocalUrl(command);

  return (
    <ChainOfThoughtStep
      icon={GlobeIcon}
      label={`Run project: ${command}`}
      status={isComplete ? "complete" : "active"}
    >
      <div className="mt-2 ml-1 space-y-3">
        {output ? (
          <Terminal autoScroll isStreaming={isStreaming && !isComplete} output={output}>
            <TerminalHeader>
              <TerminalTitle />
              <div className="flex items-center gap-1">
                <TerminalStatus />
                <TerminalActions>
                  <TerminalCopyButton />
                </TerminalActions>
              </div>
            </TerminalHeader>
            <TerminalContent />
          </Terminal>
        ) : null}
        {url ? <RunProjectPreview key={url} url={url} /> : null}
      </div>
    </ChainOfThoughtStep>
  );
}

/**
 * Browser-tool live preview only. The agent's browser is Chromium running on
 * its virtual desktop, so the browser tool streams that desktop (webtop / NoVNC
 * at :3001). Override the origin with VITE_AGENT_DESKTOP_URL when the desktop is
 * exposed elsewhere. Scoped to the browser tool — the virtual-desktop tool
 * renders its own frame independently and is intentionally left untouched.
 */
const AGENT_BROWSER_DESKTOP_URL =
  (import.meta.env.VITE_AGENT_DESKTOP_URL as string | undefined) ??
  "http://localhost:3001";

function BrowserTool({
  toolName,
  args,
  result,
  isComplete,
}: {
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: Record<string, any>;
  isComplete: boolean;
}) {
  const nameLower = toolName.toLowerCase();
  const isCDPManaged =
    ["local_chromium_browser", "ronbrowser", "browser_tools", "browser_automation"].some(
      (pattern) => nameLower === pattern
    ) || nameLower === "browser";
  const title = args.project_name || args.app_name || args.action || toolName;

  return (
    <ChainOfThoughtStep
      icon={GlobeIcon}
      label="Live Preview"
      status={isComplete ? "complete" : "active"}
    >
      <Artifact className="mt-3 ml-1 overflow-hidden rounded-lg border shadow-sm">
        <ArtifactHeader className="border-b bg-muted px-4 py-2">
          <div>
            <ArtifactTitle className="text-sm font-medium tracking-tight text-foreground">
              {title}
            </ArtifactTitle>
            <ArtifactDescription className="text-xs text-muted-foreground">
              {isCDPManaged ? "Active Session" : "Generated View"}
            </ArtifactDescription>
          </div>
        </ArtifactHeader>
        <ArtifactContent className="h-[400px] overflow-hidden p-0">
          {isCDPManaged ? (
            <iframe
              allow="clipboard-read; clipboard-write; display-capture"
              className="h-full w-full select-none border-0 bg-black"
              src={AGENT_BROWSER_DESKTOP_URL}
              title="Agent Browser (Virtual Desktop)"
            />
          ) : isComplete && result?.url ? (
            <WebPreview defaultUrl={result.url}>
              <WebPreviewNavigation>
                <WebPreviewUrl />
              </WebPreviewNavigation>
              <WebPreviewBody />
            </WebPreview>
          ) : (
            <div className="flex h-full items-center justify-center p-4 font-mono text-sm text-muted-foreground">
              {isComplete
                ? JSON.stringify(result).substring(0, 100)
                : "Initializing viewport..."}
            </div>
          )}
        </ArtifactContent>
      </Artifact>
    </ChainOfThoughtStep>
  );
}

function DesktopTool({
  args,
  isComplete,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  isComplete: boolean;
}) {
  return (
    <ChainOfThoughtStep
      icon={GlobeIcon}
      label="Virtual Desktop (HITL)"
      status={isComplete ? "complete" : "active"}
    >
      <Artifact className="mt-3 ml-1 overflow-hidden rounded-lg border shadow-sm">
        <ArtifactHeader className="flex items-center justify-between border-b bg-muted px-4 py-2">
          <div>
            <ArtifactTitle className="text-sm font-medium tracking-tight text-foreground">
              {args.action || "OS Desktop Session"}
            </ArtifactTitle>
            <ArtifactDescription className="text-xs text-muted-foreground">
              NoVNC Remote Connection
            </ArtifactDescription>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex h-2 w-2 animate-pulse rounded-full bg-green-500" />
            <span className="font-mono text-[10px] text-muted-foreground">
              LIVE / localhost:3001
            </span>
          </div>
        </ArtifactHeader>
        <ArtifactContent className="h-[500px] overflow-hidden p-0">
          <iframe
            allow="clipboard-read; clipboard-write; display-capture"
            className="h-full w-full select-none border-0 bg-black"
            src="http://localhost:3001"
            title="Agent Desktop NoVNC"
          />
        </ArtifactContent>
      </Artifact>
    </ChainOfThoughtStep>
  );
}

function MediaTool({
  toolPart,
  result,
  isComplete,
}: {
  toolPart: ToolPart;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: Record<string, any>;
  isComplete: boolean;
}) {
  const url = result?.url || result?.image_url;

  return (
    <ChainOfThoughtStep
      icon={ImageIcon}
      label="Media Attachment"
      status={isComplete ? "complete" : "active"}
    >
      <div className="mt-2 ml-1">
        {isComplete && url && (
          <Attachments variant="inline">
            <Attachment
              data={{
                id: toolPart.toolCallId,
                type: "file",
                url,
                mediaType: "image/png",
                filename: "output.png",
              }}
            >
              <AttachmentPreview />
              <AttachmentInfo />
            </Attachment>
          </Attachments>
        )}
        {isComplete && url && (
          <ChainOfThoughtImage caption={result?.caption}>
            <img
              alt="Tool output"
              className="max-h-full max-w-full rounded-md object-contain"
              src={url}
            />
          </ChainOfThoughtImage>
        )}
      </div>
    </ChainOfThoughtStep>
  );
}

function FallbackTool({
  toolName,
  args,
  result,
  errorText,
  isComplete,
}: {
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: Record<string, any>;
  errorText?: string;
  isComplete: boolean;
}) {
  return (
    <ChainOfThoughtStep
      icon={WrenchIcon}
      label={`Using tool: ${toolName}`}
      status={isComplete ? "complete" : "active"}
    >
      <div className="relative mt-1 ml-1">
        <div className="absolute bottom-4 left-0 top-4 w-px bg-border" />
        <div className="pl-4">
          <Tool defaultOpen={!isComplete}>
            <ToolHeader
              state={isComplete ? "output-available" : "input-streaming"}
              toolName={toolName}
              type="dynamic-tool"
            />
            <ToolContent>
              <ToolInput input={args} />
              {isComplete && (
                <ToolOutput
                  errorText={errorText}
                  output={result || JSON.stringify(result, null, 2)}
                />
              )}
            </ToolContent>
          </Tool>
        </div>
      </div>
    </ChainOfThoughtStep>
  );
}

function ToolStep({
  part,
  graphEvents,
  isStreaming = false,
}: {
  part: ToolPart;
  graphEvents?: GraphEvent[];
  isStreaming?: boolean;
}) {
  const baseToolName = getToolName(part);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args = (part.input || {}) as Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (part.output || {}) as Record<string, any>;
  const toolName =
    baseToolName === "mcp_client" && args.tool_name ? args.tool_name : baseToolName;
  const state = part.state;
  const isComplete =
    state === "output-available" ||
    state === "output-error" ||
    state === "output-denied";
  const errorText = "errorText" in part ? part.errorText : undefined;

  if (isToolNameMatch(toolName, GRAPH_TOOL_NAMES)) {
    return (
      <GraphWorkflowTool
        events={graphEvents ?? []}
        isComplete={isComplete}
        isStreaming={isStreaming && !isComplete}
      />
    );
  }

  if (isToolNameMatch(toolName, SUBAGENT_TOOL_NAMES)) {
    return <SubagentTool args={args} isComplete={isComplete} toolName={toolName} />;
  }

  const isSearchTool =
    isToolNameMatch(toolName, SEARCH_TOOL_NAMES) ||
    (isComplete &&
      ((Array.isArray(result?.sources) && result.sources.length > 0) ||
        (Array.isArray(result?.results) && result.results.length > 0)));

  if (isSearchTool) {
    return (
      <SearchTool
        args={args}
        isComplete={isComplete}
        result={result}
        toolName={toolName}
      />
    );
  }

  if (isToolNameMatch(toolName, FILE_ACTION_TOOL_NAMES)) {
    return (
      <FileActionTool args={args} isComplete={isComplete} toolName={toolName} />
    );
  }

  if (isToolNameMatch(toolName, HITL_TOOL_NAMES)) {
    return <HitlTool args={args} isComplete={isComplete} />;
  }

  if (isToolNameMatch(toolName, ENV_TOOL_NAMES)) {
    return <EnvTool args={args} />;
  }

  if (isRunProjectTool(toolName, args)) {
    return (
      <RunProjectTool
        args={args}
        isComplete={isComplete}
        isStreaming={isStreaming}
        result={result}
        toolName={toolName}
      />
    );
  }

  if (isToolNameMatch(toolName, CODE_TOOL_NAMES)) {
    return (
      <SandboxTool args={args} isComplete={isComplete} result={result} />
    );
  }

  if (isToolNameMatch(toolName, SHELL_TOOL_NAMES)) {
    return (
      <ShellTool
        args={args}
        isComplete={isComplete}
        result={result}
        toolName={toolName}
      />
    );
  }

  if (isToolNameMatch(toolName, PACKAGE_TOOL_NAMES)) {
    return <PackageTool args={args} />;
  }

  if (isToolNameMatch(toolName, HTTP_TOOL_NAMES)) {
    return <HttpTool args={args} isComplete={isComplete} result={result} />;
  }

  if (isToolNameMatch(toolName, TEST_TOOL_NAMES)) {
    return <TestTool isComplete={isComplete} result={result} />;
  }

  if (isToolNameMatch(toolName, CODEGEN_TOOL_NAMES)) {
    return <CodegenTool args={args} isComplete={isComplete} result={result} />;
  }

  if (isBrowserTool(toolName)) {
    return (
      <BrowserTool
        args={args}
        isComplete={isComplete}
        result={result}
        toolName={toolName}
      />
    );
  }

  if (isDesktopTool(toolName)) {
    return <DesktopTool args={args} isComplete={isComplete} />;
  }

  if (isMediaTool(toolName, result)) {
    return (
      <MediaTool
        isComplete={isComplete}
        result={result}
        toolPart={part}
      />
    );
  }

  return (
    <FallbackTool
      args={args}
      errorText={errorText}
      isComplete={isComplete}
      result={result}
      toolName={toolName}
    />
  );
}

function ReasoningStep({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}) {
  return (
    <Reasoning defaultOpen isStreaming={isStreaming} open>
      <ReasoningTrigger />
      <ReasoningContent>{text}</ReasoningContent>
    </Reasoning>
  );
}

function SourceDocuments({
  parts,
}: {
  parts: SourceUrlUIPart[];
}) {
  const sources = useMemo(
    () =>
      parts.map(
        (part): SearchSource => ({
          url: part.url,
          title: part.title,
        })
      ),
    [parts]
  );

  return (
    <ChainOfThoughtStep icon={BookIcon} label="Sources" status="complete">
      <Sources className="mt-2 ml-1">
        <SourcesTrigger count={sources.length} />
        <SourcesContent>
          {sources.map((src, i) => (
            <Source key={i} href={src.url} title={src.title || src.url}>
              <BookIcon className="h-4 w-4" />
              <span className="block font-medium">{src.title || src.url}</span>
              {src.url && (
                <span className="text-muted-foreground text-[10px]">
                  {getDomain(src.url)}
                </span>
              )}
            </Source>
          ))}
        </SourcesContent>
      </Sources>
    </ChainOfThoughtStep>
  );
}

function FileAttachments({ parts }: { parts: FileUIPart[] }) {
  const imageParts = parts.filter((part) => part.mediaType.startsWith("image/"));
  const documentParts = parts.filter(
    (part) => !part.mediaType.startsWith("image/")
  );

  return (
    <ChainOfThoughtStep
      icon={FileIcon}
      label="Attachments"
      status="complete"
    >
      <div className="mt-2 ml-1 space-y-2">
        {imageParts.length > 0 && (
          <Attachments variant="grid">
            {imageParts.map((part, index) => (
              <Attachment
                key={`image-${index}`}
                data={{ ...part, id: `file-image-${index}` }}
              >
                <AttachmentPreview />
              </Attachment>
            ))}
          </Attachments>
        )}
        {documentParts.length > 0 && (
          <Attachments variant="inline">
            {documentParts.map((part, index) => (
              <Attachment
                key={`doc-${index}`}
                data={{ ...part, id: `file-doc-${index}` }}
              >
                <AttachmentPreview />
                <AttachmentInfo />
              </Attachment>
            ))}
          </Attachments>
        )}
      </div>
    </ChainOfThoughtStep>
  );
}

export function StrandsChainOfThought({
  message,
  isStreaming = false,
}: StrandsChainOfThoughtProps) {
  const textParts: string[] = [];
  const timelineParts: (
    | { type: "reasoning"; text: string }
    | { type: "tool"; part: ToolPart }
    | { type: "source"; part: SourceUrlUIPart }
    | { type: "file"; part: FileUIPart }
  )[] = [];
  const graphEventsByCall: Record<string, GraphEvent[]> = {};

  for (const part of message.parts) {
    if (part.type === "text") {
      textParts.push(part.text);
      continue;
    }
    if (part.type === "reasoning") {
      timelineParts.push({ type: "reasoning", text: part.text || "" });
      continue;
    }
    if (isToolUIPart(part)) {
      timelineParts.push({ type: "tool", part });
      continue;
    }
    if (part.type === "source-url") {
      timelineParts.push({ type: "source", part });
      continue;
    }
    if (part.type === "file") {
      timelineParts.push({ type: "file", part });
      continue;
    }
    if (part.type === "data-graph") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (part as any).data as GraphEvent | undefined;
      if (data?.toolCallId) {
        (graphEventsByCall[data.toolCallId] ||= []).push(data);
      }
      continue;
    }
  }

  const sourceParts = timelineParts
    .filter((p): p is { type: "source"; part: SourceUrlUIPart } =>
      p.type === "source"
    )
    .map((p) => p.part);
  const fileParts = timelineParts
    .filter((p): p is { type: "file"; part: FileUIPart } => p.type === "file")
    .map((p) => p.part);

  return (
    <div className="space-y-4">
      {textParts.length > 0 && (
        <div className="relative">
          <div className="absolute -inset-1 rounded-[24px] bg-gradient-to-r from-[#3730A3]/12 via-[#6366F1]/5 to-transparent blur-xl" />
          <div className="relative rounded-2xl border border-white/10 bg-[#0c0c14] px-6 py-5 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_8px_30px_rgba(0,0,0,0.5)]">
            <MessageResponse className="prose prose-invert max-w-none font-serif text-[15.5px] leading-8 tracking-[0.01em] prose-headings:font-serif prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-white prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg prose-p:my-3.5 prose-p:leading-8 prose-li:my-1.5 prose-strong:text-white prose-a:text-indigo-300 prose-blockquote:border-l-2 prose-blockquote:border-indigo-400/40 prose-blockquote:pl-4 prose-blockquote:italic prose-code:text-[13px] prose-pre:bg-[#050508] prose-hr:border-white/10">
              {textParts.join("\n")}
            </MessageResponse>
          </div>
        </div>
      )}

      {timelineParts.length > 0 && (
        <ChainOfThought defaultOpen>
          <ChainOfThoughtHeader>Agent Execution Timeline</ChainOfThoughtHeader>
          <ChainOfThoughtContent>
            {timelineParts.map((item, index) => {
              const isLast = index === timelineParts.length - 1;
              const active = isLast && isStreaming;

              if (item.type === "reasoning") {
                return (
                  <ReasoningStep
                    key={`reasoning-${index}`}
                    isStreaming={active}
                    text={item.text}
                  />
                );
              }

              if (item.type === "tool") {
                return (
                  <ToolStep
                    graphEvents={
                      graphEventsByCall[item.part.toolCallId] ?? undefined
                    }
                    isStreaming={active}
                    key={`tool-${item.part.toolCallId || index}`}
                    part={item.part}
                  />
                );
              }

              if (item.type === "source") {
                return (
                  <SourceDocuments
                    key={`source-${index}`}
                    parts={[item.part]}
                  />
                );
              }

              if (item.type === "file") {
                return (
                  <FileAttachments
                    key={`file-${index}`}
                    parts={[item.part]}
                  />
                );
              }

              return null;
            })}
          </ChainOfThoughtContent>
        </ChainOfThought>
      )}

      {sourceParts.length > 1 && (
        <SourceDocuments parts={sourceParts} />
      )}
      {fileParts.length > 1 && (
        <FileAttachments parts={fileParts} />
      )}
    </div>
  );
}

export const MemoizedStrandsChainOfThought = memo(StrandsChainOfThought);
