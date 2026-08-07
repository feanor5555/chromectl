# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository is a pinned fork of `chrome-devtools-mcp`. The MCP stdio server is still in the tree as upstream ships it, but nothing here runs it and it is installed into no client. An HTTP front (`chromectl/front.mjs`) offers the tools on lukas port 8091, so every Claude instance on the LAN/netbird network can drive Chrome through it; the front reaches a target through upstream's own daemon client, which speaks MCP over a unix socket to that target's own daemon. Clients talk to the front through `chromectl.sh` (`~/.claude/scripts/chromectl.sh`, mirror `claude-repo` `config/scripts/chromectl.sh`).

## Scope

- Every function of the MCP template is usable through the front but the ones on its deny list, and each with the arguments upstream declares for it: no tool-surface allow list kept by hand, no own argument rules.
- What extends the template:
  1. The HTTP front (`chromectl/front.mjs` on lukas, port 8091, unauthenticated, reachable over netbird and the LAN) is the way in instead of the MCP transport, with one daemon per target and a mutex per target only, so several Claude instances on different machines drive the same tool set concurrently without blocking each other. The client is `chromectl.sh` on all eight machines.
  2. The operation must not be traceable to a machine — human-pace pacing and the rest of the camouflage.
  3. `full_speed`, the per-call opt-in for when bot detection does not matter and only speed does.
  4. The deny list of whole commands, `DENIED_COMMANDS` in `chromectl/commands.mjs`: a name on it is absent from what `/health` reports and a call to it is refused by the front. It holds the five extension commands — `install_extension`, `uninstall_extension`, `list_extensions`, `reload_extension`, `trigger_extension_action`. The daemon still runs with `--categoryExtensions`, which is what keeps extension pages and service workers in the page listings.
  5. `--no-emulate-focused-pages`, the per-target switch that takes the focus emulation off a browser somebody watches.
- Bugs found in the template are fixed as a matter of course.
- Nothing else is added and nothing else is taken away.

## Development Status

chromectl is in development and has no users. The front, the daemons and the browsers they drive may be rebuilt, restarted and killed at any time without consideration: no checking for calls in flight, no waiting for other instances, no coordination.
