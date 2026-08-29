#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const bridgeDir = __dirname;
const projectRoot = path.resolve(bridgeDir, "..");
const jsonPath = path.join(bridgeDir, "bridge-config.json");
const extensionPath = path.join(projectRoot, "bridge-config.js");
const workspacePath = path.join(bridgeDir, "workspace-config.json");

function loadExistingConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    if (
      parsed.port === 43110 &&
      typeof parsed.token === "string" &&
      /^[a-f0-9]{64}$/.test(parsed.token)
    ) {
      return parsed;
    }
  } catch {
    // A fresh local-only configuration is generated below.
  }
  return null;
}

const existingConfig = loadExistingConfig();
const config = {
  host: "127.0.0.1",
  port: 43110,
  token: existingConfig?.token || crypto.randomBytes(32).toString("hex"),
};
const extensionConfig = `globalThis.YTD_LOCAL_BRIDGE = Object.freeze(${JSON.stringify(
  {
    baseUrl: `http://${config.host}:${config.port}`,
    token: config.token,
  },
  null,
  2,
)});\n`;

fs.writeFileSync(jsonPath, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
});
fs.writeFileSync(extensionPath, extensionConfig, { mode: 0o600 });
fs.chmodSync(jsonPath, 0o600);
fs.chmodSync(extensionPath, 0o600);

if (!fs.existsSync(workspacePath)) {
  const workspaceConfig = {
    workspaceRoot: path.join(
      os.homedir(),
      "Documents",
      "youtube-digest-creator-workspace",
    ),
  };
  fs.writeFileSync(
    workspacePath,
    `${JSON.stringify(workspaceConfig, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(workspacePath, 0o600);
}

process.stdout.write("Local bridge and Creator Workspace configuration are ready.\n");
