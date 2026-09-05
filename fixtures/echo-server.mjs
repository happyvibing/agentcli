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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = req.params.arguments || {};
  switch (req.params.name) {
    case "echo": {
      let m = a.message;
      if (a.upper) m = m.toUpperCase();
      const times = Math.max(1, a.times ?? 1);
      return { content: [{ type: "text", text: Array(times).fill(m).join(" ") }] };
    }
    case "complex":
      return { content: [{ type: "text", text: JSON.stringify({ received: a.spec, receivedTags: a.tags }) }] };
    case "fail":
      return { isError: true, content: [{ type: "text", text: "boom: intentional failure" }] };
    case "slow":
      await new Promise((r) => setTimeout(r, a.ms ?? 1000));
      return { content: [{ type: "text", text: "done" }] };
    default:
      return { isError: true, content: [{ type: "text", text: "unknown tool: " + req.params.name }] };
  }
});

await server.connect(new StdioServerTransport());