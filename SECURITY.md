# Security

## Local bridge boundary

The helper binds only to `127.0.0.1`, validates Chrome extension origins, and
requires a randomly generated installation capability. Codex and Trae CLI 2.0
run ephemerally in a dedicated runtime directory with a read-only sandbox and
user configuration and rules ignored. Requests are serialized and bounded by
size and time.

Transcript text and other model inputs are untrusted data. The helper wraps
them in explicit boundaries and instructs either provider not to follow embedded
commands, links, or tool requests. Both CLIs receive the same wrapped prompt over
stdin so large transcripts never become shell arguments. Only the final Trae CLI
message file is returned; diagnostic stdout and stderr remain inside the helper.

## Creator Workspace boundary

The workspace root comes only from `bridge/workspace-config.json` or the local
process environment. Browser requests cannot supply a destination. The helper
rejects transcript fields, article intent, unsupported top-level fields, path
escape, and symlinked inbox directories before writing a Learning Pack.

## Sensitive local files

The following files are generated locally and ignored by Git:

- `bridge-config.js`
- `bridge/bridge-config.json`
- `bridge/workspace-config.json`

The first two contain the same local installation capability; the third may
contain a device-specific path. Do not commit, package, log, or share them. If
the capability is exposed, stop the helper, remove the two capability files,
run `node bridge/generate-config.js`, reload the extension, and restart the helper.

## Supported scope

The Chrome manifest permits only YouTube/Bilibili video and subtitle hosts plus the loopback helper.
The helper must never listen on a LAN or public interface. Any change to the
host, port, origin policy, provider allowlist, provider sandbox, CLI flags, or write-root rules requires a new
security review.

## Reporting

Do not include private transcripts, notes, generated capability values, or local
paths in a public report. Use the repository's GitHub Security tab when private
vulnerability reporting is available; otherwise contact the maintainer without
posting exploit details publicly.
