# Privacy

Video Digest has no account system, advertising, analytics, or telemetry.

## Data processed

The extension reads the active YouTube or Bilibili video's canonical URL, title, channel,
description, duration, and available subtitle track. Generated digests,
translations, notes, and unfinished Create-page reflection drafts are stored in
the current Chrome profile.

Overview, explanation, focused-question, translation, and note-polishing
actions send only the content required for that action to the loopback helper
on `127.0.0.1`. A focused question includes the chosen excerpt, limited nearby
transcript context when available, and the question itself. The helper passes
it to the selected local provider. Both providers return answers inline. OpenAI
processes Codex requests under the signed-in ChatGPT account's terms and privacy
controls; TRAE processes TraeWork requests under the signed-in Trae account's
terms and privacy controls. Answers saved to Notes remain in the current Chrome
profile until deleted.

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
- `bilibili.com`, `api.bilibili.com`, and `hdslb.com`: read video metadata and subtitle tracks exposed by the active Bilibili page. Existing page cookies stay inside Bilibili requests and are not sent to the local helper.
- `127.0.0.1:43110`: reach the local AI helper and optional Creator Workspace handoff.
- Codex CLI's OpenAI connection: made by the local Codex process using the existing ChatGPT sign-in.
- TraeWork connection: made by Trae CLI 2.0 using its existing sign-in when that provider is selected.

## Delete local data

Open Settings to clear cached digests, delete notes, or reset extension data.
Uninstalling the extension removes its Chrome storage. Delete Creator Workspace
Learning Packs separately from the configured local directory. These actions do
not delete data a selected provider may retain under the signed-in account's controls.
