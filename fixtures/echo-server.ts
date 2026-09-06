// Minimal MCP stdio server used by the e2e tests.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo-server", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo a message back, optionally repeated and uppercased",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Message to echo" },
          times: { type: "integer", default: 1, description: "Repeat count" },
          upper: { type: "boolean", description: "Uppercase the message" },
          mode: { type: "string", enum: ["plain", "shout"], description: "Echo mode" },
        },
        required: ["message"],
      },
    },
    {
      name: "complex",
      description: "Takes object parameters that cannot be flags",
      inputSchema: {
        type: "object",
        properties: {
          spec: { type: "object", description: "Arbitrary spec object" },
          tags: { type: "array", items: { type: "string" }, description: "Tags" },
        },
        required: ["spec"],
      },
    },
    {
      name: "fail",
      description: "Always reports a tool error",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "slow",
      description: "Sleeps before responding",
      inputSchema: { type: "object", properties: { ms: { type: "integer" } } },
    },
    {
      name: "double",
      description: "Returns a doubly-encoded JSON payload (as many HTTP servers do)",
      inputSchema: { type: "object", properties: { n: { type: "integer" } } },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = (req.params as { arguments?: Record<string, unknown> }).arguments || {};
  switch ((req.params as { name: string }).name) {
    case "echo": {
      let m = a.message as string;
      if (a.upper) m = m.toUpperCase();
      if (a.mode === "shout") m = m.toUpperCase() + "!!!";
      const times = Math.max(1, (a.times as number) ?? 1);
      return { content: [{ type: "text", text: Array(times).fill(m).join(" ") }] };
    }
    case "complex":
      return { content: [{ type: "text", text: JSON.stringify({ received: a.spec, receivedTags: a.tags }) }] };
    case "fail":
      return { isError: true, content: [{ type: "text", text: "boom: intentional failure" }] };
    case "slow":
      await new Promise<void>((r) => setTimeout(r, (a.ms as number) ?? 1000));
      return { content: [{ type: "text", text: "done" }] };
    case "double": {
      const payload = [{ id: (a.n as number) ?? 1 }, { id: ((a.n as number) ?? 1) + 1 }];
      return { content: [{ type: "text", text: JSON.stringify(JSON.stringify(payload)) }] };
    }
    default:
      return { isError: true, content: [{ type: "text", text: "unknown tool: " + (req.params as { name: string }).name }] };
  }
});

await server.connect(new StdioServerTransport());
