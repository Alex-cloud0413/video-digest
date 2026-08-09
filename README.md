# YT Digest

Understand a YouTube video before deciding how much of it to watch. YT Digest opens beside YouTube in Chrome and helps you:

- Decide what is worth watching with an AI overview, chapters, and key quotes.
- Navigate long videos by clicking timestamps in the transcript, overview, or notes.
- Learn with the original transcript, a Simplified Chinese translation, or an aligned bilingual view.
- Explain selected text and clean up fragmented captions into readable thoughts.
- Save timestamped notes and return to the relevant moment later.
- Keep control of your data with your own API keys, local Chrome storage, and no YT Digest analytics or telemetry.

YT Digest is a bring-your-own-key project installed locally from GitHub. It is not available through the Chrome Web Store, it does not include API credits, and it does not run a YT Digest developer server.

## What works today

- Google Chrome 116 or newer, using the Side Panel API.
- Standard `youtube.com/watch` video pages.
- Native subtitle tracks returned by Supadata. YT Digest prefers English when it is available, but may show another available native language.
- Original, Simplified Chinese, and aligned bilingual transcript views.
- AI overviews, transcript cleanup, selected-text explanations, and note cleanup.
- Local notes and a local cache for recent transcript and digest results.

Shorts, live streams, private or access-restricted videos, and videos without an available native transcript may not work. Firefox, Safari, mobile browsers, and other Chromium browsers are not currently tested or supported.

YT Digest forces Supadata's `mode=native`. It does not request AI-generated transcripts or perform local audio transcription when native captions are unavailable.

## Install from GitHub

No command line is required if you download the project as a ZIP:

1. On the GitHub repository page, choose **Code**, then **Download ZIP**.
2. Unzip the download to a folder you plan to keep.
3. In Chrome, open `chrome://extensions`.
4. Turn on **Developer mode**.
5. Click **Load unpacked**.
6. Select the unzipped folder that contains `manifest.json`.
7. Pin YT Digest from Chrome's Extensions menu if you want quick access.

You can also clone the repository and load that folder. Because this is an unpacked extension, it does not update automatically. After downloading an update or changing local files, click **Reload** on the YT Digest card at `chrome://extensions`, then refresh open YouTube tabs.

## Set up your API keys

YT Digest needs two keys under your own provider accounts:

1. A **Supadata API key** to retrieve YouTube transcripts.
2. An **AI provider API key** for overviews, cleanup, explanations, and translation.

Open **Settings** from the side panel. You can also open the YT Digest **Options** page from its card at `chrome://extensions` or by right-clicking its toolbar icon.

The default AI provider is DeepSeek:

```text
Base URL: https://api.deepseek.com
Model: deepseek-v4-flash
```

When DeepSeek handles an AI request, YT Digest sends it in non-thinking mode for responsive, predictable product interactions. This applies to every YT Digest AI feature. Custom providers do not receive this DeepSeek-specific setting.

You may instead use a custom OpenAI-compatible base URL, model, and API key. Chrome will ask for network access to that origin when you save it. Review and trust the endpoint before approving access. The extension cannot call it without that permission.

Keys and settings are stored in Chrome's local extension storage on your device. Do not add keys to project files or screenshots. Release builds do not include or use `config.js`.

## Supadata free tier and request costs

