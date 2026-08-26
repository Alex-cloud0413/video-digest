# YouTube Digest + Codex

[简体中文](README.zh-CN.md)

A local-first Chrome extension that turns subtitle-enabled YouTube and Bilibili videos into
searchable transcripts, bilingual study views, Codex-generated overviews,
explanations, timestamped notes, and reusable Learning Packs.

This project is a Codex-powered derivative of
[zarazhangrui/youtube-digest](https://github.com/zarazhangrui/youtube-digest).
It keeps the original learning experience while replacing paid transcript and
LLM API dependencies with platform-provided subtitle tracks and the locally installed
Codex CLI.

## Highlights

- Read subtitle tracks exposed by the active YouTube or Bilibili player.
- View the original transcript, Simplified Chinese, or an aligned bilingual view.
- Generate chapters, key quotes, explanations, translations, and polished notes with Codex.
- Ask focused questions about any transcript passage, Overview item, or saved Note, then save the Codex answer back to Notes.
- Save timestamped notes and navigate back to the matching point in the video.
- Use the Create page to combine the source, overview, notes, and your own reflection.
- Send a bounded Learning Pack to a configurable local Creator Workspace.
- Follow the browser's light or dark color preference, using YouTube red or Bilibili pink for the active video.
- Use no Supadata, DeepSeek, or OpenAI API key.

The extension does not transcribe audio. The video must expose a native/automatic
YouTube track or a Bilibili CC/AI subtitle track. Bilibili may require the video
page to be signed in before its player exposes subtitles.

## How it works

The extension reads subtitles from the active video page. AI actions go to a
loopback-only helper on `127.0.0.1:43110`; the helper invokes the Codex CLI using
the ChatGPT account already signed in on the computer.

The helper:

- listens only on the local loopback interface;
- requires a randomly generated installation capability on every request;
- accepts only local Chrome extension origins;
- runs Codex ephemerally in a read-only sandbox with tools disabled;
- serializes requests and limits request size, response size, and duration.

Codex requests count against the limits of the signed-in ChatGPT plan.

## Requirements

- Google Chrome 116 or newer
- Node.js 18 or newer
- The [Codex CLI](https://developers.openai.com/codex/cli) installed and signed in
- A YouTube or Bilibili video with available captions

## Install

```bash
git clone https://github.com/Alex-cloud0413/youtube-digest-codex.git
cd youtube-digest-codex
node bridge/generate-config.js
node bridge/server.js
```

Keep the last command running. Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this repository's root directory, the folder containing `manifest.json`.
5. Open a standard YouTube or Bilibili video page with captions and click the extension icon.

For automatic startup, run `node bridge/server.js` with the local process
manager or login service you trust. Never expose port `43110` beyond loopback.

## Creator Workspace

Running `node bridge/generate-config.js` creates an ignored local file:

```text
bridge/workspace-config.json
```

Its default workspace is:

```text
~/Documents/youtube-digest-creator-workspace
```

You may edit `workspaceRoot` in that local file. **Send to Creator Workspace**
always writes below:

```text
<workspaceRoot>/inbox/youtube-digest/<platform>-<video-id>[-p<part>]/<handoff-id>/
├── learning-pack.json
└── learning-pack.md
```

The destination is controlled by the local bridge configuration, never by a
browser request. The bridge rejects request-supplied paths, transcript fields,
and attempts to set `articleIntent` to true.

A Learning Pack contains:

- the canonical YouTube or Bilibili source and metadata;
- the overview, if generated;
- saved timestamped notes;
- your own reflection and possible core claim;
- provenance stating that the full transcript is not included.

The handoff state is `learning_complete`. It does not automatically start an
article project or publish content. See
[`creator-workspace-template`](creator-workspace-template/README.md) for a small,
tool-agnostic personal content workflow that can consume these packs.

## Use

1. Open a captioned YouTube or Bilibili video and click the extension icon.
2. Read or translate the transcript.
3. Open **Overview** for chapters and key quotes.
4. Select transcript text for an explanation.
5. Choose **Ask** on a transcript passage, chapter, key quote, or Note to ask Codex a focused question in the side panel.
6. Save a useful answer to **Notes** with its source and timestamp preserved.
7. Save timestamped notes from the player or a quote.
8. Open **Create**, add your reflection, and send the Learning Pack when ready.

## Privacy and security

No provider API key is stored by the extension. The generated local capability
and device-specific workspace path live only in ignored files:

```text
bridge-config.js
bridge/bridge-config.json
bridge/workspace-config.json
```

Do not commit or share them. See [PRIVACY.md](PRIVACY.md) and
[SECURITY.md](SECURITY.md) for the complete boundaries.

## Development

```bash
npm test
node bridge/generate-config.js
npm run check
```

## Attribution and license

The upstream project and this derivative use the MIT License. The original
copyright notice is preserved in [LICENSE](LICENSE), and upstream attribution
is recorded in [NOTICE.md](NOTICE.md).

YouTube is a trademark of Google LLC, Bilibili is a trademark of its respective
owner, and Codex is an OpenAI product. This
community project is not affiliated with, endorsed by, or sponsored by Google,
YouTube, Bilibili, or OpenAI.
