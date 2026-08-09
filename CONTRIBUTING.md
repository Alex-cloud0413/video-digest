# Contributing

Thanks for helping improve YT Digest. This project is distributed from GitHub as open source and is not a Chrome Web Store or commercial product.

## Before you start

- Search existing GitHub issues and pull requests.
- Open an issue before a large feature, new permission, new external service, or data-flow change.
- Keep changes focused. Avoid unrelated formatting or refactors.
- Never commit API keys, private video URLs, transcript content, or user notes.
- Do not add a developer-operated server, telemetry, analytics, or a commercial dependency without prior discussion.

By participating, you agree to follow respectful, constructive collaboration norms.

## Local setup

1. Fork and clone the repository.
2. Load the repository folder from `chrome://extensions` using **Load unpacked**.
3. Configure your own Supadata and AI provider credentials from the extension's Options page.
4. Use test content you are permitted to send to those providers.

There is no build step and no local development server.

## Make a change

- Keep Manifest V3 permissions as narrow as possible.
- Request custom AI provider access only for the origin the user saves.
- Preserve the BYOK model; do not add shared credentials.
- Treat transcript, metadata, selections, notes, provider settings, and keys as sensitive.
- Escape or render external and model-generated text safely.
- Keep provider-specific logic compatible with the documented OpenAI-compatible request shape.
- Update `README.md` and `PRIVACY.md` when behavior, permissions, external recipients, or retention changes.

After editing extension files, reload YT Digest at `chrome://extensions` and refresh the YouTube tab.

## Checks

Run:

```bash
bash scripts/check-release.sh
bash scripts/package-extension.sh
```

The first command validates the manifest, checks public JavaScript syntax, rejects common secret patterns, and enforces the release allowlist. The second creates the same allowlisted extension package under `dist/`.

CI runs these checks on pushes and pull requests.

## Manual test checklist

Automated browser coverage is not yet included, so test the affected flows in Chrome:

- Install from a clean folder that does not contain `config.js`.
- Open the Options page, save the default DeepSeek setup, and reopen it to confirm settings persist.
- Save a custom OpenAI-compatible origin and verify Chrome requests access to that origin.
- Deny the custom-origin request and confirm the extension reports the problem without calling the endpoint.
- Open a standard YouTube watch page and open/close the side panel.
- Fetch a transcript and confirm timestamps seek to the expected moment.
- Generate an overview and verify chapters and key quotes render safely.
- Explain selected text, clean up a transcript, and test translation.
- Save, revisit, and delete a timestamped note.
- Reload the extension and navigate between YouTube videos to exercise SPA navigation.
- Test invalid keys, missing transcripts, quota errors, and provider failures.
- Confirm no keys or sensitive content appear in committed files, the ZIP, screenshots, or logs.

External API smoke tests can consume quota or incur charges. Contributors are responsible for their own provider accounts and costs.

## Pull requests

Include:

- a concise problem and solution summary;
- the user-visible and privacy impact;
- permissions or network-origin changes;
- commands and manual flows tested; and
- screenshots only when a visual change needs them, with private content removed.

## License

By contributing, you agree that your contributions will be licensed under the repository's [MIT License](LICENSE).
