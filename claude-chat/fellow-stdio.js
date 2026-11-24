import { createInterface } from "node:readline";

const url = process.env.INKFELLOW_FELLOW_BRIDGE;
const token = process.env.INKFELLOW_FELLOW_TOKEN;
if (!url || !token) throw new Error("Fellow bridge environment missing");

async function handle(message) {
  const { id, method, params } = message;
  if (id == null) return;
  const send = result => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...result }) + "\n");
  try {
    if (method === "initialize") return send({ result: {
      protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(params?.protocolVersion)
        ? params.protocolVersion : "2025-11-25",
      capabilities: { tools: {} }, serverInfo: { name: "fellow", version: "1.0.0" },
    } });
    if (method === "ping") return send({ result: {} });
    if (!["tools/list", "tools/call"].includes(method)) return send({ error: { code: -32601, message: "Unknown MCP method" } });
    const response = await fetch(url, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
    if (!response.ok) throw new Error("Fellow 工具会话已结束或无法访问。");
    send({ result: await response.json() });
  } catch (error) {
    send({ error: { code: -32000, message: error.message } });
  }
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", line => {
  try { void handle(JSON.parse(line)); } catch { /* ignore invalid input frames */ }
});
