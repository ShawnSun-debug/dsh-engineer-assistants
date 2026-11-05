# DSH Orchestrator

The "dispatch mode" plugin for DeepSeek Harness.
  
  The main agent only clarifies, plans, slices work, and accepts results
    
  Every concrete action goes to a worker through one `dispatch` tool: a single self-contained task, or a declarative batch.
    
  A high-risk dispatch is judged by a zero-context reviewer before any worker starts; a `BLOCK` starts nothing.
    
  The main agent and the subagents have their default models and reasoning effort configured independently, and all subagents share the same subagent route. The reviewer follows the subagent route unless its own route is set.

[中文](README.md)

## How it differs from a plain single-agent session

| | Plain single-agent session | Dispatch mode |
| --- | --- | --- |
| Who executes | the main model calls tools itself | workers execute; the main agent only dispatches |
| Context | tool output piles up in the main agent context | each worker carries its own context |
| Parallelism | tool calls complete one after another | several workers run at once |
| Models | one model does everything | two routes, main agent and subagent |
| Boundaries | the model is expected to comply | the gate refuses by force |


## Key features

- **The main agent only plans, enforced by a gate**:
  
     a built-in deny list of 42 tools hides and refuses read, write, shell, web, and other tools at execution time; the main agent keeps only `dispatch`, `send_message`, `todo_write`, `ask_user_question`, `compress`, plus the session tools (`session_*`) and `interrupt_agent`.
  
- **One dispatch entry**:

    A task card (`goal`, `doneDefinition`, `files`, `deps`, `verify`, `fallback`) is the unit of dispatch. Omit `items`/`stages` for a single self-contained task; give both for a batch of 1–64 items through 1–8 ordered stages, capped by `maxConcurrency` (1–16, default 4).
  
- **Review before dispatch**:

    A high-risk card — a missing field, an irreversible write, or more than 4 items — is judged once by a zero-context reviewer that sees the card but not the conversation. The verdict is `BLOCK`, `IMPROVE` or `PASS`; a `BLOCK` starts no worker and comes back as an error carrying the failure mechanism and the target. `PASS` is legal but must list what was checked. The reviewer follows the subagent route unless its own route is configured.
  
- **Four phases**:

    `plan → review → dispatch → settle`. A settled dispatch is recorded, keeps its session log, and leaves the patrol due set; nothing is deleted, so retries and post-mortems still read the original trace.
  
- **Supervision and correction**:
  
    When a dispatched worker runs long, the plugin merges its session log into one notice that wakes the main agent; the main agent corrects it with a concrete `send_message`, or decides no intervention is needed and ends the turn with a one-line note.

    When a worker is interrupted with `interrupt_agent` and later woken again by `send_message`, supervision takes it back: the notice count restarts from the first notice, and the log from before the interruption does not count as new activity.
  
    ![Example patrol notice and correction](docs/images/patrol-notice.png)
  
    *Each patrol notice summarises one running subagent — elapsed time, rounds, steps, new tool calls since the last patrol, latest tool, and last output — and the main agent then chooses to leave it alone (replying one line 「巡检：正常」), correct it with `send_message`, or terminate. In the screenshot the main agent sends corrective guidance to a subagent stuck on shell quoting and backslashes.*
  
- **Collecting results**:

    A single `dispatch` returns `{ kind: "activation", subagentId }` immediately, and when the worker finishes the host delivers its result to the main agent as a message. A batch `dispatch` returns `{ kind: "orchestration", agentsStarted, results, errors }` synchronously, with `results` in input order and `null` for a failed item.
  
- **Declarative batch**:

    A batch does single-stage fan-out and multi-stage per-item pipelines (no global barrier); one failed item does not sink the others, and a stage can declare an object schema for structured results.

## Install

Add it from GitHub in the DSH plugin page, or use the CLI:

```text
SShiRkiT/dsh-orchestrator#main
```

```bash
dsh plugin --profile desktop add SShiRkiT/dsh-orchestrator#main
```

After installing, **fully quit and reopen DSH**: client plugins are composed at startup and are not hot-updated.

## Enable

1. Dispatch mode is already on after installing and restarting (`enabled` defaults to `true`).
2. In the composer's "Dispatch mode" panel, configure `workerProvider` and `workerModel` (required) and `workerReasoningEffort` (may stay empty, letting the model resolve its default effort); dispatching without a route fails outright instead of silently inheriting the main-agent model.
3. Turning off the "Enable dispatch mode" switch temporarily restores all main-agent tools and applies to already-open sessions immediately.
4. The Denied Tools list on the right of the panel names every tool the host currently offers — read live at start and again whenever the registry changes, so tools another plugin or an MCP server registers are listed too: check to deny, uncheck to allow, with nothing locked out of the list — the dispatch tools (`dispatch`, `send_message`, `todo_write`, `compress`) are rows like any other; "Reset to defaults" returns to the 42 built-ins. A checkbox change rebuilds the main agent's tool table at once, so an already-open session sees it on its next message, with no new session and no switch off/on.

