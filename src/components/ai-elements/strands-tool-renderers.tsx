import { useRenderToolCall, useHumanInTheLoop } from "@copilotkit/react-core";
import { Sources, Source, SourcesTrigger, SourcesContent } from "./sources";
import { Artifact, ArtifactContent } from "./artifact";
import { Task, TaskTrigger, TaskContent, TaskItem } from "./task";
import { Attachments, Attachment, AttachmentPreview, AttachmentInfo } from "./attachments";
import { TestResults, TestSuite, Test } from "./test-results";
import { Terminal } from "./terminal";
import { CodeBlock } from "./code-block";
import { Canvas } from "./canvas";
import { Confirmation, ConfirmationTitle, ConfirmationRequest, ConfirmationActions, ConfirmationAction } from "./confirmation";
import { Queue } from "./queue";
import { EnvironmentVariables, EnvironmentVariableGroup, EnvironmentVariable } from "./environment-variables";
import { Suggestion } from "./suggestion";
import { Checkpoint } from "./checkpoint";
import { Snippet, SnippetInput, SnippetCopyButton } from "./snippet";
import { FileTree } from "./file-tree";
import { AudioPlayer, AudioPlayerElement } from "./audio-player";
import { Transcription } from "./transcription";

interface SourceRecord {
  title?: string;
  url?: string;
}

interface WebhookEventRecord {
  id?: string;
  type?: string;
}

