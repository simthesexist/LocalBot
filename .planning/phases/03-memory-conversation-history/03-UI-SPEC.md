---
phase: 03-memory-conversation-history
padded_phase: "03"
created: 2026-09-18
status: draft
---

# Phase 3 — UI Design Contract

## 1. Surface Inventory

This phase introduces five new visible surfaces on top of the existing chat shell. Each entry lists the surface ID, its location relative to the existing `chat-shell` layout, and the sub-elements (children) it owns.

### 1.1 Workspace Tree Panel (UI-08)

- **Location:** Left sidebar, 240 px wide, collapsible to 32 px. Hidden by default on viewport width < 900 px; toggled by a tab icon in the chat header.
- **Sub-elements:**
  - `TreeHeader` — title row with the bot name (`default` in Phase 3) + a small refresh button.
  - `TreeNode` (per node) — chevron for expand/collapse, file/folder icon, name, file-size suffix (right-aligned, muted).
  - `TreeActionButton` — "Refresh" at top-right of header.
  - `TreeEmptyState` — shown when the workspace directory does not exist or has no entries.
  - `TreeErrorState` — shown on `tree:error` event with a one-line message + retry link.

### 1.2 Diff View (UI-08)

- **Location:** Inline within an existing `MessageBlock` of kind `tool_result` when the source tool name is `edit_file`. No modal; no separate route. When the result payload contains `before`/`after` strings the renderer mounts the diff inside the existing tool_result block; when the payload contains a `binary` flag it renders a placeholder block instead.
- **Sub-elements:**
  - `DiffHeader` — file path (mono), diff mode toggle ("Split" / "Unified").
  - `DiffBody` — the `react-diff-viewer-continued` element.
  - `DiffBinaryPlaceholder` — replaces the body when `binary === true`; shows the file path and a one-line "binary file — diff unavailable" note.

### 1.3 Memory Pill (AGENT-05)

- **Location:** Chat header, right-aligned, between the title and any future tab icons. Always visible while a session is loaded.
- **Sub-elements:**
  - `MemoryPillLabel` — short text "Memory" plus the current summary stats.
  - `MemoryPanel` (read-only) — opens as a modal-style card on click; shows memory.md rendered as fenced markdown + a facts.json bullet list. Closes on Escape or backdrop click.

### 1.4 Summary Block (LLM-04)

- **Location:** Inline within the message list at the head of a conversation that has been summarized. Visually distinct from regular text bubbles.
- **Sub-elements:**
  - `SummaryBadge` — italicized "Conversation summarized" prefix on a muted background.
  - `SummaryBody` — the markdown summary text.
  - `SummaryMeta` — small muted line showing "X turns folded, summarizer ran at <timestamp>".

### 1.5 Session Switcher (AGENT-06)

- **Location:** Chat header, immediately to the left of the memory pill. Implemented as a dropdown trigger button.
- **Sub-elements:**
  - `SessionTrigger` — button showing the current session label (default = "Current session" or the date).
  - `SessionDropdown` — list of `SessionListItem` entries (newest first) below the trigger; closes on outside click or Escape.
  - `SessionListItem` — one row per session file: relative date label + message count + "active" marker.
  - `SessionEmptyState` — shown when no historical sessions exist for the bot.

## 2. Design System

Phase 3 extends the existing `app.css` token set. Every new color is appended as a CSS custom property under `:root` with a `--lb-` prefix. Spacing uses the existing 4 / 8 / 16 / 24 / 32 grid established by the chat shell (`.composer` padding 12 32, `.message-list` padding 16 32, `.bubble` margin 8 0).

### 2.1 New Color Tokens

