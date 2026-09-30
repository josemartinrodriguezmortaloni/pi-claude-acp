// Minimal ACP agent process: answers initialize and session/new, then dies on session/prompt.
import { createInterface } from "node:readline";

process.stderr.write(`pid:${process.pid}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const RESULTS = {
  initialize: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } },
  "session/new": { sessionId: "s1" },
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method in RESULTS) send({ id: message.id, result: RESULTS[message.method] });
  if (message.method === "session/prompt") {
    process.stderr.write("fatal: boom\n");
    process.exit(3);
  }
});
