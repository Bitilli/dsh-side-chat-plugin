# Side chat

Side chats are **ephemeral native forks**. They exist to ask a follow-up about a
selected passage without leaving the main conversation, while still seeing the
parent’s workspace, tools, files and permissions.

## What happens when you choose “Ask in side”

1. The Client maps the selection to a rendered source, an exact string, a
   prefix/suffix window, offsets and the rendered block key.
2. The Host resolves the selected message to its **surface event seq**, reads the
   parent log through `sessionQuery.readSession`, and builds a fork seed with
   `buildForkSeed(events, boundary)`. This copies the parent prefix through the
   anchor, not the whole conversation and not another project’s chats.
3. The Host creates a real Session/Agent with that seed and the parent’s `cwd`,
   `agentPreset` and live model selection. During Agent setup,
   `agentPresets.composeFrom(childCtx, parentAgent.ctx)` composes the parent’s
   tools, prompt sections and Skills onto the child.
4. The Host appends one user-role boundary message containing the parent label,
   anchor message id, exact excerpt and surrounding context. The model sees it;
   the side transcript shows it.
5. The parent’s permission preset is applied to the child. The native composer
   therefore starts with the same model API / `max` / `high` / permission preset
   as the main conversation and can be changed there.
6. A right-Sidebar tab opens a `dsh-resource://sidechat/session/<child>` resource.
   The tab body wraps the shared embedded Conversation in a `SessionProvider`, so
   the UI is the product’s own chat UI, not a copy.

## Selection bar

- Main transcript: **在主对话继续问** inserts a removable quote block into the
  current composer; **在侧边问** creates the native side chat.
- Side transcript: only **引用并追问** is shown. It quotes the selection into the
  side chat’s own composer; it never nests another side chat.
- The bar appears only for one non-collapsed selection inside a rendered message
  source. Selections shorter than two effective characters, across two messages,
  or inside the composer/buttons/menus are ignored.
- `Alt+Q` activates the primary action, `Alt+S` asks in side from the main chat,
  `Esc` dismisses. The bar is positioned above/below the selection and keeps the
  selection alive on pointer-down.
- While the bar is open, the shipped quote pill is hidden by a scoped `body`
  attribute; the primary action uses the same `inputActions.insertQuote` path.

## Inheritance and tools

| Capability | How the side chat gets it |
| --- | --- |
| Parent history to the anchor | `buildForkSeed` inclusive prefix + synthetic fork closers |
| Workspace / files | `meta.cwd` from the parent Session header |
| Agent preset / tools / Skills | `agentPresets.composeFrom(childCtx, parent.ctx)` during setup |
| Model API / `max` / `high` | parent `agent.model.current()`, recorded on the child with `model.select()` |
| Permission preset | parent `permissionPresets.current()`, applied with `set()` |
| Selection source | injected boundary message with anchor id and exact/prefix/suffix |

The side chat is an ordinary Session (not a `subagent`), so the Session Controller
can prompt it normally. It is created without a workspace attachment, so it does
not add a row to the workspace conversation list.

## Ephemeral cleanup

The plugin keeps only identities in `DSH_HOME/side-chat/<profile>/ephemeral.json`;
conversation text lives in the Session log and nowhere else.

- **Closing the side panel** (collapsing the right sidebar) purges every side chat
  for that parent: dispose the Agent handle, delete the Session log, remove its
  now-empty session directory, clear the registry row, and close the side tabs.
- **Closing one of several tabs** deletes only that side chat. Closing the last
  tab closes the panel path and purges the parent scope.
- **Host/plugin unload** disposes every live handle and deletes its log; a hard
  kill leaves registry rows that `purgeStale()` removes on the next startup.
- A restored tab whose Session was purged has no resource and closes itself.

DSH has no public `session.delete` or search-index purge. This is therefore a
**best-effort** purge: session logs and registry entries are removed, but the
Session search index may retain derived text until its own rebuild.

## Permissions and Auto review

The side chat runs under the selected permission preset, including **自动审查**
when that preset is configured and its reviewer credential is available. Auto
review is a deployment feature: in this environment the reviewer route
(`deepseek-official`) reported `MISSING_CREDENTIAL`, so tool calls under Auto
failed until the preset was switched to **工作区内修改**. The side chat does not
invent a second permission system; it reports the product’s own failure.

## Known limits

- **Fork, not a summary.** The child inherits the full parent prefix through the
  anchor. It does not include later parent messages and does not sync afterward.
- **No native session deletion.** Cleanup is plugin-side and best-effort; the
  search index may retain derived text.
- **Boundary quote is a user message.** The excerpt is visible in the side
  transcript and the model sees it. It is not hidden metadata.
- **Side chats are not in the workspace list.** They are real Sessions with no
  workspace attachment; they are reachable only through the side tab while open.
- **Parent history prefix can be large.** The child inherits the parent prefix;
  token pressure follows the normal Session/compaction behavior.
- **Auto review credentials.** If the deployment’s reviewer credential is
  missing, use another permission preset; the option itself remains selectable.

## HTTP surface

All routes are exact paths on the Host connection’s authenticated `/api` channel.

| Route | Purpose |
| --- | --- |
| `POST /api/side-chat/create` | Resolve the anchor, fork the Session, inject the quote, return the resource address |
| `GET /api/side-chat/list?parentSessionId=` | Registry rows for one parent |
| `POST /api/side-chat/delete` | Purge one side chat |
| `POST /api/side-chat/purge` | Purge every side chat for one parent |

Message turns are **not** sent to these routes: the native Conversation prompts
the forked Session through the existing Session Controller and streaming path.