| Token | Value | Used By |
|-------|-------|---------|
| `--lb-sidebar-bg` | `#f9fafb` | WorkspaceTree panel background |
| `--lb-sidebar-border` | `var(--color-border)` | Vertical separator between sidebar and chat |
| `--lb-sidebar-text` | `var(--color-text)` | Tree node labels |
| `--lb-sidebar-text-muted` | `var(--color-text-muted)` | File-size suffix, secondary tree labels |
| `--lb-tree-hover` | `#f3f4f6` | Tree node hover background |
| `--lb-tree-selected` | `#e6f0ff` | Active tree node background |
| `--lb-tree-focus` | `var(--color-accent)` | Keyboard-focus ring (2 px outline) |
| `--lb-pill-bg` | `#eff6ff` | MemoryPill background |
| `--lb-pill-text` | `#1d4ed8` | MemoryPill label |
| `--lb-pill-border` | `#bfdbfe` | MemoryPill border |
| `--lb-summary-bg` | `#f9fafb` | SummaryBlock background |
| `--lb-summary-text` | `var(--color-text-muted)` | SummaryBlock body color (italic) |
| `--lb-summary-border` | `#e5e7eb` | SummaryBlock left border accent |
| `--lb-diff-add` | `#e6ffed` | Diff added-line background |
| `--lb-diff-remove` | `#ffeef0` | Diff removed-line background |
| `--lb-binary-bg` | `#fef3c7` | DiffBinaryPlaceholder background |
| `--lb-binary-text` | `#92400e` | DiffBinaryPlaceholder label |
| `--lb-binary-border` | `#fde68a` | DiffBinaryPlaceholder border |
| `--lb-session-active` | `var(--color-accent)` | Active session marker dot |
| `--lb-dropdown-bg` | `#ffffff` | SessionDropdown background |
| `--lb-dropdown-shadow` | `0 4px 12px rgba(0, 0, 0, 0.08)` | SessionDropdown box-shadow |

### 2.2 New Spacing Tokens

The existing 4 / 8 / 16 / 24 / 32 grid is reused. No new spacing tokens are introduced; the table below records the canonical mappings Phase 3 will use so the planner does not invent values.

| Token Class | Values | Used By |
|-------------|--------|---------|
| `--lb-pad-1` | `4px` | Tree node vertical padding, badge top/bottom padding |
| `--lb-pad-2` | `8px` | Tree node horizontal padding, pill horizontal padding |
| `--lb-pad-3` | `12px` | Dropdown vertical padding |
| `--lb-pad-4` | `16px` | Sidebar horizontal padding, modal card padding |
| `--lb-pad-5` | `24px` | Modal card padding (top/bottom only) |
| `--lb-gap-1` | `4px` | Badge text gap, tree indent step |
| `--lb-gap-2` | `8px` | Pill internal gap between label and stats |
| `--lb-gap-3` | `16px` | Dropdown row gap |
| `--lb-sidebar-width` | `240px` | WorkspaceTree panel width |
| `--lb-sidebar-width-collapsed` | `32px` | Collapsed sidebar width (icon strip only) |

### 2.3 New Typography Tokens

No new font families are introduced. Phase 3 reuses `--font-sans` and `--font-mono`. The new size/weight values are appended to the existing scale; the executor must not invent new values.

| Token | Value | Used By |
|-------|-------|---------|
| `--lb-text-xs` | `11px` | Tree size suffix, badge timestamp |
| `--lb-text-sm` | `12px` | Dropdown row secondary text, tree node labels |
| `--lb-text-md` | `14px` | Pill label, summary body, dropdown primary text |
| `--lb-text-lg` | `16px` | Modal card title |
| `--lb-weight-regular` | `400` | Default body weight |
| `--lb-weight-semibold` | `600` | Pill label, modal title, tree node selected |
| `--lb-leading-tight` | `1.2` | Modal title line height |
| `--lb-leading-normal` | `1.5` | Body line height (matches existing bubbles) |
| `--lb-leading-mono` | `1.4` | Tree node + summary body mono lines |

### 2.4 New Motion / Interaction Tokens

| Token | Value | Used By |
|-------|-------|---------|
| `--lb-tree-indent` | `16px` | Indent step per tree depth level |
| `--lb-focus-ring` | `2px solid var(--lb-tree-focus)` | Standard focus ring on tree nodes, pills, buttons |
| `--lb-debounce-refresh-ms` | `250` | Chokidar debounce window (matches RESEARCH.md) |

## 3. Typography

Phase 3 does not introduce new font faces. All surfaces use the existing scale documented in Section 2.3 (4 sizes — xs/sm/md/lg).

