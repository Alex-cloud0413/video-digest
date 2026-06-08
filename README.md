# YT Digest

A Chrome extension that opens a side panel for any YouTube video, fetches the transcript, and uses AI to tell you whether the video is worth your time — before you watch it. Includes a built-in note-taking feature and the ability to "remix" a transcript into other formats.

## Features

- **Side panel digest** — Open it on any YouTube video for an at-a-glance summary.
- **Transcript fetching** — Pulls subtitles where available, and transcribes audio when they are not.
- **AI analysis** — Summarizes the video and tells you who would find it worth watching.
- **Note-taking** — Capture notes alongside the transcript.
- **Remix prompts** — Reshape a transcript into different written formats.

## Setup

1. **Clone or download** this repository.
2. **Add your API keys:**
   - Copy `config.example.js` to a new file named `config.js`.
   - Open `config.js` and paste in your keys. See the comments in that file for where to get each one (Supadata, Anthropic, DeepSeek, AssemblyAI). `config.js` is git-ignored, so your keys stay local.
3. **Load the extension in Chrome:**
   - Go to `chrome://extensions`
   - Turn on **Developer mode** (top-right toggle)
   - Click **Load unpacked** and select this folder
4. **Use it:** Open any YouTube video and click the YT Digest icon to open the side panel.

## Tech

Manifest V3 Chrome extension. Plain JavaScript — no build step.

- `manifest.json` — extension configuration
- `background.js` — service worker; handles API calls and transcript processing
- `content.js` — runs inside YouTube pages to read video data
- `sidepanel.html` / `sidepanel.css` / `sidepanel.js` — the side panel UI and logic
- `remix-prompts.js` — prompt templates for the remix feature
- `config.example.js` — template for your API keys
