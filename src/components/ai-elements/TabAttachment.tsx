"use client";

import type { ComponentProps } from "react";
import type { ContextItem } from "@/components/agent-panel/ContextPicker";

import {
  Attachment,
  Attachments,
  AttachmentRemove,
  AttachmentHoverCard,
  AttachmentHoverCardTrigger,
  AttachmentHoverCardContent,
} from "@/components/ai-elements/attachments";
import {
  Artifact,
  ArtifactHeader,
  ArtifactTitle,
  ArtifactDescription,
  ArtifactContent,
} from "@/components/ai-elements/artifact";
import {
  WebPreview,
  WebPreviewNavigation,
  WebPreviewUrl,
  WebPreviewBody,
} from "@/components/ai-elements/web-preview";
import { cn } from "@/lib/utils";
import { GlobeIcon } from "lucide-react";
import { memo, useState } from "react";

// ============================================================================
// TabAttachmentItem — Single tab shown as a rich attachment
// ============================================================================

export type TabAttachmentItemProps = ComponentProps<"div"> & {
  tab: ContextItem;
  onRemove?: () => void;
  /** Whether to show the hover preview (disable for sent messages) */
  showPreview?: boolean;
};

/**
 * Bridges a ContextItem (type === 'tab') to the AI Elements Attachment
 * component, adding a HoverCard with an Artifact-wrapped WebPreview iframe.
 */
export const TabAttachmentItem = memo(function TabAttachmentItem({
  tab,
  onRemove,
  showPreview = true,
  className,
  ...props
}: TabAttachmentItemProps) {
  const [imgError, setImgError] = useState(false);

  // Build an AttachmentData-compatible object for the Attachment context
  const attachmentData = {
    id: tab.id,
    type: "file" as const,
    mediaType: "image/jpeg",
    filename: tab.title || tab.name,
    url: tab.screenshotUrl || "",
  };

  // The visual attachment chip
  const attachmentContent = (
    <Attachment
      data={attachmentData}
      onRemove={onRemove}
      className={cn(
        "flex h-10 cursor-pointer select-none items-center gap-2",
        "rounded-lg border border-border/60 px-2",
        "font-medium text-sm transition-all",
        "hover:bg-accent/10 hover:border-accent/30",
        "bg-background/80 backdrop-blur-sm",
        className
      )}
      {...props}
    >
      {/* Screenshot thumbnail or fallback */}
      <div className="relative size-7 shrink-0 overflow-hidden rounded-md bg-muted">
        {tab.screenshotUrl && !imgError ? (
          <img
            src={tab.screenshotUrl}
            alt={tab.title || tab.name}
            className="size-full object-cover transition-transform duration-300 group-hover:scale-110"
            onError={() => setImgError(true)}
          />
        ) : tab.favicon ? (
          <img
            src={tab.favicon}
            alt=""
            className="size-4 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
          />
        ) : (
          <GlobeIcon className="size-3.5 text-muted-foreground absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
        )}
      </div>

      {/* Title + domain */}
      <div className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground max-w-[140px]">
          {tab.title || tab.name}
        </span>
        {tab.url && (
          <span className="block truncate text-[10px] text-muted-foreground max-w-[140px]">
            {new URL(tab.url).hostname}
          </span>
        )}
      </div>

      {/* Remove button */}
      {onRemove && <AttachmentRemove className="size-5 rounded p-0 opacity-0 group-hover:opacity-100 [&>svg]:size-3" />}
    </Attachment>
  );

  // If preview is disabled, just return the chip
  if (!showPreview || !tab.url) {
    return (
      <Attachments variant="inline">
        {attachmentContent}
      </Attachments>
    );
  }

  // Wrap in HoverCard with Artifact + WebPreview
  return (
    <Attachments variant="inline">
      <AttachmentHoverCard openDelay={300} closeDelay={200}>
        <AttachmentHoverCardTrigger asChild>
          {attachmentContent}
        </AttachmentHoverCardTrigger>
        <AttachmentHoverCardContent
          side="top"
          align="start"
          className="w-[480px] p-0 overflow-hidden"
        >
          <Artifact className="border-0 shadow-none">
            <ArtifactHeader className="px-3 py-2 border-b bg-muted/30">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {tab.favicon && (
                  <img src={tab.favicon} alt="" className="size-4 rounded shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <ArtifactTitle className="text-xs truncate">
                    {tab.title || tab.name}
                  </ArtifactTitle>
                  <ArtifactDescription className="text-[10px] truncate">
                    {tab.url}
                  </ArtifactDescription>
                </div>
              </div>
            </ArtifactHeader>
            <ArtifactContent className="p-0 h-[320px]">
              <WebPreview defaultUrl={tab.url} className="border-0 rounded-none h-full">
                <WebPreviewNavigation className="border-b px-2 py-1">
                  <WebPreviewUrl className="h-6 text-xs" readOnly />
                </WebPreviewNavigation>
                <WebPreviewBody className="size-full" />
              </WebPreview>
            </ArtifactContent>
          </Artifact>
        </AttachmentHoverCardContent>
      </AttachmentHoverCard>
    </Attachments>
  );
});

// ============================================================================
// TabAttachments — Container for multiple tab attachments
// ============================================================================

export type TabAttachmentsProps = ComponentProps<"div"> & {
  tabs: ContextItem[];
  onRemove?: (tabId: string) => void;
  showPreview?: boolean;
};

/**
 * Renders a row of tab attachment chips.
 * Used in the composer area of CenterPane and EmptyState.
 */
export const TabAttachments = memo(function TabAttachments({
  tabs,
  onRemove,
  showPreview = true,
  className,
  ...props
}: TabAttachmentsProps) {
  if (tabs.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)} {...props}>
      {tabs.map((tab) => (
        <TabAttachmentItem
          key={tab.id}
          tab={tab}
          onRemove={onRemove ? () => onRemove(tab.id) : undefined}
          showPreview={showPreview}
        />
      ))}
    </div>
  );
});

TabAttachmentItem.displayName = "TabAttachmentItem";
TabAttachments.displayName = "TabAttachments";
