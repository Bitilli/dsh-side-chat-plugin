# dsh-side-chat-plugin

Ephemeral **native** side chats for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

- Select transcript text → **在主对话继续问** inserts a removable quote block into
  the current composer (same conversation), or **在侧边问** opens a side chat.
- A side chat is a real fork of the parent Session rendered through the native
  embedded Conversation. It gets the same composer, model API, reasoning effort
  (`max` / `high`), permission presets (including **自动审查** when configured),
  working directory, tools, skills and parent history prefix.
- Select text **inside** the side chat → **引用并追问** quotes it into that side
  conversation, so the follow-up stays in the side branch.
- Side chats are **ephemeral**. Closing the side panel (or its last tab) stops the
  Agents and deletes their Session logs; quitting the Host also purges them, and
  the next startup removes anything a crash left behind.

See [docs/DETAIL.md](docs/DETAIL.md) for the fork/cleanup model, security,
permissions and known limits.

## Install

The package is a DSH bundle. Install this directory from **Plugins → Add plugin**
or through `plugin_manager install_bundle` with the absolute path. In the packaged
Desktop app, reload the page once after installation so the browser module enters
the boot graph.

## Why a real fork

A lightweight “separate model call with a text snapshot” cannot see the parent
workspace, tools, Skills or permissions. This plugin forks the parent Session at
the selected anchor instead, then injects one boundary message with the exact
quote and source. The sidebar tab hosts the shared embedded Conversation, so the
side chat behaves like the main chat rather than a lookalike.

## Development

```sh
node --test --test-isolation=none test/*.test.mjs
```

The Host half has no build step. The browser half is a plain client module
(`client.js`) that takes React from the DSH module table.

## Layout

| Path | Role |
| --- | --- |
| `index.js` | Host entry: registry, fork manager, authenticated Fetch routes, exit purge |
| `lib/core.js` | Anchor resolution, quote message, resource address, titles |
| `lib/manager.js` | Fork creation, Agent preset composition, model/permission inheritance, purge |
| `lib/registry.js` | Tiny durable identity registry (never conversation text) |
| `lib/http.js` | `/api/side-chat/*` create/list/delete/purge routes |
| `client.js` | Selection bar, `sidechat` resource provider, native sidebar tab |
| `test/` | Host, route and client-module tests |
