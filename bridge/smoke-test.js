#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "bridge-config.json"), "utf8"),
  );
  const response = await fetch(`http://${config.host}:${config.port}/v1/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-YouTube-Digest-Token": config.token,
    },
    body: JSON.stringify({
      messages: [
        {
          role: "system",
          content: "Return a tiny valid JSON object with the requested value.",
        },
        {
          role: "user",
          content: "Use exactly this semantic value: local-bridge-ok",
        },
      ],
      maxTokens: 128,
      responseFormat: { type: "json_object" },
    }),
  });
  const body = await response.json();
  if (!response.ok || body?.ok !== true || !/local-bridge-ok/.test(body.text)) {
    throw new Error(body?.error || "Unexpected local bridge response");
  }
  process.stdout.write("Local Codex bridge smoke test passed.\n");
}

main().catch((error) => {
  process.stderr.write(`Local Codex bridge smoke test failed: ${error.message}\n`);
  process.exitCode = 1;
});
