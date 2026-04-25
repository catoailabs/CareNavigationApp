"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronDownIcon, CommandIcon } from "lucide-react";
import type { ComponentProps } from "react";

export type TaskItemFileProps = ComponentProps<"div">;

export const TaskItemFile = ({
  children,
  className,
  ...props
}: TaskItemFileProps) => (
  <div
    className={cn(
      "inline-flex items-center gap-1.5 rounded-md border bg-secondary px-2 py-0.5 text-secondary-foreground text-[11px] font-medium tracking-wide",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type TaskItemProps = ComponentProps<"div">;

export const TaskItem = ({ children, className, ...props }: TaskItemProps) => (
  <div 
    className={cn(
      "rounded-md border bg-card px-3 py-2 text-sm text-card-foreground font-mono shadow-sm", 
      className
    )} 
    {...props}
  >
    {children}
  </div>
);

export type TaskProps = ComponentProps<typeof Collapsible>;

export const Task = ({
  defaultOpen = true,
  className,
  ...props
}: TaskProps) => (
  <Collapsible 
    className={cn("w-full transition-all duration-300", className)} 
    defaultOpen={defaultOpen} 
    {...props} 
  />
);

export type TaskTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string;
};

export const TaskTrigger = ({
  children,
  className,
  title,
  ...props
}: TaskTriggerProps) => (
  <CollapsibleTrigger asChild className={cn("group outline-none", className)} {...props}>
    {children ?? (
      <div className="flex w-full cursor-pointer items-center justify-between rounded-md py-2 px-2 text-sm text-muted-foreground transition-all hover:text-foreground hover:bg-muted/50">
        <div className="flex items-center gap-2">
          <CommandIcon className="size-4 text-muted-foreground group-hover:text-foreground" />
          <p className="font-medium text-foreground">{title}</p>
        </div>
        <ChevronDownIcon className="size-4 transition-transform duration-300 group-data-[state=open]:rotate-180" />
      </div>
    )}
  </CollapsibleTrigger>
);

export type TaskContentProps = ComponentProps<typeof CollapsibleContent>;

export const TaskContent = ({
  children,
  className,
  ...props
}: TaskContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  >
    <div className="mt-2 flex flex-col gap-2 pl-3 border-l-2 border-border/50">
      {children}
    </div>
  </CollapsibleContent>
);
