# Concise agent activity

Research and proposed interaction design, September 6, 2026. The presentation layer described below is now implemented. Per-tool lifecycle persistence remains future work. Findings below come from public source code and documentation; neither reference app was run interactively for this study.

## Reference patterns

### Codex CLI

- A compact status line defaults to **Working**, animates the text with a shimmer, and keeps elapsed time and the interrupt hint beside it. The label can change without adding a new block to the transcript.
- Related reads are coalesced into an **Exploring / Explored** block. The renderer summarizes file names instead of repeating every command and output.
- Long command output has a bounded preview and an explicit `ctrl + t` hint to open the transcript. This is keyboard disclosure in the CLI, not evidence of a desktop click interaction.

Sources: [status indicator](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/tui/src/status_indicator_widget.rs), [execution renderer](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/tui/src/exec_cell/render.rs), [official CLI documentation](https://learn.chatgpt.com/docs/codex/cli).

### OpenCode web/desktop components

- `BasicTool` starts closed unless its caller overrides that behavior. Its trigger combines a short tool title with a useful target, such as a filename or command. The title shimmers when the tool is pending or running.
- Consecutive context tools are grouped into a collapsed **Gathering context / Gathered context** row with read/search/list counts. Expanding it reveals the individual operations.
- Shell tools can be opened while running; expansion reveals the command and output in a scrollable region. Other tools have different defaults: disclosure is specific to the tool, not a universal hide-everything rule.
- The turn can show **Thinking** while working without visible content. A separate text reveal can show a reasoning heading when reasoning summaries are hidden.
- The shimmer uses a 1.2-second sweep and disables animation for reduced motion. The important pattern is animation attached to meaningful status text.

Sources: [tool disclosure](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/session-ui/src/components/basic-tool.tsx), [context grouping and tool renderers](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/session-ui/src/components/message-part.tsx), [turn loading state](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/session-ui/src/components/session-turn.tsx), [shimmer styles](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/ui/src/components/text-shimmer.css).

## Before implementation

Previously, `src/features/wallie/session-wallie-panel.tsx` initially expanded the newest run. Its primary card presented stage, status, attempt, provider/model, start/end times, requester, latest operation, elapsed time, last-event time, connection state, and the message timeline. Each message repeats a kind label and timestamp. Tool messages render full input payloads as code blocks.

`currentOperationLabel()` previewed the latest message verbatim, including tool markdown. That lets implementation syntax leak into the most prominent activity label.

## Proposed interaction

The default should fit in two or three quiet lines:

1. **One clickable status row:** chevron, shimmering **Working**, stage, elapsed time, and a separate **Stop** action.
2. **One useful sentence:** the latest concise agent progress message, when available. Long prose gets an explicit expansion; final artifacts remain in the review area.
3. **One compact latest-event hint:** for example, **Latest: Shell · pnpm check**. Hide this when it duplicates the progress sentence.

Clicking the status row reveals the activity list:

- Group adjacent reads, searches, and listings into a neutral **Exploration · 2 reads, 1 search** row. Expanding it reveals file and query summaries. Keep stable group IDs based on the first event.
- Give commands, edits, and integration calls individual one-line summaries. Use deterministic tool-specific extraction: tool + filename, command, query, or URL. Treat descriptions as untrusted display text.
- Clicking a tool reveals its full persisted input. Preserve unknown tools and malformed payloads with a readable fallback and access to the original text.
- Put model, attempt, requester, exact timestamps, run ID, branch, sandbox, and healthy connection information in **Run details**.
- Keep earlier runs collapsed as compact stage/status/duration rows.
- Preserve the user's disclosure state as events arrive. Do not reopen tools automatically or move their scroll position while they inspect history. Keep the collapsed summary subscribed to live updates.

## Loading and exception behavior

| State                               | Default presentation                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Queued                              | **Waiting in queue**; no implication that tools are executing                                                 |
| Active, no tool lifecycle available | Shimmer **Working**; static **Latest: …** event hint                                                          |
| Loading history                     | **Loading activity…** inside the open disclosure; keep the run summary visible                                |
| Success                             | Static **Completed** and elapsed duration; artifact review remains the next action                            |
| Error                               | **Failed**, a short error outside disclosure, and **Retry**; raw diagnostics behind a click                   |
| Canceled                            | Static **Canceled**; preserve all history                                                                     |
| Disconnected                        | **Live updates paused** outside disclosure; stop implying that displayed activity is live                     |
| Stalled                             | **No recent activity** outside disclosure; retain the existing stall timeout and cancel-before-retry behavior |

Animate only the active status label, not every historic event. Start with a Codex-style two-second shimmer, stop it for terminal/disconnected/stalled states, and honor reduced motion with a static label. Avoid fake percentages and cycling invented verbs. Use polite announcements for meaningful state changes; do not announce every timer tick or streamed fragment. All disclosure controls need keyboard access, visible focus, and accurate expanded state.

## Data boundary and implementation sequence

The current `WallieRunMessage` contract has only ID, kind, markdown, and creation time. `persistEvent()` stores a tool name and input in a markdown wrapper. It does not persist correlated per-tool start/completion state, duration, exit code, or output. The Codex parser also ignores `item.started` and currently does not handle `command_execution` items. This means an active run's latest tool event cannot safely be labeled as an executing or successful tool.

**First change: presentation using existing data.** Collapse the primary run by default; simplify its header; parse tool input into one-line labels; add tool disclosure and adjacent exploration grouping; move diagnostics into Run details; retain visible failures and recovery controls. Use **Working** for the run and **Latest: …** for tool hints. Preserve exact stored input and existing realtime/recovery behavior. No database migration is needed for this layer.

**Second change: accurate tool lifecycle.** Extend the normalized runner event contract and forward-only persistence with correlated tool IDs, start/update/end events, status, outputs, and optional timings. Add support for the providers' actual event shapes, including Codex command execution. Then enable labels such as **Running tests → Tests passed**, live output inside open tools, and verified per-tool duration. Keep old messages renderable and missing state explicitly unknown.

Validation for implementation: disclosure survives live inserts; collapsed summaries stay current; errors are visible with history closed; cancellation/retry and stall recovery remain correct; unknown tools and large payloads remain inspectable; keyboard and reduced-motion behavior work; long paths fit mobile widths; no per-tool success is inferred from run success. Run the repository's canonical checks when application code changes.

## Implementation

The activity view now lives in `src/features/wallie/run-activity.tsx`, with the existing panel retaining ownership of queries, subscriptions, and recovery actions. Runs start collapsed; payload formatting and rendering wait until the tool is opened. Exploration groups keep the first event ID even when they contain only one event, preserving disclosure state as later reads arrive.

`ShimmerText` uses a two-second CSS sweep inspired by [Codex's motion implementation](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/tui/src/shimmer.rs), with static text for reduced motion and forced colors. Tool events never receive an inferred running/success state.

The development-only `/dev/agent-activity` route exercises the production component with working, queued, completed, failed, canceled, disconnected, stalled, loading, and empty fixtures.
