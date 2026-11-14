import type { CallToolResult, McpServer, ServerContext, ToolAnnotations, ToolCallback } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { SlicerContext } from "../context.ts";
import { errorMessage, Refusal } from "../util/errors.ts";

export interface ToolDeps {
  slicer: SlicerContext;
}

/** Above this the answer is cut, and says so: a silent cut is worse than a visible one. */
export const MAX_TEXT = 8000;

export function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

export function refusal(message: string, details?: Record<string, unknown>): CallToolResult {
  const text = details && Object.keys(details).length ? `${message}\n${JSON.stringify(details)}` : message;
  return { isError: true, content: [{ type: "text", text }] };
}

/** At most `limit` items, with the total and a note when some were left out. */
export function capList<T>(items: T[], limit: number): { items: T[]; total: number; truncated: boolean } {
  return { items: items.slice(0, limit), total: items.length, truncated: items.length > limit };
}

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const WRITES_NEW_FILES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/**
 * Registers a tool whose handler may throw a Refusal (returned to the model as the reason) or
 * anything else (logged to stderr and returned as a failure with its message).
 */
export function tool<S extends z.ZodObject>(
  server: McpServer,
  name: string,
  config: { title: string; description: string; inputSchema: S; annotations: ToolAnnotations },
  handler: (args: z.infer<S>, ctx: ServerContext) => Promise<CallToolResult>,
): void {
  // ToolCallback<S> is a conditional type that TypeScript cannot resolve for a generic S.
  const callback = (async (args: z.infer<S>, ctx: ServerContext): Promise<CallToolResult> => {
    try {
      return await handler(args, ctx);
    } catch (error) {
      if (error instanceof Refusal) return refusal(error.message, error.details);
      console.error(`[prusaslicer-mcp] ${name} failed:`, error);
      return refusal(`${name} failed: ${errorMessage(error)}`);
    }
  }) as unknown as ToolCallback<S>;
  server.registerTool(name, config, callback);
}

/** Sends progress notifications when the client asked for them with a progress token. */
export function progressReporter(ctx: ServerContext): ((percent: number, message: string) => void) | undefined {
  const token = ctx.mcpReq._meta?.progressToken;
  if (token === undefined) return undefined;
  let last = -1;
  return (percent, message) => {
    if (percent <= last) return;
    last = percent;
    void ctx.mcpReq
      .notify({ method: "notifications/progress", params: { progressToken: token, progress: percent, total: 100, message } })
      .catch(() => undefined);
  };
}
