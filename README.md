# Node Memory Graph (NMG)

English | [简体中文](README.zh-CN.md) · [Terms](README.terms.yaml)

**Give your agent a memory that stays with you.**

NMG is a local-first memory layer for AI agents. It saves useful facts,
preferences, decisions, and their evidence so an agent can find them in a later
session. The memory lives in SQLite on your machine and can be shared across
supported agent tools.

[Try the memory loop](#try-it) · [Connect your agent](#connect-your-agent) · [How it works](#architecture)

## What can I use it for?

- **Pick up where you left off.** Keep project decisions and constraints
  available across sessions instead of explaining them again.
- **Remember how you like to work.** Save an explicit preference once and let
  an agent retrieve it when relevant.
- **Check the source.** Search returns compact candidates; the agent can open a
  selected memory and its supporting evidence before using it.
- **Coordinate a task.** Agents can use the temporary Task Board to share
  attributed work and handoffs alongside their longer-lived memory.

NMG is a memory component, not an agent or a model. It does not guarantee that
an agent will save or recall every useful detail, or that a remembered claim is
true. Integrations need setup. See the [security boundary](#security-boundary).

## What does it look like?

A small example, adapted from the executable tutorial below:

```text
Remember:  The user prefers concise technical answers.
Search:    How should answers be written?
Candidate: The user prefers concise technical answers.  [memory ID]
Get:       The user prefers concise technical answers.  [exact evidence]
```

The candidate is a compact lead, not a proof. `get` opens the selected record
and evidence. In a connected agent this happens through tools; you can also run
the workflow yourself from the CLI. The exact IDs and output vary by run.

## Try it

You need **Node.js 22.19 or newer** and a local checkout of this repository.
From the checkout root:

```sh
npm ci
npm run tutorial:first-recall
```

The tutorial creates a private temporary SQLite store, remembers one preference,
searches for it, and opens the exact record. It cleans up on exit; it does not
call an LLM or embedding service or touch your normal NMG memory. In an
interactive terminal it pauses between steps. For a non-interactive run, use
`npm run tutorial:first-recall -- --non-interactive`.
[See the walkthrough](docs/guides/first-recall.md) for the commands and their
meaning.

### Connect your agent

Send this prompt to your agent and let it set up NMG for its environment:

```text
Please install and connect Node Memory Graph (NMG) for me:
https://github.com/wefio/NodeMemoryGraph

First identify your current agent host, operating system, and existing setup.
Use an existing persistent checkout if available; otherwise clone the repo to
a suitable persistent directory. Read the repository README, the relevant
adapter instructions, and skills/nmg-memory/SKILL.md. Choose the best supported
integration for this environment.

Install the required dependencies, build, and configure the integration while
preserving existing settings and data. Use a native adapter or MCP when
supported; otherwise use the CLI and Skill. Do not overwrite existing
configuration or stop or restart a shared daemon that this setup did not start.

Verify the memory loop with the repository's temporary-store tutorial, then
check whether the current host can discover or call the configured tools.
Report the install location, enabled capabilities, verification results, and
any restart or action I need to complete. Do not treat a passing tutorial as
proof that the host integration works.
```

If the agent cannot access the network or identify its host, it will need the
repository location or environment details from you. The table below can help
you choose an integration.

### Adapters and capabilities

| Environment | What you can use | Limits to know |
| --- | --- | --- |
| [Pi](#pi) | Save and search memory, open evidence, automatic recall, working state, Task Board and optional Lab | Automatic writes and recall follow the integration policy |
| [OpenCode v2](opencode-plugin/README.md) | Memory tools, automatic recall, working state and Task Board | The first turn of a new service may lack project scope; some wake capabilities are limited |
| [Claude Code / MCP](#claude-code-plugin) | Memory tools, working state, Task Board and optional Lab | Explicit MCP calls; no automatic per-turn recall or push wake |
| [DeepSeek Harness](dsh/README.md) | Memory tools, automatic recall and Task Board | The legacy adapter and [web host package](dsh/dsh-nmg/README.md) differ in capabilities and setup |
| [WorkBuddy](workbuddy-plugin/README.md) | Hook-based automatic recall; can combine MCP tools and Skill | The hook itself has no memory tools; hook and MCP session state differ |
| Other tool-capable agents | [CLI + Skill](#agent-independent-cli) to save, search and open memory | The agent must run the CLI and read the Skill; automatic recall depends on the host |

Adapters expose native tools and transport the calls. Pi, Claude MCP, DSH, and
the benchmark bridge share the Agent Surface for compact search, exact evidence,
remember follow-up, Task Board output, redaction, and logical-chain projection.
Host-specific lifecycle, tool schemas and transport fallbacks remain in adapters.
See the [capability matrix](docs/design/harness-capability-matrix.md) for details.
Its legacy DSH automatic-recall entry differs from the current implementation;
use the adapter source and instructions for that capability.

### Pi

For manual setup, install [Pi](https://github.com/earendil-works/pi), then from
the NMG checkout:

```sh
npm run build
pi install ./
pi
```

Run `pi install ./` from the checkout root. The extension exposes
`nmg_remember`, `nmg_search`, `nmg_get`, `nmg_state`, and `nmg_lab`.
Tell the agent a preference or project constraint to remember, then ask about it
in a later session. Automatic recall and writes are governed by the integration's
rules; check results instead of assuming every turn is saved.

## Claude Code plugin

The repository includes a local MCP server. Install dependencies and configure
your client's MCP settings using the [Claude/MCP setup](claude-plugins/nmg-memory/CLAUDE.md#adding-to-any-mcp-client).
For Claude Code that guide shows a project `.mcp.json`; create it as described
rather than assuming it exists in a fresh checkout. Start a new client session
after configuration.

## Agent-independent CLI

The CLI lets a tool-capable agent use NMG without a native plugin. From a
checkout, `npm run cli -- <command>` runs the source CLI; an installed package
also exposes `nmg`.

```sh
npm run cli -- status
npm run cli -- remember "The user prefers concise technical answers." --node "Response preferences" --type preference
npm run cli -- search "How should answers be written?" --compact-json
```

Search returns candidate IDs. Use `get` on the IDs you select; when search
returns an `activeGraphId`, pass it to `get` to retain disclosure attribution.
The [first-recall walkthrough](docs/guides/first-recall.md) shows the complete
flow. Run `npm run cli -- <command> --help` for current arguments. For graph
inspection, `npm run cli -- graph --out memory-graph.html` exports a local HTML
view of nodes and relationships.

## Agent Skill

The [NMG Skill](skills/nmg-memory/SKILL.md) teaches compatible agents when to
search, open evidence and save durable information. Follow its installation
instructions to link the whole Skill directory into your agent's configured
skills location. For a generic agent this is a CLI-plus-Skill integration and
may require setup.

## Architecture

```text
Agent / adapter
    │  search · get · remember · state
    │  JSON-RPC over local HTTP
    ▼
NMG daemon ── session working state
    │
    └── SQLite: memory, evidence, graph and Task Board
```

The adapter's client code sends JSON-RPC over HTTP to the daemon; the HTTP
handler and memory service run in the daemon. The default Pi store is
`~/.nmg/nmg.sqlite`; `NMG_DATA_DIR` selects another directory. Project-local
STG data has its own location. The [concept map](docs/guides/concept-map.md)
explains durable memory, session state and the evidence path. See the
[design baseline](docs/design/design.md) for the full contract.

### Semantic memory contract

Facts, preferences, constraints, states and events have different meanings.
NMG retains provenance and scopes memory so a preference does not become a fact
or a global rule. Explicit writes are available; automatic writes depend on the
integration and its policy. The [design](docs/design/design.md) owns the details.

## Headless Pi control

The repository includes local headless Pi helpers for development and evaluation:
`npm run pi:state` inspects the configured model, and
`npm run pi:prompt -- "Your prompt"` runs a fresh session. Pi QPP controls
and their caller-specific defaults are documented in the
[controller design](docs/design/retrieval-confidence-controller/confidence-and-trigger-design.md#caller-specific-activation)
and [optional capabilities](skills/nmg-memory/references/optional-capabilities.md).
These helpers are separate from the first-recall tutorial and may require a
configured model.

## Results

Evaluation records and reproduction instructions live in [benchmark results](docs/experiments/benchmark-results.md)
and the [evaluation guide](evals/README.md). Read each result with its dataset,
judge and environment limits; a benchmark is not a guarantee for your tasks.

## Security boundary

The local store stays on your machine. If you configure an external embedding
provider, text selected for embedding is sent to that provider; see
[embedding configuration](skills/nmg-memory/references/embedding.md). NMG does
not provide a sandbox or execute agent work in isolation. Configure your agent
and its execution environment separately.

## More

- [First recall tutorial](docs/guides/first-recall.md) · [Concept map](docs/guides/concept-map.md)
- [System design](docs/design/design.md) · [Documentation index](docs/README.md)
- [Evaluation guide](evals/README.md) · [License](LICENSE)
