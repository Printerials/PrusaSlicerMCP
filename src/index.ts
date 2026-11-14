#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { SlicerContext } from "./context.ts";
import { createServer } from "./server.ts";

const slicer = new SlicerContext();
serveStdio(() => createServer(slicer), {
  onerror: (error) => console.error("[prusaslicer-mcp]", error),
});
