# dsh-side-chat-plugin

Selection quotes and side chats for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

- Select transcript text → **在主对话继续问** inserts a removable quote block into
  the current composer (same conversation).
- **在侧边问** creates an independent side chat in the right sidebar with the
  exact excerpt and a frozen snapshot of the parent up to the anchor message.
- Side chats stream, stop, retry, close and reopen. They never modify the parent
  conversation; **带回主对话** is the only explicit bridge.

See [docs/DETAIL.md](docs/DETAIL.md) for the data model, selection rules,
storage location, HTTP/SSE surface and known limits.

## Install

The package is a DSH bundle. Install this directory from **Plugins → Add plugin**
or through `plugin_manager install_bundle` with the absolute path. The bundle
adds one Host row (`side-chat`) and one browser module
(`dsh-side-chat-plugin`). In the packaged Desktop app, reload the page once after
installation so the browser module enters the boot graph.

## Development

```sh
node --test --test-isolation=none test/*.test.mjs
```

The Host half has no build step and imports only Node built-ins. The browser half
is a plain client module (`client.js`) that takes React from the DSH module table;
it needs no bundler.

## Layout

| Path | Role |
| --- | --- |
| `index.js` | Cordis Host entry: store, service, route registration |
| `lib/core.js` | Pure anchoring, snapshot budgeting and prompt assembly |
| `lib/store.js` | Atomic JSON persistence |
| `lib/service.js` | Side-chat lifecycle, streaming, cancel and retry |
| `lib/http.js` | Authenticated Fetch routes, JSON bodies and SSE framing |
| `client.js` | Selection bridge and right-sidebar panel (React, no JSX build) |
| `test/` | Host and route tests |