export function useStrandsToolRenderers() {
  
  // ==========================================================================
  // MEDICAL / LITERATURE
  // ==========================================================================
  useRenderToolCall({
    name: "pubmed_fetch_citations",
    render: ({ status, result }) => (
      <div className="py-2 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <Sources>
          <SourcesTrigger count={status === "complete" && result?.citations ? result.citations.length : 0}>
            {status !== "complete" ? "Loading PubMed Citations..." : `Used ${result?.citations?.length || 0} sources`}
          </SourcesTrigger>
          <SourcesContent>
            {status === "complete" && result?.citations?.map((c: SourceRecord, i: number) => (
              <Source key={i} title={c.title} href={c.url} />
            ))}
          </SourcesContent>
        </Sources>
      </div>
    ),
  });

  useRenderToolCall({
    name: "pubmed_fetch_related",
    render: ({ status, result }) => (
      <div className="py-2 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <Sources>
          <SourcesTrigger count={status === "complete" && result?.papers ? result.papers.length : 0}>
            {status !== "complete" ? `Finding related papers...` : `Used ${result?.papers?.length || 0} sources`}
          </SourcesTrigger>
          <SourcesContent>
            {status === "complete" && result?.papers?.map((p: SourceRecord, i: number) => (
              <Source key={i} title={p.title} href={p.url} />
            ))}
          </SourcesContent>
        </Sources>
      </div>
    ),
  });

  useRenderToolCall({
    name: "pubmed_fetch_summaries",
    render: ({ status, result }) => (
      <div className="py-3 animate-in fade-in slide-in-from-bottom-2 duration-500">
        <Artifact>
          <ArtifactContent className="p-5 text-sm leading-relaxed border bg-muted/20 rounded-xl shadow-sm">
            {status === "complete" ? result?.abstract_summary || "Summaries loaded." : (
              <div className="flex items-center gap-2 text-muted-foreground animate-pulse">
                <span className="size-2 rounded-full bg-primary" /> Fetching summaries...
              </div>
            )}
          </ArtifactContent>
        </Artifact>
      </div>
    ),
  });

  // ==========================================================================
  // DICOM / IMAGING
  // ==========================================================================
  useRenderToolCall({
    name: "dicom_store_orthanc",
    render: ({ args, status }) => (
      <div className="py-2 w-full max-w-sm">
        <Task defaultOpen={status !== "complete"}>
          <TaskTrigger title="Store DICOM to Orthanc" />
          <TaskContent className="bg-muted/10 rounded-b-md p-3">
            <TaskItem>{status === "complete" ? "Transfer complete" : `Transferring ${args?.file_path || "file"}...`}</TaskItem>
          </TaskContent>
        </Task>
      </div>
    ),
  });

  useRenderToolCall({
    name: "dicom_wado_retrieve",
    render: ({ status, result }) => (
      <div className="py-3">
        {status === "complete" && result?.file_urls ? (
          <div className="bg-muted/20 border rounded-xl p-4 shadow-sm animate-in zoom-in-95 duration-300">
            <Attachments variant="inline">
              {result.file_urls.map((url: string, i: number) => (
                <Attachment key={i} data={{ id: String(i), type: "file", url, mediaType: "application/dicom", filename: "instance.dcm" }}>
                  <AttachmentInfo />
                </Attachment>
              ))}
            </Attachments>
          </div>
        ) : (
          <div className="flex items-center gap-3 text-sm text-muted-foreground py-2 px-3 bg-muted/30 rounded-lg w-fit">
            <span className="relative flex h-3 w-3"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span><span className="relative inline-flex rounded-full h-3 w-3 bg-primary"></span></span>
            Retrieving study...
          </div>
        )}
      </div>
    ),
  });

  useRenderToolCall({
    name: "dicom_to_png",
    render: ({ status, result }) => (
      <div className="py-3">
        {status === "complete" && result?.png_url ? (
          <div className="bg-background border rounded-xl p-3 shadow-sm hover:shadow-md transition-shadow duration-300">
            <Attachments variant="inline">
              <Attachment data={{ id: "converted-png", type: "file", url: result.png_url, mediaType: "image/png", filename: "converted.png" }}>
                <AttachmentPreview />
                <AttachmentInfo />
              </Attachment>
            </Attachments>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/20 py-2 px-4 rounded-full w-fit">
            <span className="animate-spin text-primary">⟳</span> Converting DICOM to PNG...
          </div>
        )}
      </div>
    ),
  });

  useRenderToolCall({
    name: "dicom_validate_tags",
    render: ({ status, result }) => {
      const passed = result?.passed || 0;
      const failed = result?.failed || 0;
      const total = passed + failed;
      return (
        <div className="py-3">
          <TestResults summary={{ passed, failed, skipped: 0, total, duration: 0 }}>
            <TestSuite name="DICOM Validation" status={status === "complete" ? ((failed) > 0 ? "failed" : "passed") : "running"}>
              <Test name="Tag Validation" status={status === "complete" ? ((failed) > 0 ? "failed" : "passed") : "running"} />
            </TestSuite>
          </TestResults>
        </div>
      );
    },
  });

  // ==========================================================================
  // TELEPHONY / VOICE
  // ==========================================================================
  useRenderToolCall({
    name: "listen",
    render: ({ status, result }) => (
      <div className="py-3 max-w-lg">
        {status === "complete" && result?.transcript ? (
          <div className="bg-primary/5 border border-primary/10 rounded-xl p-4 shadow-sm text-foreground leading-relaxed">
            <Transcription segments={result.segments || [{ text: result.transcript, startSecond: 0, endSecond: 1 }]} currentTime={0}>
              {(segment, index) => (
                <span key={index}>{segment.text} </span>
              )}
            </Transcription>
          </div>
        ) : (
          <div className="flex items-center gap-3 text-sm text-muted-foreground p-3 rounded-full bg-muted/30 w-fit">
             <div className="flex gap-1">
              <div className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
            Listening...
          </div>
        )}
      </div>
    ),
  });

  useRenderToolCall({
    name: "speak",
    render: ({ status, result }) => (
      <div className="py-3">
        {status === "complete" && result?.audio_url ? (
          <div className="border bg-background shadow-sm rounded-full p-1 max-w-sm">
            <AudioPlayer>
              <AudioPlayerElement src={result.audio_url} />
            </AudioPlayer>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground animate-pulse flex items-center gap-2">
            <span className="size-2 bg-primary rounded-full" /> Synthesizing speech...
          </div>
        )}
      </div>
    ),
  });

  useRenderToolCall({
    name: "playback_start",
    render: ({ status, result }) => (
      <div className="py-3">
        {status === "complete" && result?.stream_url ? (
          <div className="border bg-background shadow-sm rounded-full p-1 max-w-sm">
             <AudioPlayer>
              <AudioPlayerElement src={result.stream_url} />
            </AudioPlayer>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground animate-pulse flex items-center gap-2">
             <span className="size-2 bg-primary rounded-full" /> Starting playback...
          </div>
        )}
      </div>
    ),
  });

  useRenderToolCall({
    name: "playback_stop",
    render: ({ status }) => (
      <div className="py-2 px-3 bg-muted/40 rounded-md text-sm text-muted-foreground w-fit">
        {status === "complete" ? "Playback stopped." : "Stopping playback..."}
      </div>
    ),
  });

  // ==========================================================================
  // RESEARCH / IDE / WEB DATA
  // ==========================================================================
  useRenderToolCall({
    name: "cursor",
    render: ({ args, status }) => (
      <div className="py-3">
        <div className="bg-muted/30 border border-muted-foreground/20 rounded-lg p-3 font-mono text-xs w-fit shadow-inner">
          <Snippet code={status === "complete" ? `Cursor positioned at ${args?.line}:${args?.column} in ${args?.file}` : "Updating cursor..."}>
            <SnippetInput />
            <SnippetCopyButton />
          </Snippet>
        </div>
      </div>
    ),
  });

  useRenderToolCall({
    name: "exa_get_contents",
    render: ({ status, result }) => (
      <div className="py-3 max-w-3xl">
        <Artifact>
          <ArtifactContent className="p-6 text-sm prose dark:prose-invert max-h-[400px] overflow-y-auto bg-background rounded-xl border shadow-sm">
            {status === "complete" ? result?.text : (
              <div className="space-y-3 animate-pulse">
                <div className="h-4 bg-muted rounded w-3/4"></div>
                <div className="h-4 bg-muted rounded w-full"></div>
                <div className="h-4 bg-muted rounded w-5/6"></div>
              </div>
            )}
          </ArtifactContent>
        </Artifact>
      </div>
    ),
  });

  useRenderToolCall({
    name: "exa_search",
    render: ({ status, result }) => (
      <div className="py-2">
        <Sources>
          <SourcesTrigger count={status === "complete" && result?.results ? result.results.length : 0}>
            {status !== "complete" ? "Searching..." : `Used ${result?.results?.length || 0} sources`}
          </SourcesTrigger>
          <SourcesContent>
            {status === "complete" && result?.results?.map((r: SourceRecord, i: number) => (
              <Source key={i} title={r.title} href={r.url} />
            ))}
          </SourcesContent>
        </Sources>
      </div>
    ),
  });

  useRenderToolCall({
    name: "perplexity_search_api",
    render: ({ status, result }) => (
      <div className="py-2">
        <Sources>
          <SourcesTrigger count={status === "complete" && result?.citations ? result.citations.length : 0}>
            {status !== "complete" ? "Searching..." : `Used ${result?.citations?.length || 0} sources`}
          </SourcesTrigger>
          <SourcesContent>
            {status === "complete" && result?.citations?.map((c: string, i: number) => (
              <Source key={i} title={`Source ${i+1}`} href={c} />
            ))}
          </SourcesContent>
        </Sources>
      </div>
    ),
  });

  useRenderToolCall({
    name: "perplexity_sonar_pro",
    render: ({ status, result }) => (
      <div className="py-2">
        <Sources>
          <SourcesTrigger count={status === "complete" && result?.citations ? result.citations.length : 0}>
            {status !== "complete" ? "Searching..." : `Used ${result?.citations?.length || 0} sources`}
          </SourcesTrigger>
          <SourcesContent>
            {status === "complete" && result?.citations?.map((c: string, i: number) => (
              <Source key={i} title={`Source ${i+1}`} href={c} />
            ))}
          </SourcesContent>
        </Sources>
      </div>
    ),
  });

  useRenderToolCall({
    name: "tavily_extract",
    render: ({ status, result }) => (
      <div className="py-3">
        <Artifact>
          <ArtifactContent className="p-5 text-sm bg-muted/10 border rounded-xl shadow-sm">
            {status === "complete" ? <pre className="font-mono text-xs overflow-x-auto">{JSON.stringify(result?.data, null, 2)}</pre> : (
              <div className="flex items-center gap-2 text-muted-foreground"><span className="animate-spin">⟳</span> Extracting content...</div>
            )}
          </ArtifactContent>
        </Artifact>
      </div>
    ),
  });

  useRenderToolCall({
    name: "tavily_map",
    render: ({ status, result }) => (
      <div className="py-3 max-w-xl">
        <div className="border bg-background shadow-sm p-4 rounded-xl">
          {status === "complete" && result?.map ? <FileTree /> : <div className="flex items-center gap-2 text-sm text-muted-foreground animate-pulse">Mapping site...</div>}
        </div>
      </div>
    ),
  });

  useRenderToolCall({
    name: "tavily_search",
    render: ({ status, result }) => (
      <div className="py-2">
        <Sources>
          <SourcesTrigger count={status === "complete" && result?.results ? result.results.length : 0}>
            {status !== "complete" ? "Searching..." : `Used ${result?.results?.length || 0} sources`}
          </SourcesTrigger>
          <SourcesContent>
            {status === "complete" && result?.results?.map((r: SourceRecord, i: number) => (
              <Source key={i} title={r.title} href={r.url} />
            ))}
          </SourcesContent>
        </Sources>
      </div>
    ),
  });

  // ==========================================================================
  // PROJECTS / CLOUD / SECRETS / WEBHOOKS
  // ==========================================================================
  useRenderToolCall({
    name: "add_task_relationship",
    render: ({ status, args }) => (
      <div className="py-3">
        <div className="h-[250px] border shadow-sm rounded-xl overflow-hidden bg-dot-pattern">
          <Canvas nodes={[{ id: '1', data: { label: args?.source || 'Source' }, position: {x: 50, y: 100} }, { id: '2', data: { label: args?.target || 'Target' }, position: {x: 250, y: 100} }]} edges={[{ id: 'e1', source: '1', target: '2', animated: status !== "complete" }]} />
        </div>
      </div>
    ),
  });

  useRenderToolCall({
    name: "add_relationship",
    render: ({ status, args }) => (
      <div className="py-3">
        <div className="h-[250px] border shadow-sm rounded-xl overflow-hidden bg-dot-pattern">
          <Canvas nodes={[{ id: '1', data: { label: args?.entity_a || 'Entity A' }, position: {x: 50, y: 100} }, { id: '2', data: { label: args?.entity_b || 'Entity B' }, position: {x: 250, y: 100} }]} edges={[{ id: 'e1', source: '1', target: '2', animated: status !== "complete", label: args?.relation }]} />
        </div>
      </div>
    ),
  });

  useRenderToolCall({
    name: "get_project_hierarchy",
    render: ({ status }) => (
      <div className="py-3 max-w-sm">
        <div className="border bg-background shadow-sm p-4 rounded-xl">
          {status === "complete" ? <FileTree /> : <div className="text-sm text-muted-foreground flex items-center gap-2"><span className="animate-spin">⟳</span> Loading hierarchy...</div>}
        </div>
      </div>
    ),
  });

  useRenderToolCall({
    name: "cloud_storage_create_bucket",
    render: ({ args, status }) => (
      <div className="py-3 w-fit">
        <Artifact>
          <ArtifactContent className="p-4 bg-muted/20 border rounded-xl flex items-center gap-4">
            <div className="size-8 rounded-full bg-primary/10 flex items-center justify-center">☁️</div>
            <div>
              <div className="text-sm font-semibold">{args?.bucket_name}</div>
              <div className="text-xs text-muted-foreground">{status === "complete" ? "Created successfully" : "Creating..."}</div>
            </div>
          </ArtifactContent>
        </Artifact>
      </div>
    ),
  });

  useHumanInTheLoop({
    name: "cloud_storage_delete_object",
    render: ({ args, status, respond }) => (
      <div className="py-3">
        <Confirmation className="max-w-md shadow-lg border-destructive/20 rounded-xl" state={status === "executing" ? "approval-requested" : status === "complete" ? "output-available" : "input-streaming"}>
          <ConfirmationTitle className="text-destructive">Delete {args?.object_name} from {args?.bucket_name}?</ConfirmationTitle>
          <ConfirmationRequest>This action cannot be undone and will permanently remove the object.</ConfirmationRequest>
          {status === "executing" && (
            <ConfirmationActions className="pt-2">
              <ConfirmationAction variant="outline" onClick={() => respond({ approved: false, reason: "User cancelled" })}>Cancel</ConfirmationAction>
              <ConfirmationAction variant="destructive" onClick={() => respond({ approved: true })}>Delete Object</ConfirmationAction>
            </ConfirmationActions>
          )}
        </Confirmation>
      </div>
    ),
  });

  useRenderToolCall({
    name: "cloud_storage_download_file",
    render: ({ status, result }) => (
      <div className="py-3">
        {status === "complete" && result?.url ? (
          <div className="bg-muted/10 border rounded-xl p-3 shadow-sm hover:shadow-md transition-all w-fit">
            <Attachments variant="inline">
              <Attachment data={{ id: "dl", type: "file", url: result.url, mediaType: "application/octet-stream", filename: "download" }}>
                <AttachmentInfo />
              </Attachment>
            </Attachments>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground bg-muted/30 px-4 py-2 rounded-full w-fit flex items-center gap-2">
            <span className="animate-bounce">↓</span> Downloading...
          </div>
        )}
      </div>
    ),
  });

  useRenderToolCall({
    name: "cloud_storage_list_objects",
    render: ({ status }) => (
      <div className="py-3 max-w-sm">
        <div className="border bg-background shadow-sm p-4 rounded-xl">
          {status === "complete" ? <FileTree /> : <div className="text-sm text-muted-foreground flex items-center gap-2"><span className="animate-spin">⟳</span> Listing objects...</div>}
        </div>
      </div>
    ),
  });

  useRenderToolCall({
    name: "cloud_storage_list_buckets",
    render: ({ status, result }) => (
      <div className="py-3 max-w-sm">
        <Queue className="bg-background border rounded-xl shadow-sm overflow-hidden">
          {status === "complete" ? result?.buckets?.map((b: string, i: number) => (
            <div key={i} className="text-sm p-3 border-b last:border-0 hover:bg-muted/50 transition-colors flex items-center gap-2">
              <span className="text-muted-foreground">☁️</span> {b}
            </div>
          )) : <div className="p-4 text-sm text-muted-foreground animate-pulse">Loading buckets...</div>}
        </Queue>
      </div>
    ),
  });

  useRenderToolCall({
    name: "cloud_storage_upload_file",
    render: ({ status, result }) => (
      <div className="py-3">
        {status === "complete" && result?.url ? (
          <div className="bg-muted/10 border rounded-xl p-3 shadow-sm hover:shadow-md transition-all w-fit">
            <Attachments variant="inline">
              <Attachment data={{ id: "ul", type: "file", url: result.url, mediaType: "application/octet-stream", filename: "uploaded_file" }}>
                <AttachmentInfo />
              </Attachment>
            </Attachments>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground bg-muted/30 px-4 py-2 rounded-full w-fit flex items-center gap-2">
            <span className="animate-bounce">↑</span> Uploading file...
          </div>
        )}
      </div>
    ),
  });

  useHumanInTheLoop({
    name: "create_integration_secret",
    render: ({ args, status, respond }) => (
      <div className="flex flex-col gap-4 py-3">
        {status === "executing" && (
          <Confirmation className="max-w-md shadow-lg border-primary/20 rounded-xl" state="approval-requested">
            <ConfirmationTitle>Store secret '{args?.secret_name}'?</ConfirmationTitle>
            <ConfirmationRequest>Allow agent to store this integration secret securely.</ConfirmationRequest>
            <ConfirmationActions className="pt-2">
              <ConfirmationAction variant="outline" onClick={() => respond({ approved: false, reason: "User rejected" })}>Reject</ConfirmationAction>
              <ConfirmationAction onClick={() => respond({ approved: true })}>Approve</ConfirmationAction>
            </ConfirmationActions>
          </Confirmation>
        )}
        {status === "complete" && (
          <div className="bg-muted/20 border rounded-xl p-4 shadow-sm w-fit animate-in fade-in zoom-in-95">
            <EnvironmentVariables showValues={false}>
              <EnvironmentVariableGroup title="Stored Secrets">
                <EnvironmentVariable name={args?.secret_name || "SECRET"} value="********" />
              </EnvironmentVariableGroup>
            </EnvironmentVariables>
          </div>
        )}
      </div>
    ),
  });

  useHumanInTheLoop({
    name: "delete_integration_secret",
    render: ({ args, status, respond }) => (
      <div className="py-3">
        <Confirmation className="max-w-md shadow-lg border-destructive/20 rounded-xl" state={status === "executing" ? "approval-requested" : "output-available"}>
          <ConfirmationTitle className="text-destructive">Delete secret '{args?.secret_name}'?</ConfirmationTitle>
          <ConfirmationRequest>This will permanently remove the stored integration secret.</ConfirmationRequest>
          {status === "executing" && (
            <ConfirmationActions className="pt-2">
              <ConfirmationAction variant="outline" onClick={() => respond({ approved: false, reason: "User cancelled" })}>Cancel</ConfirmationAction>
              <ConfirmationAction variant="destructive" onClick={() => respond({ approved: true })}>Delete</ConfirmationAction>
            </ConfirmationActions>
          )}
        </Confirmation>
      </div>
    ),
  });

  useRenderToolCall({
    name: "list_integration_secrets",
    render: ({ status, result }) => (
      <div className="py-3">
        {status === "complete" && result?.secrets ? (
          <div className="bg-muted/20 border rounded-xl p-4 shadow-sm w-fit">
            <EnvironmentVariables showValues={false}>
              <EnvironmentVariableGroup title="Integration Secrets">
                {result.secrets.map((sec: string, i: number) => (
                  <EnvironmentVariable key={i} name={sec} value="********" />
                ))}
              </EnvironmentVariableGroup>
            </EnvironmentVariables>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground animate-pulse px-3 py-2 bg-muted/30 rounded-full w-fit">
            Listing secrets...
          </div>
        )}
      </div>
    ),
  });

  useRenderToolCall({
    name: "get_webhook_events",
    render: ({ status, result }) => (
      <div className="py-3 w-full max-w-md">
        <Queue className="bg-background border rounded-xl shadow-sm overflow-hidden">
          {status === "complete" ? result?.events?.map((e: WebhookEventRecord, i: number) => (
            <div key={i} className="text-sm p-3 border-b last:border-0 hover:bg-muted/50 transition-colors flex items-center justify-between">
              <span className="font-semibold">{e.type}</span>
              <span className="text-muted-foreground font-mono text-xs">{e.id}</span>
            </div>
          )) : <div className="p-4 text-sm text-muted-foreground animate-pulse">Waiting for events...</div>}
        </Queue>
      </div>
    ),
  });

  // ==========================================================================
  // TOOLSETS / CATALOG
  // ==========================================================================
  useRenderToolCall({
    name: "list_catalog_categories",
    render: ({ status, result }) => (
      <div className="flex flex-wrap gap-2 py-3">
        {status === "complete" ? result?.categories?.map((cat: string, i: number) => (
          <Suggestion key={i} suggestion={cat} className="shadow-sm hover:shadow transition-shadow" />
        )) : <div className="text-sm text-muted-foreground animate-pulse">Loading categories...</div>}
      </div>
    ),
  });

  // ==========================================================================
  // SYSTEM / ORCHESTRATION / INTERNAL
  // ==========================================================================
  useRenderToolCall({
    name: "asciimatics_ui",
    render: ({ status, result }) => (
      <div className="py-3 w-full max-w-2xl">
        <div className="rounded-xl overflow-hidden border shadow-md bg-black/95">
          <Terminal output={status === "complete" ? result?.screen : "Rendering TUI..."} isStreaming={status !== "complete"} autoScroll={true} />
        </div>
      </div>
    ),
  });

  useRenderToolCall({
    name: "calculator",
    render: ({ status, result }) => (
      status === "complete" ? (
        <div className="py-2">
          <Snippet code={String(result?.value)}>
            <SnippetInput />
            <SnippetCopyButton />
          </Snippet>
        </div>
      ) : <></>
    ),
  });

  useRenderToolCall({
    name: "current_time",
    render: ({ status, result }) => (
      status === "complete" ? (
        <div className="py-2">
          <Snippet code={String(result?.time)}>
            <SnippetInput />
            <SnippetCopyButton />
          </Snippet>
        </div>
      ) : <></>
    ),
  });

  useHumanInTheLoop({
    name: "dialog",
    render: ({ args, status, respond }) => (
      <Confirmation className="max-w-md" state={status === "executing" ? "approval-requested" : "output-available"}>
        <ConfirmationTitle>{args?.title || "System Dialog"}</ConfirmationTitle>
        <ConfirmationRequest>{args?.message}</ConfirmationRequest>
        {status === "executing" && (
          <ConfirmationActions>
            <ConfirmationAction variant="outline" onClick={() => respond({ approved: false, reason: "User cancelled" })}>Cancel</ConfirmationAction>
            <ConfirmationAction onClick={() => respond({ approved: true })}>OK</ConfirmationAction>
          </ConfirmationActions>
        )}
      </Confirmation>
    ),
  });

  useRenderToolCall({
    name: "template",
    render: ({ args, status, result }) => (
      <div className="py-3 w-full max-w-3xl">
        <div className="rounded-xl border shadow-sm overflow-hidden">
          <CodeBlock code={status === "complete" ? result?.rendered || "" : args?.template_string || ""} language="jinja" />
        </div>
      </div>
    ),
  });

  useRenderToolCall({
    name: "batch",
    render: ({ status }) => (
      <div className="py-3 w-full max-w-sm">
        <Task defaultOpen>
          <TaskTrigger title="Batch Execution" />
          <TaskContent className="bg-muted/10 rounded-b-md p-3">
            <TaskItem>{status === "complete" ? "Batch processing complete" : "Executing tools in parallel..."}</TaskItem>
          </TaskContent>
        </Task>
      </div>
    ),
  });

  useRenderToolCall({
    name: "journal",
    render: ({ args, status }) => (
      <div className="py-2 w-full max-w-md">
        <Queue className="border rounded-lg shadow-sm overflow-hidden">
          <div className="p-3 text-sm flex items-center gap-2 bg-background">
            <span className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${args?.level === 'ERROR' ? 'bg-destructive/20 text-destructive' : 'bg-muted text-muted-foreground'}`}>
              {args?.level || "INFO"}
            </span>
            <span className="flex-1 truncate">{args?.message || "Logging..."}</span>
            {status !== "complete" && <span className="flex h-2 w-2 relative"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span><span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span></span>}
          </div>
        </Queue>
      </div>
    ),
  });

  useHumanInTheLoop({
    name: "handoff_to_user",
    render: ({ args, status, respond }) => (
      <div className="py-3 flex flex-col gap-4 max-w-md">
        <div className="flex items-center gap-3">
          <Checkpoint title="Action Required" className="text-primary" />
          <div className="text-sm font-medium text-foreground">{args?.message || "Please provide input to continue."}</div>
        </div>
        
        <div className="flex flex-wrap gap-2 pl-6">
          {args?.suggested_actions?.map((action: string, i: number) => (
            <Suggestion key={i} suggestion={action} className="shadow-sm hover:shadow transition-shadow" />
          ))}
        </div>

        {status === "executing" && (
           <div className="pl-6 pt-2">
             <ConfirmationActions>
               <ConfirmationAction onClick={() => respond({ approved: true })} className="w-full shadow-sm">Acknowledge & Continue</ConfirmationAction>
             </ConfirmationActions>
           </div>
        )}
      </div>
    ),
  });
}
