const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateLearningPack } = require("../learning-pack.js");

const WORKSPACE_CONFIG_PATH = path.join(__dirname, "workspace-config.json");

function defaultCreatorWorkspaceRoot() {
  return path.join(
    os.homedir(),
    "Documents",
    "youtube-digest-creator-workspace",
  );
}

function validateWorkspaceRoot(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Creator Workspace root must be a non-empty path");
  }
  const resolved = path.resolve(value);
  if (!path.isAbsolute(resolved) || resolved === path.parse(resolved).root) {
    throw new Error("Creator Workspace root must be a bounded absolute directory");
  }
  return resolved;
}

function loadCreatorHandoffRoot(options = {}) {
  const environmentRoot = options.environmentRoot ?? process.env.YTD_CREATOR_WORKSPACE_ROOT;
  if (environmentRoot) {
    return path.join(validateWorkspaceRoot(environmentRoot), "inbox", "youtube-digest");
  }
  const configPath = options.configPath || WORKSPACE_CONFIG_PATH;
  let workspaceRoot = defaultCreatorWorkspaceRoot();
  if (fs.existsSync(configPath)) {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    workspaceRoot = parsed.workspaceRoot;
  }
  return path.join(validateWorkspaceRoot(workspaceRoot), "inbox", "youtube-digest");
}

function quoted(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function renderLearningPackMarkdown(input) {
  const pack = validateLearningPack(input);
  const lines = [
    `# ${pack.source.title}`,
    "",
    `- State: \`${pack.state}\``,
    `- Article intent: \`${pack.articleIntent}\``,
    `- Source: [${pack.source.platform === "bilibili" ? "Bilibili" : "YouTube"}](${pack.source.url})`,
    `- Channel: ${pack.source.channelName || "Unknown"}`,
    `- Created: ${pack.createdAt}`,
    "",
    "> This is a learning-complete intake pack. It does not automatically start an article project or publish content.",
    "",
    "## My reflection",
    "",
    `### My take\n\n${pack.reflection.myTake || "_Not added_"}`,
    "",
    `### Agree / disagree\n\n${pack.reflection.agreeDisagree || "_Not added_"}`,
    "",
    `### Connections\n\n${pack.reflection.connections || "_Not added_"}`,
    "",
    `### Possible core claim\n\n${pack.reflection.coreClaim || "_Not added_"}`,
    "",
    "## Digest",
    "",
    `Status: \`${pack.digest.status}\``,
  ];

  if (pack.digest.summary) lines.push("", pack.digest.summary);
  if (pack.digest.chapters.length) {
    lines.push("", "### Chapters", "");
    for (const chapter of pack.digest.chapters) {
      lines.push(
        `- **${chapter.timestamp} — ${chapter.title}**${chapter.summary ? `: ${chapter.summary}` : ""}`,
      );
    }
  }
  if (pack.digest.keyQuotes.length) {
    lines.push("", "### Key quotes", "");
    for (const quote of pack.digest.keyQuotes) {
      lines.push(`${quoted(quote.quote)}  `, `> — ${quote.timestamp}`, "");
    }
  }

  lines.push("", "## Notes", "");
  if (!pack.notes.length) {
    lines.push("_No saved notes_", "");
  } else {
    for (const note of pack.notes) {
      lines.push(
        `### [${note.timestamp}](${note.timestampedUrl})`,
        "",
        quoted(note.text),
        "",
      );
    }
  }

  lines.push(
    "## Provenance",
    "",
    `- Producer: \`${pack.provenance.producer}\``,
    `- Extension version: \`${pack.provenance.extensionVersion || "unknown"}\``,
    `- Full transcript included: \`${pack.provenance.transcriptIncluded}\``,
    `- Transcript segment count: ${pack.provenance.transcriptSegmentCount}`,
    "",
  );
  return lines.join("\n");
}

function ensureInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Learning Pack target escaped the configured Creator Workspace inbox");
  }
}

function writeLearningPack(input, options = {}) {
  const pack = validateLearningPack(input);
  const configuredRoot = path.resolve(
    options.inboxRoot || loadCreatorHandoffRoot(),
  );
  fs.mkdirSync(configuredRoot, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(configuredRoot).isSymbolicLink()) {
    throw new Error("The Creator Workspace inbox must not be a symbolic link");
  }
  const inboxRoot = fs.realpathSync(configuredRoot);
  const sourceDirectoryName = `${pack.source.platform}-${pack.source.videoId}${
    pack.source.platform === "bilibili" ? `-p${pack.source.pageNumber}` : ""
  }`;
  const requestedVideoDirectory = path.join(inboxRoot, sourceDirectoryName);
  ensureInside(inboxRoot, requestedVideoDirectory);
  fs.mkdirSync(requestedVideoDirectory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(requestedVideoDirectory).isSymbolicLink()) {
    throw new Error("Learning Pack video directory must not be a symbolic link");
  }
  const videoDirectory = fs.realpathSync(requestedVideoDirectory);
  ensureInside(inboxRoot, videoDirectory);

  const stamp = pack.createdAt.replace(/[:.]/g, "-");
  const handoffId = `${stamp}-${crypto.randomBytes(4).toString("hex")}`;
  const handoffDirectory = path.join(videoDirectory, handoffId);
  ensureInside(inboxRoot, handoffDirectory);
  fs.mkdirSync(handoffDirectory, { mode: 0o700 });

  const jsonPath = path.join(handoffDirectory, "learning-pack.json");
  const markdownPath = path.join(handoffDirectory, "learning-pack.md");
  fs.writeFileSync(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.writeFileSync(markdownPath, renderLearningPackMarkdown(pack), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  return {
    handoffId,
    directory: handoffDirectory,
    jsonPath,
    markdownPath,
    state: pack.state,
    articleIntent: pack.articleIntent,
  };
}

function isInboxWritable(inboxRoot = loadCreatorHandoffRoot()) {
  try {
    fs.mkdirSync(inboxRoot, { recursive: true, mode: 0o700 });
    fs.accessSync(inboxRoot, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  defaultCreatorWorkspaceRoot,
  isInboxWritable,
  loadCreatorHandoffRoot,
  renderLearningPackMarkdown,
  validateWorkspaceRoot,
  writeLearningPack,
};
