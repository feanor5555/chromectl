/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type DaemonMessage =
  | {
      method: 'stop';
    }
  | {
      method: 'status';
    }
  | {
      method: 'invoke_tool';
      tool: string;
      args?: Record<string, unknown>;
      /**
       * Lifts human pacing for this one call. It is a property of the call, not
       * an argument of the tool, and travels on as the MCP request's metadata.
       */
      fullSpeed?: boolean;
    };

export interface DaemonResponse {
  success: boolean;
  // Stringified CallToolResult.
  result: string;
  error: unknown;
}

export interface DaemonStatusResult {
  pid: number | null;
  socketPath: string;
  startDate: string;
  version: string;
  args: string[];
}