![Dispatch mode panel](docs/images/dispatch-panel.png)

*The dispatch mode panel: the enable switch, the main agent's and the subagents' models and reasoning effort, and the subagent patrol interval (default 600 s, range 10–86400); the Denied Tools list sits on the right.*

## Configuration

Every field is volatile: the host stores it and the plugin re-reads it on each use, so changing the configuration needs no restart.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for dispatch mode. When off it revokes the hiding; the guard stays installed but lets calls through. |
| `deniedTools` | 42 built-ins | Tools the main agent may not use, added on top of the built-ins. |
| `allowedTools` | `[]` | Built-in tools the profile re-allows; the effective list is built-ins + `deniedTools` − `allowedTools`. |
| `workerProvider` | `""` | Subagent provider; empty means unconfigured. |
| `workerModel` | `""` | Subagent model; empty means unconfigured. |
| `workerReasoningEffort` | `""` | Subagent reasoning effort; empty means it is not passed and the model resolves the default. |
| `reviewProvider` | `""` | Reviewer provider; used only together with `reviewModel`. Both empty means the reviewer follows the subagent route. |
| `reviewModel` | `""` | Reviewer model; see above. |
| `reviewReasoningEffort` | `""` | Reviewer reasoning effort; empty means the model resolves the default. |
| `lastReview` | `""` | The `{ verdict, target, at }` summary of the latest review, written by the plugin and shown read-only in the panel. |
| `superviseEnabled` | `true` | Master switch for supervision. |
| `superviseIntervalSeconds` | `600` | Supervision interval in seconds, an integer 10–86400. |
| `superviseMaxNoticesPerChild` | `3` | Most notices per subagent, an integer 0–20; `0` means unlimited. |
| `superviseNotifyOnNoProgress` | `false` | Whether to also notify when the log has no new activity. |
| `toolCatalog` | `[]` | The live tool catalog the plugin publishes: every tool name the host currently offers, which is how the panel lists tools beyond the 42 built-ins (MCP servers and other plugins included). Written by the plugin; do not edit it by hand. |

The main agent's default route is not part of this configuration: it lives in the host's `agent-default-model` (`provider` / `model` / `reasoningEffort`), is written by the same panel, and is read when a new agent is created.

## Usage

### Breaking change: `delegate` and `orchestrate` are gone

Neither name is registered any more, so a prompt that still names one does not work. Rewrite each call as `dispatch` and add the task-card fields.

### dispatch: one task

A single dispatch needs `prompt` (the complete task) and `description` (a 3–5 word display name), plus the task card: `goal`, `doneDefinition`, `files`, `deps`, `verify`, `fallback`. A card that misses a field, touches an irreversible write, or fans out to more than 4 items is high risk and is reviewed before any worker starts; a complete low-risk card goes straight out. The worker cannot see the main agent's conversation, so the prompt has to carry all the context itself:

```json
{
  "description": "move config loading",
  "prompt": "Goal: move config loading from config.ts to settings.ts without changing behaviour\nFiles you may change: src/config.ts, src/settings.ts\nAcceptance: node --test test/settings.test.mjs\nOn failure: revert and report why",
  "goal": "move config loading from config.ts to settings.ts without changing behaviour",
  "doneDefinition": "the suite passes and no call site loads config through config.ts",
  "files": ["src/config.ts", "src/settings.ts"],
  "deps": [],
  "verify": "node --test test/settings.test.mjs",
  "fallback": "revert the move and report why"
}
```

Every worker gets the same fixed instruction at the start of its prompt: `用中文回复。` (answer in Simplified Chinese), followed by the requirement to end the turn with the final summary in the reply and not to call `send_message` to report completion, because the parent receives the closing message automatically. For several independent tasks, call `dispatch` once each in the same message and they all start at once.

### dispatch: a batch

"One set of items × one fixed set of stages" uses the same tool with `items` and `stages`. With a single stage, every item gets its own worker:

```json
{
  "description": "summarize items",
  "goal": "summarize three items",
  "doneDefinition": "each item has a one-sentence summary",
  "files": [],
  "deps": [],
  "verify": "every result is non-empty",
  "fallback": "report the failed items instead of guessing",
  "items": ["alpha", "beta", "gamma"],
  "stages": [
    { "name": "summarize", "prompt": "Summarize this item in one sentence." }
  ],
  "maxConcurrency": 2
}
```

With several stages, items advance one by one and a later stage automatically receives the earlier output of the same item. `items` is 1–64 and `stages` is 1–8; the call returns `{ kind: "orchestration", agentsStarted, results, errors }`, with `results` in input order and `null` for a failed item.

A single `dispatch` is asynchronous: it returns immediately and there is no progress callback; the main agent has no tool to stop a worker — stopping one takes a host-side action.

## License

MIT © 2026 SShiRkiT
