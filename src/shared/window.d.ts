// Global Window augmentation for the renderer. Lives in src/shared so both
// the preload bundle (which defines window.localbot at runtime) and the
// renderer TypeScript code (which consumes it) reference the same shape.

import type {
  AppInitPayload,
  DaemonStatus,
  DoneEvent,
  ErrorEvent,
  KeyClearResult,
  KeyGetResult,
  KeyProbeResult,
  KeySetResult,
  TokenEvent,
  ToolResultEvent,
  ToolUseEvent,
} from './types';

export type LocalbotChannel =
  | 'message:token'
  | 'message:done'
  | 'message:error'
  | 'message:tool_use'
  | 'message:tool_result'
  | 'daemon:status'
  | 'app:init';

export type LocalbotEventPayload =
  | TokenEvent
  | DoneEvent
  | ErrorEvent
  | ToolUseEvent
  | ToolResultEvent
  | DaemonStatus
  | AppInitPayload;

export interface LocalbotApi {
  sendMessage: (content: string, msgId: string) => Promise<{ ok: boolean; error?: string }>;
  cancel: (msgId: string) => Promise<{ ok: boolean }>;
  key: {
    get: () => Promise<KeyGetResult>;
    set: (key: string) => Promise<KeySetResult>;
    probe: (key: string) => Promise<KeyProbeResult>;
    clear: () => Promise<KeyClearResult>;
  };
  on: (channel: LocalbotChannel, handler: (payload: LocalbotEventPayload) => void) => () => void;
}

declare global {
  interface Window {
    localbot: LocalbotApi;
  }
}

export {};
