/**
 * Central registry of React components available to JSXPreview for Gen-UI rendering.
 *
 * The Strands agent emits JSX strings referencing these component names.
 * JSXPreview + react-jsx-parser renders them as live interactive React components.
 */

import { Sources, Source, SourcesTrigger, SourcesContent } from './sources'
import { Artifact, ArtifactContent } from './artifact'
import { Task, TaskTrigger, TaskContent, TaskItem } from './task'
import { Terminal } from './terminal'
import { CodeBlock } from './code-block'
import { Canvas } from './canvas'
import { Queue } from './queue'
import { Suggestion } from './suggestion'
import { Checkpoint } from './checkpoint'
import { Snippet, SnippetInput, SnippetCopyButton } from './snippet'
import { FileTree } from './file-tree'
import { AudioPlayer } from './audio-player'
import { Transcription } from './transcription'
import {
  Confirmation,
  ConfirmationTitle,
  ConfirmationRequest,
  ConfirmationActions,
  ConfirmationAction,
} from './confirmation'
import {
  EnvironmentVariables,
  EnvironmentVariableGroup,
  EnvironmentVariable,
} from './environment-variables'
import {
  Attachments,
  Attachment,
  AttachmentPreview,
  AttachmentInfo,
} from './attachments'
import {
  TestResults,
  TestSuite,
  Test,
} from './test-results'

export const GEN_UI_COMPONENTS = {
  // AI Elements
  Sources,
  Source,
  SourcesTrigger,
  SourcesContent,
  Artifact,
  ArtifactContent,
  Task,
  TaskTrigger,
  TaskContent,
  TaskItem,
  Terminal,
  CodeBlock,
  Canvas,
  Queue,
  Suggestion,
  Checkpoint,
  Snippet,
  SnippetInput,
  SnippetCopyButton,
  FileTree,
  AudioPlayer,
  Transcription,
  Confirmation,
  ConfirmationTitle,
  ConfirmationRequest,
  ConfirmationActions,
  ConfirmationAction,
  EnvironmentVariables,
  EnvironmentVariableGroup,
  EnvironmentVariable,
  Attachments,
  Attachment,
  AttachmentPreview,
  AttachmentInfo,
  TestResults,
  TestSuite,
  Test,
} as const
