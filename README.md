# chromectl

chromectl is a fork of
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
that offers the same browser tooling as a network service instead of as an MCP
server. An HTTP front takes a target name and a tool call, drives the Chrome
behind that name and answers in one JSON envelope, so every agent on the private
network controls a browser over plain HTTP, with no Node runtime and no MCP
client of its own.

Upstream's tools, its `chrome-devtools` CLI and its daemon are used as they
stand; the front speaks to a daemon through upstream's own daemon client. The
MCP stdio server is still in the tree as upstream ships it, but nothing here
runs it and it is installed into no client.

## What this fork adds

- **The HTTP front** (`chromectl/front.mjs`): one process for all targets, one
  daemon and one mutex per target, so calls against different browsers run at
  the same time. It is a proxy, not a filter — every tool upstream declares is
  callable, with the arguments upstream declares for it. Command list and
  argument schemas are read out of upstream's generated command table
  (`src/bin/chrome-devtools-cli-options.ts`), so an upstream bump brings its new
  tools along by itself.
- **Human-pace operation**: typing, pointer travel and the waits between actions
  are paced so the operation does not read as machine-driven (`src/pacing.ts`,
  `src/pointerTravel.ts`, `src/interruption.ts`).
- **`full_speed`**: a per-call opt-in that drops that pacing, for pages of our
  own where only speed counts.

## Endpoints

| Endpoint            | Purpose                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `GET /health`       | Liveness, the registered target names and the commands on offer       |
| `POST /call`        | Runs one tool call                                                    |
| `POST /budget`      | Same body as `/call`, answered with the deadline that call is granted |
| `GET /files/<name>` | A file an earlier call wrote                                          |

A call body:

```json
{
  "target": "lokal",
  "command": "navigate_page",
  "args": {"url": "https://example.com/"},
  "full_speed": false
}
```

`select_page` sets the tab the following calls act on. That selection lives in
the target's daemon and holds for every further call reaching the same browser,
under whichever of its names, until another `select_page`, until the tab is
closed or until the daemon is replaced.

The front runs without authentication; the local network and the private overlay
network are its access boundary.

## Files

Every path is the front's decision, never the caller's. A file argument takes a
plain file name, not a path — no separator, no leading dot, at most 128
characters — and the front resolves it inside its own output directory. Files a
call reads are looked up there as well, which is how a caller on another machine
hands one in: put the file on the drive, then name it.

The answer names each file it produced with `file`, `path`, `share_path`, `url`
and `bytes` under its own key (`screenshot`, `snapshot`, `output`,
`heapsnapshot`, `trace`, `request_body`, `response_body`, `recording`,
`report_json`, `report_html`); no file data comes back inline. `GET
/files/<name>` fetches one for a client that has no access to the drive.

A result larger than `CHROMECTL_SPILL_BYTES` is written to that directory as a
`.spill.json` file and `result` then holds `{"spilled": true, …}` with the first
2 KB in `head`. A spilled result is the one file nobody asked for and the only
one that expires, after `CHROMECTL_SPILL_RETENTION_MS`.

## Targets

A target is a name for a browser URL. The registry is JSON, read from
`CHROMECTL_TARGETS`, by default `~/.claude/chromectl/targets.json`; without it
the front refuses to start. `chromectl/targets.example.json` shows the shape. A
caller may also name a host or `host:port` directly instead of a registered
name; the CDP port defaults to 9222.

The registry holds addresses of this network and therefore lives with the
machine configuration, not in this repository.

## Running the front

```bash
npm ci
npm run build          # the front imports the compiled output under build/
node chromectl/front.mjs
```

On lukas it runs as the systemd unit `chromectl-front.service`; a rebuild takes
effect on `systemctl restart chromectl-front`. Configuration is environment
only:

| Variable                       | Default                            |
| ------------------------------ | ---------------------------------- |
| `CHROMECTL_TARGETS`            | `~/.claude/chromectl/targets.json` |
| `CHROMECTL_HOST`               | `0.0.0.0`                          |
| `CHROMECTL_PORT`               | `8091`                             |
| `CHROMECTL_PUBLIC_URL`         | derived from the bind address      |
| `CHROMECTL_SCREENSHOT_DIR`     | `/home/wu/share/screenshots`       |
| `CHROMECTL_SHARE_ROOT`         | `/home/wu/share`                   |
| `CHROMECTL_SPILL_BYTES`        | `131072`                           |
| `CHROMECTL_SPILL_RETENTION_MS` | `86400000`                         |

`CHROMECTL_PUBLIC_URL` is the base of every file URL in an answer, so it must
name the address callers reach the front under.

## Calling it

`chromectl.sh` is the client: bash and curl, no Node. It lives with the machine
configuration (`~/.claude/scripts/chromectl.sh`), not in this repository, and
takes the front's address from `CHROMECTL_URL`.

```bash
bash ~/.claude/scripts/chromectl.sh --target lokal navigate_page --url https://example.com/
bash ~/.claude/scripts/chromectl.sh --target lokal take_snapshot
bash ~/.claude/scripts/chromectl.sh --target lokal fill --uid 1_23 --value "Text"
```

## Development

`npm run build`, `npm run test`, `npm run format` — see [AGENTS.md](./AGENTS.md)
for the rules that apply to the TypeScript. The fork's own parts are tested
under `tests/chromectl/`. Node 24 is what this runs on; upstream's floor is
Node 20.19.

Requirements: Node.js, npm, and a Chrome with an open remote debugging port for
every target.

## Upstream

The base is a commit of upstream `main`, not a release tag. `upstream` is a git
remote here; changes are merged deliberately and reviewed by hand, because this
fork's changes sit in the input path and in the launch flags, where an
unreviewed merge could silently disable the pacing.

- [Tool reference](./docs/tool-reference.md) — the tool surface, generated from
  the definitions and unchanged by the fork.
- [Troubleshooting](./docs/troubleshooting.md), [CLI](./docs/cli.md),
  [Design principles](./docs/design-principles.md).
- [CHANGELOG.md](./CHANGELOG.md) — upstream's release history, kept untouched so
  a merge shows what a version bump brought.
- [CLAUDE.md](./CLAUDE.md) — scope and working rules for this repository.

Apache-2.0, upstream © Google LLC; see [LICENSE](./LICENSE).