- **Default body text:** `--font-sans`, `--lb-text-md` (14 px), weight 400, line-height `--lb-leading-normal` (1.5). Matches the existing `.bubble` baseline.
- **Mono / code-adjacent:** `--font-mono`, `--lb-text-sm` (12 px), line-height `--lb-leading-mono` (1.4). Matches the existing `.block-tool-input` / `.block-tool-output` baseline.
- **Headings (modal title):** `--font-sans`, `--lb-text-lg` (16 px), weight 600, line-height `--lb-leading-tight` (1.2).
- **Pill label + tree primary label:** 13 px (existing `.chat-title` baseline) — declared via the existing `.chat-title` rule; no new token required.
- **No more than two weights total** (400 + 600) per the locked constraint inherited from `app.css`.

## 4. Color

The 60 / 30 / 10 split from the existing shell:

- **60 % dominant surface:** `--color-bg` (white) for chat body and modal cards. `--lb-sidebar-bg` (`#f9fafb`) for the left sidebar is the "10 % accent on chrome" — it remains neutral so the accent reserved-for list below stays consistent.
- **30 % secondary surface:** sidebar (`--lb-sidebar-bg`), dropdown (`--lb-dropdown-bg`), summary block (`--lb-summary-bg`). All neutral grey family.
- **10 % accent reserved for:** active tree node background (`--lb-tree-selected`), focus ring (`--lb-tree-focus`), pill text (`--lb-pill-text`), active session marker (`--lb-session-active`). Accent color source remains `--color-accent` (`#2563eb`) and its info-family (`#1d4ed8`).
- **Second semantic color (destructive)**: not introduced in Phase 3; existing `--color-error-bg` / `--color-error-text` reused for any error states.

## 5. Spacing

Phase 3 honors the existing 4 / 8 / 16 / 24 / 32 grid:

- `4` — vertical padding inside tree nodes, badge vertical padding
- `8` — horizontal padding inside tree nodes, pill horizontal padding, gap between pill label and stats
- `12` — dropdown vertical padding (extends the grid; one of the documented values in the chat shell composer)
- `16` — sidebar inner padding, modal card padding, dropdown row gap, tree indent step
- `24` — modal card top/bottom padding
- `32` — sidebar collapse width (icon strip) plus reserved for future expansion

No spacing value outside the 4 / 8 / 12 / 16 / 24 / 32 grid is allowed. The `--lb-sidebar-width: 240px` is a structural dimension, not spacing.

## 6. Layout

The existing chat shell is `display: flex; flex-direction: column` (`chat-shell` -> `chat-header` + `chat-body` + composer). Phase 3 adds a single horizontal split to `chat-body`:

```
chat-shell (column flex)
+-- chat-header (32 px tall)
+-- chat-body (flex: 1, row flex after Phase 3)
|   +-- WorkspaceTree (240 px wide, optional)
|   +-- chat-main (flex: 1, column flex)
|       +-- ErrorBanner (existing, conditional)
|       +-- message-list (existing, flex: 1)
+-- Composer (existing)
```

### 6.1 Workspace Tree Placement

- Left sidebar, 240 px wide on viewports >= 900 px.
- On viewports < 900 px the sidebar collapses to a 32 px icon strip; tapping the strip expands it as an overlay (z-index 900, full-height, 240 px wide, backdrop dimmed at 0.2 opacity).
- The chat-main pane shrinks/grows to fill remaining horizontal space; the existing message-list horizontal padding `16px 32px` is preserved.

### 6.2 Diff View Placement

- Inline within the existing tool_result block, only when the source tool is `edit_file` and the result payload carries `{ before, after, file }` or `{ binary: true, file }`.
- Replaces the existing `<pre>` content of the tool_result with the diff component. The surrounding `.block-tool-result` chrome (border, padding) is preserved.
- No modal, no separate route.

### 6.3 Memory Pill Placement

- Chat header, right-aligned. Sits to the right of the existing `chat-title` (which is centered) and to the left of any future icons. Implementation: header becomes `display: flex; justify-content: space-between` with the title group on the left and the pill on the right; the existing `-webkit-app-region: drag` is preserved on the title group only.
- Click opens a modal-style card centered horizontally, anchored near the pill (top of card ~ 48 px below the header).

### 6.4 Summary Block Placement