Current as of August 9, 2026, the [Supadata pricing page](https://supadata.ai/pricing) lists a free tier with **100 credits per month**, no credit card required. Unused credits do not roll over. Supadata pricing can change, so check the current page before relying on these numbers.

The [Supadata transcript documentation](https://docs.supadata.ai/get-transcript) describes the transcript request modes and credit behavior:

- A native transcript request uses **1 credit**, regardless of video duration.
- A generated transcript costs **2 credits per video minute**. YT Digest does not use this path because it forces `mode=native`.
- An unavailable native lookup returned as HTTP `206` still uses **1 credit**.

With the current native-only behavior, the free tier can cover roughly 100 transcript lookups per month when each request succeeds once. Retries and unavailable-caption lookups also consume credits, so actual successful-video coverage can be lower.

AI provider usage is separate from Supadata usage. DeepSeek or a custom AI provider may apply its own free quota, rate limits, or charges for overviews, translation, explanations, and cleanup. YT Digest does not collect payments, resell access, or reimburse provider charges. Set provider spending limits and monitor both accounts.

## Use YT Digest

1. Open a supported YouTube watch page.
2. Click the YT Digest extension icon to open the side panel.
3. Read the timestamped transcript, or choose **Original**, **中文**, or **双语**. Chinese translations load progressively for the relevant segments.
4. Open **Overview** when you want the AI analysis.
5. Select transcript text to explain it, or choose **Clean up** to improve readability.
6. Save a note from the player or a key quote, then revisit it from **Notes**.

## Remix it: DIY and vibe coding ideas

YT Digest uses plain HTML, CSS, and JavaScript with no build step, so it is a friendly starting point for a personal extension. Fork or copy it, describe the change you want to your coding tool, and keep the release checks below as guardrails.

Ideas to try:

- Add more translation languages and let each person choose a learning language.
- Create customizable summary templates for lectures, interviews, tutorials, reviews, or research talks.
- Build a vocabulary notebook that saves a word, its sentence, meaning, and video timestamp for language learning.
- Export notes and vocabulary to Markdown, CSV, Anki, or another study tool.
- Add personal topic filters that highlight the chapters most relevant to a goal.
- Offer optional local-model support for people who want a different privacy and cost tradeoff.
- Improve accessibility with keyboard-first navigation, font controls, and higher-contrast themes.

Keep secrets out of source files, confirm new provider terms and costs, and test your remix on real videos before sharing it.

## Privacy and data flow

YT Digest makes provider requests directly from the extension:

1. It sends a canonical YouTube watch URL to Supadata to request the native transcript.
2. It sends the transcript and relevant video metadata, such as title, channel, and description, to your chosen AI provider when you request AI features.
3. Focused features send the content they need, such as selected text with surrounding transcript context, visible semantic batches for translation, text selected for cleanup, or transcript context around a note.
4. It stores keys, settings, notes, and recent transcript and digest cache entries locally in Chrome.

There is no YT Digest account system, advertising, analytics, or telemetry. Supadata and the AI provider still receive data under their own terms and privacy policies. Protect, rotate, and revoke your keys as needed. See [PRIVACY.md](PRIVACY.md) for details.

## Troubleshooting

### The side panel does not open

- Confirm that you are on a standard `https://www.youtube.com/watch?...` page.
- At `chrome://extensions`, confirm YT Digest is enabled and click **Reload**.
- Refresh the YouTube tab after reloading the extension.
- Confirm your Chrome version supports the Side Panel API.

### YT Digest asks for setup

- Open **Settings** and save both a Supadata key and an AI provider key.
- Confirm the AI base URL and model are correct.
- If you use a custom provider, approve Chrome's origin-access request.

### No transcript is found

- Confirm the video is public and has native captions available through Supadata.
- Check your Supadata key, remaining credits, rate limit, and account status.
- Remember that unavailable native lookups and manual retries may still consume credits.
- Wait and try again if the provider is temporarily rate limited.

YT Digest will not fall back to generated transcription.

### AI requests fail

- A `401` or `403` usually points to an invalid key, missing account access, or unavailable model.
- A `429` usually means a provider rate or spending limit was reached.
- Confirm a custom endpoint supports the OpenAI-compatible chat-completions behavior used by YT Digest.
- Re-save the custom base URL if Chrome permission was denied or the origin changed.
- Try a model with a suitable context limit for long transcripts.

### Find diagnostic errors

At `chrome://extensions`, open YT Digest's **service worker** inspection link for background errors. To inspect the panel, right-click inside it and choose **Inspect**. Never paste API keys into an issue, screenshot, or log.

## Development and release checks

The project uses plain HTML, CSS, and JavaScript. There is no build step or local development server.

Run automated tests:

```bash
npm test
```

Run the full release check, including manifest validation, JavaScript syntax checks, and common credential scans:

```bash
npm run check
```

Create an allowlist-only ZIP under `dist/`:

```bash
npm run package
```

Before treating a change as ready, also reload the unpacked extension in Chrome and test several real YouTube watch pages. Automated checks do not prove that provider requests or live YouTube interactions work.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the manual test checklist and contribution workflow.

## License

MIT. See [LICENSE](LICENSE).
