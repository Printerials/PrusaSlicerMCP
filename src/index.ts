#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { SlicerContext } from "./context.ts";
import { PrinterialsAccount } from "./printerials/account.ts";
import { createServer } from "./server.ts";

const slicer = new SlicerContext();
const account = new PrinterialsAccount();
serveStdio(() => createServer(slicer, account), {
  onerror: (error) => console.error("[prusaslicer-mcp]", error),
});