- Inline within the message list. Renders as its own `.bubble` variant (not as a user/assistant bubble). Visually nested inside the conversation flow at the head.
- Background `--lb-summary-bg`, italic body, left border accent `--lb-summary-border` (4 px wide) to mark it as a non-message.

### 6.5 Session Switcher Placement

- Chat header, immediately to the left of the memory pill. Implemented as a button with a caret that opens a dropdown below it. Dropdown is `position: absolute; top: 100%; right: 0`, max-height 320 px, overflow-y auto.

### 6.6 Header Layout (after Phase 3)

```
+------------------------------------------------------------+
| [Title] [..drag region..]            [Session v] [Memory]  |
+------------------------------------------------------------+
```

- Title group (left + center) keeps `-webkit-app-region: drag`.
- Pill + session trigger (right) set `-webkit-app-region: no-drag` so they remain clickable.

## 7. Copywriting Contract

All user-facing strings. The exact wording below is binding; the planner must not paraphrase.

### 7.1 Buttons + Labels

| Surface | Label |
|---------|-------|
| WorkspaceTree toggle (collapsed) | `Workspace` |
| WorkspaceTree header title | `Workspace` |
| WorkspaceTree refresh button tooltip | `Refresh workspace` |
| DiffHeader file label prefix | `Diff:` |
| DiffHeader mode toggle (when in unified) | `Split` |
| DiffHeader mode toggle (when in split) | `Unified` |
| DiffBinaryPlaceholder line 1 | `Binary file — diff unavailable` |
| DiffBinaryPlaceholder line 2 | `Path: <file>` |
| MemoryPill label | `Memory` |
| MemoryPill tooltip | `<X> facts, <Y> bytes of memory` |
| MemoryPill "Last updated" suffix | `Last updated: <YYYY-MM-DD HH:mm>` |
| MemoryPanel title | `Memory` |
| MemoryPanel close button | `Close` |
| SummaryBlock badge prefix | `Conversation summarized` |
| SummaryBlock meta line | `<N> turns folded, summarizer ran at <YYYY-MM-DD HH:mm:ss>` |
| SessionTrigger default | `Current session` |
| SessionTrigger suffix | `<YYYY-MM-DD>` when more than one session exists |
| SessionListItem format | `<YYYY-MM-DD HH:mm> — <N> messages` |
| SessionListItem active suffix | ` (active)` |

### 7.2 Empty States

| Surface | Empty text |
|---------|------------|
| WorkspaceTree (no workspace dir) | `No files yet — chat with the bot to create files` |
| WorkspaceTree (dir exists, empty) | `Workspace is empty` |
| SessionList (no history) | `No previous sessions` |
| MemoryPanel (no memory.md) | `Bot has not recorded any memory yet` |
| DiffBody (empty before and after) | `(no changes)` |

### 7.3 Loading States

| Surface | Loading text |
|---------|--------------|
| WorkspaceTree | `Loading workspace…` |
| MemoryPanel | `Loading memory…` |
| SessionDropdown | `Loading sessions…` |
| DiffBody | `Rendering diff…` |

### 7.4 Error States

| Surface | Error text |
|---------|------------|
| WorkspaceTree (`tree:error`) | `Could not read workspace. Click to retry.` |
| DiffBody (parse failure) | `Diff unavailable — file may be too large or binary.` |
| MemoryPanel | `Could not load memory. Click to retry.` |
| SessionDropdown | `Could not load sessions. Click to retry.` |

### 7.5 Destructive Actions

Phase 3 introduces no destructive actions. Session reload is reversible (the previous session is still on disk). The MemoryPanel is read-only in Phase 3.

## 8. Interaction Spec

### 8.1 Keyboard Shortcuts

Phase 3 adds no global keyboard shortcuts. The Escape key already cancels streaming (existing Composer behavior) and is also bound to close the MemoryPanel and SessionDropdown when they are open.

### 8.2 Focus Order

When the chat loads:

1. WorkspaceTree toggle (if collapsed) or the first tree node (if expanded).
2. Composer textarea.
3. SessionTrigger, then MemoryPill (right-aligned header controls).

Tab cycles within each component. The MemoryPanel traps focus while open; focus returns to the triggering pill on close.

### 8.3 Click Targets

