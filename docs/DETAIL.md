# Side chat

Select rendered transcript text, then either continue the main conversation with a
removable quote block or open an independent **side chat** in the right sidebar.

## What it does

- **Selection bar** — a compact floating toolbar appears above or below the
  selection without covering it. It offers:
  - **在主对话继续问 / Continue in main** — inserts a removable quote block into
    the current composer. The question is sent in the original conversation.
  - **在侧边问 / Ask in side** — creates a new side chat and opens it in the
    right sidebar. The parent conversation is not modified.
- **Frozen context** — the side chat stores `parentConversationId`,
  `anchorMessageId`, `quoteRef` and `contextSnapshotId`. The request contains:
  the frozen parent snapshot up to the anchor + the exact excerpt + the side
  chat's own messages + the current question.
- **Independent by default** — later parent messages never enter an existing side
  chat, and side answers never enter the parent. The explicit **带回主对话 /
  Bring back to main** action inserts an answer into the parent composer.
- **Full side-chat lifecycle** — streaming answers, stop, retry, close and
  reopen. Closing the panel only closes the view; the record and history stay
  persisted under the DSH home directory.
- **Multiple side chats** — one side chat is shown at a time; a selector switches
  between them. Each has its own snapshot and quote.

## Install and reload

Install this directory from **Plugins → Add plugin** (or `plugin_manager`
`install_bundle` with the absolute path). In the packaged Desktop app the Host
half starts immediately; the browser half enters the boot graph on the next page
load, so reload the page once after installation. In a Web profile with the
client watcher running, the entry reloads without a refresh.

## Selection rules

The bar only appears for a non-collapsed selection inside one rendered message
body (`[data-text-interaction-source]`). Selections shorter than two effective
characters, selections spanning two messages, and selections inside the
composer, buttons, menus or the side panel are ignored. The quote records the
exact text, a prefix/suffix window, best-effort character offsets, and the
rendered node key. Keyboard: `Alt+Q` continues in main, `Alt+S` asks in side,
`Escape` dismisses. On touch devices the native long-press selection raises the
same bar.

## Storage and privacy

Records live in `DSH_HOME/side-chat/<profile>/side-chats.json` as an atomic JSON
document. They contain the quote, the frozen parent transcript up to the anchor,
and the side-chat messages. Nothing is sent anywhere except the configured model
provider when a turn runs. The browser surface is registered on the Host
connection's authenticated `/api` channel, so an unauthenticated request is
rejected with 401 before it reaches the service; the deployment has one owner
principal. A side chat is always addressed together with its `parentSessionId`;
a mismatch returns 404 and leaks no content.

## Known limits

- **Main-chat provenance is textual.** The core message format has no structured
  `quoteRefs` field for ordinary turns, so the main-chat path persists its source
  as a quoted `引用自当前对话` line and as the composer's quote summary. The side
  chat stores the full structured quote ref.
- **Anchor fallback is best-effort.** If the anchor message was edited, deleted or
  re-rendered, the saved excerpt is matched by exact text, then by prefix/suffix,
  then by a fragment; if none match, the snapshot ends at the newest message and
  records `anchorMatch: "none"`.
- **Context budgeting is a tail budget.** The snapshot uses the Host token meter
  for per-message estimates and keeps the newest rows within the configured
  budget; it records the truncation strategy instead of invoking the compaction
  service (which requires a Session that this side chat deliberately does not
  own).
- **Text-only context.** Parent tool results, images and attachments are not
  copied into the snapshot; only user/assistant text is.
- **No automatic sync.** There is intentionally no live link between the parent
  and a side chat after creation.
- **Side chats are plugin-owned records.** They are not Session-log entries, so
  Session search, Session export and the Session list do not include them. This
  is what keeps them out of the parent and out of the model-visible history; the
  trade-off is that the DSH Session tooling cannot inspect them.
- **The shipped quote pill is hidden while the selection bar is open.** A scoped
  `body` attribute hides the built-in text-interaction surface only while this
  bar is visible; **Continue in main** calls the same `inputActions.insertQuote`
  path, and removing/unloading the plugin clears the attribute. If the shipped
  quote plugin changes its surface attribute, re-check this coexistence.
- **Host reload.** A stream interrupted by a Host restart is marked as an error so
  the user can retry; it is not resumed mid-answer.

## HTTP surface

All routes are exact paths on the Host connection's shared `/api` channel, so
they share its authentication and trust checks.

| Route | Purpose |
| --- | --- |
| `POST /api/side-chat/create` | Freeze the snapshot and create a side chat |
| `GET /api/side-chat/list?parentSessionId=` | Side chats for one parent |
| `GET /api/side-chat/get?id=&parentSessionId=` | One side chat |
| `POST /api/side-chat/turn` | Append a question and stream the answer (SSE) |
| `POST /api/side-chat/cancel` | Abort the active answer without deleting it |
| `POST /api/side-chat/retry` | Remove the failed/cancelled answer and re-run without duplicating the question |
| `POST /api/side-chat/delete` | Delete one side chat |

Streaming uses the existing model stream and ordinary SSE framing with
`start`, `delta`, `reasoning`, `done` and `error` frames. It does not introduce a
second message protocol.
