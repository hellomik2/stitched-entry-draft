#!/usr/bin/env tsx

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lookupHts } from "../../src/core/hts.js";
import type { HtsTable } from "../../src/core/hts.js";

// Load the HTS table once at startup
const table: HtsTable = JSON.parse(
  readFileSync(join(process.cwd(), "data", "hts", "2026HTSRev23-subset.json"), "utf8"),
) as HtsTable;

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function sendReply(reply: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(reply) + "\n");
}

function sendError(id: string | number | null | undefined, code: number, message: string): void {
  sendReply({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });
}

function parseMessage(line: string): JsonRpcRequest | null {
  try {
    return JSON.parse(line) as JsonRpcRequest;
  } catch {
    return null;
  }
}

function handleInitialize(id: string | number | null | undefined, params: unknown): void {
  const initParams = params as { protocolVersion?: string } | undefined;
  sendReply({
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: initParams?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "hts-lookup", version: "0.1.0" },
    },
  });
}

function handleToolsList(id: string | number | null | undefined): void {
  sendReply({
    jsonrpc: "2.0",
    id,
    result: {
      tools: [
        {
          name: "lookup_hts",
          description:
            "Check whether an HTS number exists in the 2026 Harmonized Tariff Schedule (Revision 23) and report its general rate, unit of quantity, and any Chapter 99 additional duty footnotes. This tool only verifies that a number printed on a document exists in the shipped HTS revision; it never proposes or chooses a classification.",
          inputSchema: {
            type: "object",
            properties: {
              number: { type: "string" },
            },
            required: ["number"],
          },
        },
      ],
    },
  });
}

function handleToolsCall(id: string | number | null | undefined, params: unknown): void {
  const callParams = params as { name?: unknown; arguments?: unknown } | undefined;

  if (callParams?.name !== "lookup_hts") {
    sendReply({
      jsonrpc: "2.0",
      id,
      result: {
        isError: true,
        content: [{ type: "text", text: "Unknown tool name. Expected 'lookup_hts'." }],
      },
    });
    return;
  }

  const args = callParams?.arguments as { number?: unknown } | undefined;

  if (typeof args?.number !== "string") {
    sendReply({
      jsonrpc: "2.0",
      id,
      result: {
        isError: true,
        content: [{ type: "text", text: "Argument 'number' must be a string." }],
      },
    });
    return;
  }

  const result = lookupHts(table, args.number);

  const body = result.found
    ? {
        found: true,
        revision: table.revision,
        number: result.number.entry,
        description: result.row.description,
        rate: result.rateText,
        rateFrom: result.rateFrom,
        unit: result.unit,
        chapter99: result.chapter99,
      }
    : {
        found: false,
        revision: table.revision,
        number: result.number ? result.number.entry : null,
        reason: result.reason,
      };

  sendReply({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(body) }],
    },
  });
}

function handleMessage(line: string): void {
  const message = parseMessage(line);

  if (!message) {
    sendError(null, -32700, "Parse error");
    return;
  }

  const { jsonrpc, id, method, params } = message;

  // Validate JSON-RPC version
  if (jsonrpc !== "2.0") {
    sendError(id, -32600, "Invalid JSON-RPC version");
    return;
  }

  // If no id, it's a notification - do not reply
  if (id === null || id === undefined) {
    if (method === "ping") {
      // Ping is a notification, so do not reply
      return;
    }
    return;
  }

  // Handle known methods
  switch (method) {
    case "initialize":
      handleInitialize(id, params);
      break;

    case "tools/list":
      handleToolsList(id);
      break;

    case "tools/call":
      handleToolsCall(id, params);
      break;

    default:
      sendError(id, -32601, "Method not found");
  }
}

// Main loop: read from stdin
const readline = createInterface({
  input: process.stdin,
  terminal: false,
});

readline.on("line", (line: string) => {
  if (line.trim()) {
    handleMessage(line);
  }
});

readline.on("close", () => {
  // Process ends when stdin closes
});