| Target | Minimum size | Notes |
|--------|--------------|-------|
| Tree node row | 28 px tall | Comfortable on Windows DPI |
| Tree refresh button | 24 x 24 px | Standard icon-button |
| SessionTrigger | 32 x 24 px | Header height aligned |
| MemoryPill | 32 x 24 px | Header height aligned |
| DiffHeader mode toggle | 24 px tall, 64 px wide | Compact pill |
| DiffBinaryPlaceholder | not interactive | Decorative |
| MemoryPanel close button | 32 x 32 px | Standard |

### 8.4 Debounce Windows

| Surface | Window |
|---------|--------|
| WorkspaceTree refresh (chokidar -> renderer) | 250 ms (`--lb-debounce-refresh-ms`) |
| Tree node lazy-load on expand | 0 ms (immediate on expand) |
| DiffBody mount | 0 ms (immediate) |
| MemoryPanel data fetch on open | 0 ms (immediate on click) |

### 8.5 Refresh Behavior

- Tree auto-refreshes via `tree:refresh` event (chokidar-debounced).
- Manual refresh button always available; clicking it issues a fresh `tree:list` IPC regardless of chokidar state.
- Memory panel refreshes only when reopened (it shows a snapshot).
- Session list refreshes only when the SessionDropdown is opened.

## 9. Component Decomposition

Every new component is a named export from a TypeScript file under `src/renderer/components/`. The prop sketches below are binding for the planner.

### 9.1 `src/renderer/components/WorkspaceTree.tsx`

