# Creator Workspace template

This is a small, tool-agnostic structure for turning learning inputs into
publishable work without automatically treating every note as an article.

```text
creator-workspace/
├── inbox/
│   └── youtube-digest/   # Legacy-stable inbox ID; Video Digest packs arrive here
├── ideas/                # Optional claims and content seeds
├── projects/             # Explicitly started creation projects
└── published/            # Publication records or final exports
```

## Suggested lifecycle

1. **Learn** — watch, digest, save notes, and add your own reflection.
2. **Handoff** — send a `learning_complete` Learning Pack to `inbox`.
3. **Review** — decide whether the pack should remain reference material or
   become a content seed.
4. **Start explicitly** — create a project only after a human chooses a format,
   audience, purpose, and destination.
5. **Derive** — turn one reviewed source into an article, image post, script,
   video, or another format.
6. **Publish deliberately** — keep platform publishing as a separate action.

The extension performs only steps 1 and 2. Everything after the handoff belongs
to the user's own tools, agent workflow, or editorial process.

The `youtube-digest` directory name is a legacy-stable internal identifier kept
for compatibility after the public project was renamed to Video Digest.

## Learning Pack contract

The JSON handoff follows
[`learning-pack.schema.json`](learning-pack.schema.json). Important invariants:

- `state` is `learning_complete`;
- `articleIntent` is `false`;
- `provenance.transcriptIncluded` is `false`;
- the full transcript is never part of the handoff;
- the bridge, not the browser, chooses the destination directory.
