# Privacy

YouTube Digest + Codex has no account system, advertising, analytics, or telemetry.

## Data processed

The extension reads the active YouTube video's canonical URL, title, channel,
description, duration, and available subtitle track. Generated digests,
translations, notes, and unfinished Create-page reflection drafts are stored in
the current Chrome profile.

Overview, explanation, translation, and note-polishing actions send only the
content required for that action to the loopback helper on `127.0.0.1`. The
helper passes it to the locally signed-in Codex CLI. OpenAI processes that
content under the terms and privacy controls of the signed-in ChatGPT account.

The optional Creator Workspace handoff writes a bounded Learning Pack to the
locally configured workspace. It includes source metadata, an overview when
available, saved notes, and the user's reflection. It does not include the full
transcript.

## Credentials

No Supadata, DeepSeek, or OpenAI API key is collected or stored. A generated
installation capability authenticates the extension to the local helper. It is
not an external provider key and remains in ignored, device-local files.

## Network access

- `youtube.com` and `googlevideo.com`: discover and retrieve subtitle tracks exposed by the active YouTube player.
- `127.0.0.1:43110`: reach the local Codex helper and optional Creator Workspace handoff.
- Codex CLI's OpenAI connection: made by the local Codex process using the existing ChatGPT sign-in.

## Delete local data

Open Settings to clear cached digests, delete notes, or reset extension data.
Uninstalling the extension removes its Chrome storage. Delete Creator Workspace
Learning Packs separately from the configured local directory. These actions do
not delete data OpenAI may retain under the signed-in account's controls.
