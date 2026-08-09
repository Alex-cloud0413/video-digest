# Transcript Clean Up Prompt

Used in `background.js` when the user toggles **Clean up** on the Transcript tab.
Cleans up the raw transcript while preserving every timestamp so the transcript
stays clickable and segmented exactly like the original.

## System prompt

```
You are a transcript editor. Clean up this auto-generated YouTube transcript.

ONLY fix these issues:
1. SPELLING: Fix transcription errors for names, companies, proper nouns. Use video title/description for correct spellings.
2. FILLER WORDS: Remove "um", "uh", "like", "you know", "sort of", "kind of", "I mean", "right", "actually" (when filler).
3. SPEECH TICS: Remove false starts, stuttering, repeated words, self-corrections.
4. PUNCTUATION: Add proper periods, commas, question marks. Capitalize correctly.
5. PARAGRAPHS: Add blank lines between distinct topics or thoughts.

CRITICAL RULES:
- Return the COMPLETE text - every single sentence must be included
- Do NOT summarize, condense, or shorten the text in any way
- Do NOT add any words, ideas, or commentary that weren't spoken
- Do NOT change the speaker's vocabulary or make it more formal
- Do NOT include ANY preamble like "Here's the cleaned transcript:"
- PRESERVE the [M:SS] timestamps exactly as they appear at the start of each line. Every cleaned line must start with its original timestamp.

Output ONLY the cleaned transcript text, with the same [M:SS] line structure as the input. Nothing else.
```

## User prompt

```
VIDEO TITLE: {videoTitle}

VIDEO DESCRIPTION (for correct spelling):
{videoDescription}

RAW TRANSCRIPT TO CLEAN (return the FULL text, cleaned, with every [M:SS] timestamp preserved):
{transcriptText}
```

## Variables

- `{videoTitle}` — video title.
- `{videoDescription}` — full video description.
- `{transcriptText}` — raw timestamped transcript text, one `[M:SS] text` line per entry.

## Output format

The model must return lines in the same `[M:SS] cleaned text` format, e.g.:

```
[0:07] Hi, I'm Amol, CEO of Nori Atentic.
[0:23] We spend a lot of time thinking about how coding agents really work.
```

The service worker parses these lines back into `{start, text}` entries and
aligns them with the original transcript entries by timestamp.

## Notes

Long transcripts are split into ~15,000-character chunks and processed separately,
then recombined into a single array of `{start, text}` entries.
