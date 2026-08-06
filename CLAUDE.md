# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository is a pinned fork of `chrome-devtools-mcp`. The MCP transport is removed; the tool functions are called directly. An HTTP front (`chromectl/front.mjs`) serves them on lukas port 8091, so every Claude instance on the LAN/netbird network can drive Chrome through it. Each target runs its own daemon; clients talk to the front through `chromectl.sh` (`~/.claude/scripts/chromectl.sh`, mirror `claude-repo` `config/scripts/chromectl.sh`).

## Scope

- The front is a proxy, not a filter. Every function of the MCP template is usable through it: no tool-surface allow list, no argument filtering, no restrictions.
- Exactly three things extend the template:
  1. The MCP transport is removed and replaced by the HTTP front (`chromectl/front.mjs` on lukas, port 8091, unauthenticated, reachable over netbird and the LAN), with one daemon per target and a mutex per target only, so several Claude instances on different machines drive the same tool set concurrently without blocking each other. The client is `chromectl.sh` on all eight machines.
  2. The operation must not be traceable to a machine — human-pace pacing and the rest of the camouflage.
  3. `full_speed`, the per-call opt-in for when bot detection does not matter and only speed does.
- Bugs found in the template are fixed as a matter of course.
- Nothing else is added and nothing is taken away.