- **Props:** `{ rootPaths: Array<{ id: string; label: string; absPath: string }>; onFileSelect?: (rootId: string, relPath: string) => void }`
- **Internal state:** `treeData: Map<string, TreeNode[]>`, `selectedId: string | null`, `isLoading: boolean`, `error: string | null`
- **Children:** `TreeHeader`, `TreeNode` (rendered by react-arborist via `children` prop), `TreeEmptyState`, `TreeErrorState`
- **Multi-root behavior:** The component renders one collapsible tree section per entry in `rootPaths`, with the `label` shown above each section. `App.tsx` is required to pass two entries for Phase 3: `{ id: 'workspace', label: 'Workspace', absPath: '<userData>/workspace/default/' }` and `{ id: 'bots', label: 'Memory & Tools', absPath: '<userData>/bots/default/' }`. This makes `memory.md` and `facts.json` visible to the user (UI-08 success criterion #4 — "including memory file").
- **Hooks:** `useEffect` subscribes to `tree:refresh` and `tree:error`; on mount invokes `window.localbot.invoke('tree:list', { path: rootPaths[i].absPath })` for each entry.

### 9.2 `src/renderer/components/DiffView.tsx`

- **Props:** `{ file: string; before: string; after: string; binary?: boolean }`
- **Internal state:** `mode: 'split' | 'unified'`
- **Children:** `DiffHeader`, `DiffBody`, `DiffBinaryPlaceholder` (when `binary === true`)
- **Behavior:** When `before.includes('\0') || after.includes('\0')` it sets `binary` internally regardless of the prop; the placeholder wins.

### 9.3 `src/renderer/components/MemoryPill.tsx`

- **Props:** `{ stats: { factCount: number; bytes: number; updatedAt: string | null } }`
- **Internal state:** `open: boolean`
- **Children:** `MemoryPanel` (lazy-mounted on first open; remains mounted for the rest of the session)
- **Behavior:** On click toggles `open`; on Escape or backdrop click sets `open = false`.

### 9.4 `src/renderer/components/MemoryPanel.tsx`

- **Props:** `{ markdown: string; facts: Record<string, { value: unknown; updatedAt: string }>; onClose: () => void }`
- **Internal state:** none (props-driven)
- **Children:** markdown body (rendered via fenced `<pre>` for Phase 3; full markdown renderer deferred to a later phase), facts list (`<ul>`), close button
- **Note:** Read-only in Phase 3.

### 9.5 `src/renderer/components/SummaryBlock.tsx`

- **Props:** `{ summary: string; turnsFolded: number; ranAt: string }`
- **Internal state:** none
- **Children:** `SummaryBadge`, `SummaryBody`, `SummaryMeta`
- **Behavior:** Renders as its own `.bubble .bubble-summary` variant inside the message list. Not a regular user/assistant bubble.

### 9.6 `src/renderer/components/SessionSwitcher.tsx`

- **Props:** `{ currentSessionId: string; bot: string; onSelect: (sessionId: string) => void }`
- **Internal state:** `open: boolean`, `sessions: SessionEntry[]`, `loading: boolean`, `error: string | null`
- **Children:** `SessionTrigger`, `SessionDropdown` (mounted conditionally), `SessionListItem` (one per session)
- **Behavior:** On trigger click toggles `open`; on session click calls `onSelect` and closes.

### 9.7 `src/renderer/components/MessageBlock.tsx` (extend)

- Existing component extended with a new `tool_result` branch: when `block.toolUseId` references an `edit_file` result carrying `{ before, after, file, binary? }`, render `<DiffView>` instead of `<pre>`. The branch is gated by a discriminator on the tool name (carried by the renderer state, not on the block itself — see Section 12).

## 10. State Management

Phase 3 extends `src/renderer/state/messages.ts` (or, if it grows, adds sibling hooks in the same directory). Three new slices are introduced.

### 10.1 `workspaceTreeSlice`

- **State:** `treeData: TreeNode[]`, `loading: boolean`, `error: string | null`, `selectedNodeId: string | null`
- **Actions / reducers:**
  - `setTreeData(data: TreeNode[]): void`
  - `setTreeLoading(b: boolean): void`
  - `setTreeError(message: string | null): void`
  - `selectNode(id: string | null): void`
  - `refreshTree(): Promise<void>` (invokes `tree:list` IPC)

### 10.2 `memorySlice`

- **State:** `stats: { factCount: number; bytes: number; updatedAt: string | null }`, `markdown: string`, `facts: Record<string, { value: unknown; updatedAt: string }>`, `panelOpen: boolean`, `loading: boolean`, `error: string | null`
- **Actions / reducers:**
  - `setMemoryStats(stats): void`
  - `setMemoryContent(markdown, facts): void`
  - `openMemoryPanel(): Promise<void>` (fetches fresh content)
  - `closeMemoryPanel(): void`
  - `setMemoryLoading(b): void`
  - `setMemoryError(message): void`

### 10.3 `sessionListSlice`

- **State:** `sessions: SessionEntry[]`, `currentSessionId: string`, `dropdownOpen: boolean`, `loading: boolean`, `error: string | null`
- **Actions / reducers:**
  - `setSessionList(sessions): void`
  - `setCurrentSession(id): void`
  - `openSessionDropdown(): Promise<void>` (fetches fresh list)
  - `closeSessionDropdown(): void`
  - `setSessionLoading(b): void`
  - `setSessionError(message): void`

### 10.4 `SessionEntry` type

```ts
interface SessionEntry {
  sessionId: string;
  startedAt: string;     // ISO
  messageCount: number;
  isActive: boolean;
}
```

### 10.5 Existing `useMessages` integration

- No changes to `useMessages` itself. SummaryBlock is rendered as a sibling to messages (it lives in its own renderer path keyed off a new `headSummary` slot in the message list).
- The chat mount logic is extended to also load `headSummary` for the current session and to feed `messages.ts#setMessages(initialMessages)` as before.

## 11. IPC Events

Four new event channels extend the locked Phase 1 IPC contract (D-07). Existing channels are not renamed.

### 11.1 `tree:refresh`

- **Direction:** main -> renderer
- **Trigger:** daemon's chokidar watcher emits after 250 ms debounce following any change inside either `<userData>/workspace/default/` or `<userData>/bots/default/`. The renderer routes the event to the matching `WorkspaceTree` section by `rootPath` prefix.
- **Payload:**
  ```ts
  interface TreeRefreshEvent {
    bot: string;             // 'default' in Phase 3
    rootPath: string;        // absolute path (one of the WorkspaceTree rootPaths[i].absPath)
    changedPaths: string[];  // relative to rootPath
  }
  ```

### 11.2 `tree:error`

- **Direction:** main -> renderer
- **Trigger:** daemon's `tree/list` or chokidar emits an unrecoverable error (e.g. permission denied).
- **Payload:**
  ```ts
  interface TreeErrorEvent {
    bot: string;
    rootPath: string;
    code: 'EACCES' | 'ENOENT' | 'EMFILE' | 'UNKNOWN';
    message: string;
  }
  ```

### 11.3 `memory:updated`

- **Direction:** main -> renderer
- **Trigger:** any successful `memory.read` / `memory.write` / `update_memory` tool call; also fired once on app start after the daemon reports its initial state.
- **Payload:**
  ```ts
  interface MemoryUpdatedEvent {
    bot: string;
    factCount: number;
    bytes: number;
    updatedAt: string;       // ISO
    markdown?: string;       // included only on first read after start
    facts?: Record<string, { value: unknown; updatedAt: string }>;
  }
  ```

### 11.4 `history:loaded`

- **Direction:** main -> renderer
- **Trigger:** renderer invokes `history:load` IPC; main returns the result and emits `history:loaded` so other surfaces (SessionSwitcher) can sync.
- **Payload:**
  ```ts
  interface HistoryLoadedEvent {
    bot: string;
    sessionId: string;
    messages: ChatMessage[];
    headSummary: SummaryRecord | null;
  }

  interface SummaryRecord {
    summary: string;
    turnsFolded: number;
    ranAt: string;           // ISO
  }
  ```

### 11.5 `tree:list` (renderer -> main invoke)

- **Direction:** renderer -> main -> daemon (JSON-RPC `tree/list`)
- **Payload request:**
  ```ts
  interface TreeListRequest {
    path: string;            // absolute root
    maxDepth?: number;       // default 5
    maxEntriesPerDir?: number; // default 500
    exclude?: string[];      // default ['node_modules', '.git', '.next', 'dist', 'target', '__pycache__', '.venv']
  }
  ```
- **Payload response:**
  ```ts
  interface TreeListResponse {
    entries: TreeNode[];
    truncated: boolean;
  }

  interface TreeNode {
    name: string;
    path: string;            // absolute
    type: 'file' | 'dir';
    size?: number;           // bytes, files only
    children?: TreeNode[] | null; // null = not yet expanded
  }
  ```

### 11.6 `history:listSessions` + `history:load`

- **Direction:** renderer -> main invoke (paired responses)
- `history:listSessions` payload request: `{ bot: string }`. Response: `SessionEntry[]` (newest first).
- `history:load` payload request: `{ bot: string; sessionId: string }`. Response: `{ messages: ChatMessage[]; headSummary: SummaryRecord | null }`.

### 11.7 `memory:read`

- **Direction:** renderer -> main invoke -> daemon (JSON-RPC `memory/read`)
- **Payload request:** `{ bot: string }`.
- **Payload response:** `{ markdown: string; facts: Record<string, { value: unknown; updatedAt: string }>; bytes: number; factCount: number; updatedAt: string }`.

## 12. Accessibility

- **Tree keyboard navigation:** react-arborist provides built-in ArrowUp / ArrowDown / ArrowLeft (collapse) / ArrowRight (expand) / Enter (open file) / Home / End. No custom keymap; expose via `aria-keyshortcuts` on the tree container.
- **Focus indicators:** every interactive element gets a 2 px focus ring in `--lb-tree-focus`. The ring is offset by 2 px so it never collides with the 1 px border.
- **ARIA labels:**
  - `WorkspaceTree`: `role="tree"`, `aria-label="Workspace files"`. Each node: `role="treeitem"`, `aria-expanded` for directories, `aria-selected` for the focused node.
  - `MemoryPill`: `role="button"`, `aria-haspopup="dialog"`, `aria-expanded` tracks `panelOpen`.
  - `MemoryPanel`: `role="dialog"`, `aria-modal="true"`, `aria-labelledby="memory-panel-title"`. Focus trap while open.
  - `SessionSwitcher`: `role="menu"`, `aria-label="Sessions"`; each item `role="menuitem"`.
  - `DiffView`: `role="region"`, `aria-label="Diff for <file>"`; mode toggle `role="group"` with two `aria-pressed` buttons.
- **Contrast:**
  - Pill text (`--lb-pill-text` = `#1d4ed8`) on pill bg (`#eff6ff`) = 6.8 : 1 — passes WCAG AA.
  - Summary body (`--color-text-muted` = `#6b7280`) on summary bg (`#f9fafb`) = 4.6 : 1 — passes WCAG AA for body text.
  - Binary placeholder text (`#92400e`) on `#fef3c7` = 5.5 : 1 — passes WCAG AA.
  - Tree size suffix (`--lb-sidebar-text-muted`) on sidebar bg = 4.6 : 1 — passes AA.
- **Screen reader announcements:**
  - Tree refresh fires an `aria-live="polite"` region with the message "Workspace updated".
  - Memory pill click announces the modal opening.
- **No reliance on color alone:** every state (selected, active, error) carries both color and an icon or text label.

## 13. Empty / Error / Loading States

### 13.1 Workspace Tree

- **Loading:** center-aligned muted text "Loading workspace…" inside the sidebar body. Skeleton not used in Phase 3.
- **Empty (no workspace dir):** muted text "No files yet — chat with the bot to create files". No button.
- **Empty (dir exists, empty):** muted text "Workspace is empty". No button.
- **Error:** muted text "Could not read workspace. Click to retry." with the whole row clickable to re-invoke `tree:list`.

### 13.2 Diff View

- **Loading:** "Rendering diff…" appears below the diff header for the duration of the mount. The component itself is synchronous; the placeholder is shown only on the first paint after mount.
- **Empty (before == after):** diff still renders (zero changes is a valid signal); the header shows "(no changes)" instead of "Diff: <file>".
- **Error / binary:** binary placeholder shown (Section 1.2).

### 13.3 Memory Pill + Panel

- **Pill loading:** never shown — the pill is always rendered; the stats are populated on first `memory:updated` event.
- **Panel loading:** "Loading memory…" inside the panel body while the fetch is in flight.
- **Panel empty:** "Bot has not recorded any memory yet".
- **Panel error:** "Could not load memory. Click to retry." with the body clickable.

### 13.4 Summary Block

- **Loading:** not applicable — the block is rendered from already-persisted JSONL state on mount.
- **Empty:** not applicable — a summary record only exists if summarization ran.
- **Error:** if `SummaryRecord.ranAt` is unparseable, fall back to "Conversation summarized" without the meta line (no error UI needed).

### 13.5 Session Switcher

- **Loading:** "Loading sessions…" inside the dropdown.
- **Empty:** "No previous sessions" inside the dropdown. The trigger remains active so the user can re-open later.
- **Error:** "Could not load sessions. Click to retry." with the dropdown body clickable.

## 14. Open Questions

These items need user decision before the planner begins; they are intentionally NOT locked.

1. **Memory panel markdown rendering depth.** Phase 3 renders memory.md as fenced `<pre>` (matches existing message rendering). Full markdown (headings, lists, links) is deferred. Confirm acceptable, or escalate.

2. **Diff default mode.** Locked to "Split" on wide viewports and "Unified" on narrow, with a manual toggle. Confirm acceptable, or specify a different default (e.g. always Unified).

3. **Sidebar default state on first launch.** Locked to expanded on viewports >= 900 px. Confirm acceptable, or specify "always collapsed" / "remember last state".

4. **Memory panel edit affordance.** Phase 3 makes MemoryPanel read-only. Adding an "Edit" button opens a future phase. Confirm read-only is acceptable for Phase 3, or specify a different approach.

5. **Session switcher write protection.** Switching to a past session while a streaming response is in-flight cancels the in-flight message (matches existing Stop semantics). Confirm acceptable, or specify a confirmation modal.

6. **Tree refresh announcement verbosity.** Phase 3 announces "Workspace updated" on every chokidar refresh. Some users may prefer silence. Confirm acceptable, or specify muted announcements.

---

## 15. Out of Scope

These items appear in adjacent phases or in deferred ideas from RESEARCH.md and must NOT be added in Phase 3:

- Multi-bot UI (Phase 4). Bot is hard-coded to `default`.
- Edit affordance inside MemoryPanel.
- Markdown full rendering for memory.md (renderer concern; deferred).
- Cross-bot shared memory.
- Vector / semantic memory retrieval.
- `git`-backed memory versioning / rollback.
- Per-tree-node right-click context menu (Phase 4 or later).
- Drag-and-drop file upload to workspace.
- File preview / syntax highlighting inside the diff (Phase 8+).
