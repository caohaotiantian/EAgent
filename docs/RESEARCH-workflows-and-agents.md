# Research — Workflows, Agents, and a Minimal Viable Design for a TypeScript Agent Kernel

**Question:** How does the field distinguish *workflows* from *agents*; what makes a
workflow *dynamic*; how are workflows *represented* (data models / graph
abstractions); what *design concerns* govern building such systems; and what is a
*minimal viable design* for a TypeScript agent kernel that absorbs these patterns
as extensions rather than core?

Companion to [`RESEARCH-agent-kernel-design.md`](RESEARCH-agent-kernel-design.md)
(extensible-core architecture + security) and [`REDESIGN-NOTES.md`](REDESIGN-NOTES.md)
(how EAgent's code embodies the conclusions). Synthesized 2026-06-20 from a
multi-source web sweep (four parallel research passes), prioritizing primary
sources.

---

## TL;DR

- **Workflow vs agent is one axis, not two categories:** *predefined code paths*
  at one end, *model-directed control* at the other. Anthropic's framing is now
  canonical and LangChain/OpenAI restate it almost verbatim. Start at the simplest
  point that works; buy autonomy only where its flexibility outweighs its cost in
  latency, dollars, and compounding error.
- **A workflow is "dynamic" when its *structure* is produced at runtime by the
  model** — plan-then-execute, replanning, orchestrator-driven decomposition, or
  code-as-action where generated code *is* the workflow (CodeAct).
- **Three representation families dominate:** shared-state graphs (LangGraph),
  typed event-driven steps (LlamaIndex Workflows), and message-passing handoffs
  (OpenAI Agents SDK). They trade resumability/observability against minimality.
- **For a minimalist kernel, the event/hook + message-passing model wins:** keep a
  tiny loop + tool registry + hook bus + capability gate in the core; push
  reducers, checkpointers, declarative graph specs, planners, and sub-agents into
  **extensions**. This is exactly EAgent's seven-primitive bet, and it lines up
  with every primary source's "start simple, compose up" guidance.

---

## 1. Workflows vs Agents — the taxonomy

**The canonical distinction (Anthropic, *Building Effective Agents*, Dec 2024).**
**Workflows** are "systems where LLMs and tools are orchestrated through
**predefined code paths**." **Agents** are systems where LLMs **dynamically direct
their own processes and tool usage**, keeping control over how they accomplish the
task. The rule of thumb: workflows give predictability and consistency for
well-defined tasks; agents are better when flexibility and model-driven
decision-making are needed at scale. First recommendation: use the simplest thing
that works; add agentic complexity only when it demonstrably pays off.

The shared substrate is the **augmented LLM** — a model enhanced with retrieval,
tools, and memory, able to generate its own queries, pick tools, and decide what
to keep.

**Canonical workflow patterns:**

- **Prompt chaining** — fixed sequence; each call processes the prior output;
  optional programmatic "gates" between steps. Trades latency for accuracy.
- **Routing** — classify input, dispatch to a specialized prompt/path. Best when
  categories are handled better separately.
- **Parallelization** — concurrent calls in two flavors: **sectioning** (split
  into independent subtasks) and **voting** (run the same task N times for
  confidence/diversity).
- **Orchestrator-workers** — a central LLM *dynamically* decomposes a task,
  delegates to workers, synthesizes results. Subtasks are **not pre-defined** →
  the most "agentic" workflow.
- **Evaluator-optimizer** — generator + evaluator loop; effective when criteria
  are clear and iterative refinement adds measurable value.

A true **agent** plans, acts, observes the environment, and loops autonomously —
used when problems/solutions are unpredictable and steps cannot be fixed ahead.

**The spectrum.** Read it as a continuum: *fixed pipelines → routed/branched
workflows → orchestrator-driven (dynamic decomposition) → fully autonomous
agents.* "Agentic workflows" sit in the middle — more adaptive than RPA pipelines,
more bounded than open-ended agents. **LangChain/LangGraph** mirror Anthropic
exactly (same six architectures) and pitch graph-orchestration-with-explicit-state
so you *choose your point* on the spectrum instead of a black-box cognitive
architecture. **OpenAI's Swarm** collapsed workflow and agent into two primitives —
**Agents** (instructions + tools) and **handoffs** — and its production successor
the **Agents SDK** formalizes Agents, Handoffs, Guardrails, Sessions, Tracing, with
a built-in tool-running loop; OpenAI also frames a **deterministic vs LLM-driven**
axis (own the loop via Responses API, or use the managed loop).

**Tradeoffs.** Predefined end: predictable, testable, debuggable, cost/latency
cappable; limited to anticipated paths. Autonomous end: flexible, handles
open-ended tasks, scales decisions — but "trades latency and cost for better task
performance," and adds non-determinism and harder observability.

## 2. Dynamic workflows

**Definition.** A workflow is *dynamic* when which steps run, in what order, with
which tools/sub-agents, is generated or revised **at runtime by the model** rather
than hard-coded. Three shapes: **plan-then-execute** (plan, then run);
**replanning** (re-invoke the planner after each step to check the plan still
holds); **self-modifying graphs** (the execution graph evolves mid-run).

**Key approaches & papers:**

- **ReAct** (arXiv:2210.03629) — interleaved thought→action→observation; the
  foundational "decide the next step at runtime" loop.
- **Plan-and-Solve** (arXiv:2305.04091) — explicit upfront planning stage.
- **Reflexion** — self-reflection on failure; revise approach on retry.
- **Orchestrator emits a plan/DAG** — Anthropic's orchestrator-workers; LangChain
  formalizes **Plan-and-Execute**, **ReWOO** (planner emits interleaved tasks with
  variable substitution like `#E2` to avoid constant replanning), and
  **LLMCompiler** (planner *streams a DAG*, scheduled concurrently).
- **LangGraph dynamic graphs** — `Command` and `Send` enable runtime routing /
  map-reduce fan-out; graph topology becomes data-dependent.
- **CodeAct** (ICML 2024, arXiv:2402.01030) — the action space *is executable
  code*, so the agent gets native loops/conditionals/variables and can revise prior
  actions on new observations. The generated code **is** the dynamic workflow
  (≈20% higher success, ≈30% fewer turns vs JSON/text). This is exactly EAgent's
  `codeact` extension.

**Patterns for dynamism:** runtime task decomposition; conditional branching from
model output; dynamic tool/sub-agent spawning; **human-in-the-loop interrupts**
(LangGraph `interrupt()` pauses, persists, resumes via `Command(resume=...)`,
requiring a checkpointer and *idempotent* pre-interrupt logic because the node
re-runs); feedback/retry loops.

**Risks:** **nondeterminism** (non-reproducible runs, hard failure attribution);
**cost/latency blowup** (an infinite loop can burn thousands of dollars in
minutes); **non-termination** (missing stop criteria → circular exchanges);
**debuggability** (stack traces assume linear execution; breakpoints assume
repeatable state — both break under parallel/opaque orchestration); **compounding
errors** over long horizons (Anthropic: sandbox-test and add guardrails).

## 3. Workflow representation / data models

Three families:

- **Shared-state graphs — LangGraph.** `StateGraph`: **nodes** are functions,
  **edges** say what runs next. State is a typed dict of independent **channels**,
  each with a **reducer** deciding how updates merge (default overwrite; `add_messages`
  appends/merges by ID). **Conditional edges** call a router that reads state and
  returns the next node — the cyclic/agentic mechanism. **`Send`** makes dynamic
  edges for map-reduce; **`Command`** bundles state `update` + `goto` (+ `resume`).
  Not a pure DAG — conditional edges/loops yield **cyclic** execution in
  "super-steps." **Persistence** via **checkpointers** (`InMemorySaver`,
  `SqliteSaver`, `PostgresSaver`) snapshots state every super-step, keyed by
  **`thread_id`**, enabling resume, human-in-the-loop, and time travel.
- **Event-driven typed steps — LlamaIndex Workflows.** *No explicit edges.*
  `@step` methods consume/emit **typed Events** (Pydantic), bookended by
  `StartEvent`/`StopEvent`; the framework **infers and validates the graph from
  event type signatures**. Shared state lives in a separate `Context`. Essentially
  typed pub/sub. Streaming, per-step retry, checkpointing, HITL.
- **Message-passing handoffs — OpenAI Agents SDK (ex-Swarm).** *No graph.*
  Workflows = **agents + handoffs**, where a handoff is exposed to the LLM **as a
  tool** (`transfer_to_X`); the model picks the next agent, which inherits the
  conversation history (optionally trimmed by an `input_filter`). State is
  **messages**, not shared mutable state (Swarm was stateless between calls).

**Adjacent models:** state machines / statecharts (XState — declarative,
deterministic, visualizable; favored when reproducibility beats LLM routing);
behavior trees (robotics/games — modular directed trees); actor models.

**Declarative vs imperative.** *Code-defined graphs*: LangGraph, LlamaIndex,
Agents SDK. *Declarative specs*: **n8n** (JSON `nodes` + `connections`), **Google
ADK** (YAML `SequentialAgent`/`ParallelAgent`/`LoopAgent`, deterministic — no LLM
consulted for routing), Flowise (JSON chatflows). Declarative wins on
portability/inspection; code wins on expressiveness.

**Tradeoffs for a minimalist kernel.** Serializable graph + typed channels +
reducers + checkpointer maximizes resumability/time-travel/observability but
couples you to a state schema and a heavy runtime. Message-passing/handoffs is
minimal and composable (just tools), trivially observable as a transcript, but
state lives only in messages — weaker structured resumability. Event-driven splits
the difference: implicit graph from typed events stays small yet validatable and
streamable. **For a tiny-observable-core thesis, the event/hook model aligns
best** — reducers, checkpointers, and declarative specs belong in opt-in
extensions, not core primitives.

## 4. Cross-cutting design concerns

1. **Reliability & control.** Termination must be **runtime-enforced**, not left to
   the model: a hard `max_iterations` cap (LangChain default 15) plus loop-drift /
   repetition detection. Distinguish **transient** errors (timeout/5xx/429 →
   2–3 retries, exponential backoff + jitter) from **non-retryable** (auth /
   validation / policy → budget 0). **Idempotency keys** prevent duplicate side
   effects on retry/resume.
2. **Observability & debuggability.** The field is converging on **OpenTelemetry
   GenAI semantic conventions**: a top-level `invoke_agent` span with child `chat`
   and `execute_tool` spans; attributes `gen_ai.request.model`,
   `gen_ai.usage.input_tokens/output_tokens`, `gen_ai.response.finish_reasons`,
   and message-content attributes (with PII guidance). Adopted by Datadog,
   Honeycomb, New Relic, LangChain, CrewAI, AutoGen.
3. **State & durability.** Two complementary models: **Temporal durable execution**
   (immutable event history; replay skips completed activities and resumes at the
   exact failure point) and **LangGraph persistence** (`StateSnapshot` per
   super-step + `interrupt()` for HITL). Gotcha: LangGraph **re-executes the whole
   node on resume**, so pre-interrupt writes must be idempotent. 2026 pattern:
   wrap LangGraph reasoning inside a Temporal activity for both planning and
   durability.
4. **Cost & latency.** **Prompt caching** (Anthropic `cache_control`) is the
   highest-ROI lever. **Compaction** matters because tool observations grow to
   70–80% of the window in ReAct loops (Claude Code auto-compacts near ~80% /
   ~160K tokens). **Task/token budgets** let the model wind down; sub-agent fan-out
   and tool parallelism cut wall-clock time.
5. **Security.** **Prompt injection is OWASP LLM01:2025** and increasingly treated
   as a permanent architectural flaw. Willison's **lethal trifecta** — private data
   + untrusted content + external communication — names the exfiltration surface;
   mitigation is **architectural, not filter-based** (95%-effective guardrails =
   failure). Meta's **Agents Rule of Two**: at most two of the three without a human
   in the loop. **MCP tool poisoning** (Invariant Labs) hides instructions in tool
   descriptions/defaults/enum names; defenses are **least-privilege capability
   gating**, human approval for consequential actions, and **pinning
   tool-description hashes** to detect rug-pulls. (EAgent ships `flow-guard` and
   `integrity` for exactly these — see the companion docs.)
6. **Evaluation & testing.** Layered harness: deterministic, no-LLM checks
   (assertions / regex / keyword slices) in the fast loop; **LLM-as-judge** /
   semantic similarity / trajectory analysis as a slower, costlier (and itself
   non-deterministic) supplement; **mock the LLM** for regression-locked tests.
   (This is precisely EAgent's `MockProvider` offline suite.)
7. **Context engineering.** Keep context "informative yet tight": **structured
   note-taking** (external files as memory beyond the window), **just-in-time
   retrieval** (carry lightweight identifiers, load at runtime), and **sub-agent
   context isolation** (specialists work in clean windows, return condensed
   1–2K-token summaries).

## 5. A minimal viable design for a TypeScript agent kernel

The convergent lesson across every primary source is **mechanism, not policy:**
keep a small, observable loop; make everything else pluggable. A minimal viable
TypeScript kernel needs roughly **seven primitives** — which is exactly the shape
EAgent already ships (`src/kernel/`):

| Primitive | Why it must be core | What it expresses from §1–4 |
| --- | --- | --- |
| **Agent loop** | The only thing that *must* be a loop. Streaming turns + ordered/guarded tool dispatch + steering/follow-up. | ReAct's thought→action→observation; the workflow↔agent axis is just "who decides the next step." |
| **Tool registry** | Tools are the universal action surface; register / shadow / dispose (later wins, dispose restores). | Augmented-LLM tools; handoffs-as-tools; routing targets. |
| **Provider interface** | The LLM abstraction: request → stream of events. Implementations (anthropic/openai/gemini/**mock**) live outside the kernel. | Lets evaluation mock the model (concern §6) and keeps the core offline-testable. |
| **Hook bus** | Lifecycle **observe** events + **filter** (intervene) hooks. | The substrate for tracing (§2 OTel spans), loop-guards/termination (§4.1), and compositional security (§4.5) — all as extensions. |
| **Capability layer** | Per-capability grant/deny/ask + audit log. | Least-privilege gating, the answer to the lethal trifecta and tool poisoning (§4.5). |
| **Extension host** | Discovery, activation, a curated `ExtensionAPI`, hot reload. | The Emacs-grade surface: planners, checkpointers, reducers, declarative graph specs, sub-agents all live here, never in core. |
| **Command registry** | User-facing slash commands. | Operator entry points; keeps UX out of the loop. |

**What stays out of the core (and why):**

- **Workflow graphs / reducers / checkpointers** → an **extension**, not a
  primitive. The event-driven/message-passing model is the minimal default
  (transcript = state); durable graphs are opt-in for users who need
  resumability/time-travel (§3 tradeoffs). This keeps the kernel serializable and
  observable without a heavy state schema.
- **Planners (plan-execute / ReWOO / orchestrator-workers)** → extensions that ride
  the loop + tool registry; "dynamic workflow" is *emitted by the model*, so the
  kernel needs no graph type (§2).
- **CodeAct** → an extension where generated code *is* the dynamic workflow
  (§2) — sandboxed behind a capability (the trusted-in-process / untrusted-out-of-
  process boundary).
- **Sub-agents / memory / context compaction** → extensions implementing §4.7
  context isolation and §4.4 cost control.
- **Security policies** → extensions on the hook bus: per-tool gating is necessary
  but not sufficient (capability *chaining*), so compositional egress gating
  (`flow-guard`) and tool-description integrity (`integrity`) ride
  `beforeToolCall` (intervene) + `tool_end`/audit (observe).

**Non-negotiable defaults the core must enforce:** a hard iteration cap +
loop-drift guard (§4.1); structured lifecycle events shaped for OTel GenAI spans
(§4.2); idempotency-friendly tool dispatch so resume/retry extensions stay correct
(§4.3); and a deterministic mock provider so the whole suite runs offline (§6).

**Net:** the minimal viable TypeScript kernel is a tiny model-driven loop over a
tool registry, wrapped in a hook bus and a capability gate, made malleable by an
extension host — and *nothing else*. Every workflow pattern (chaining, routing,
parallelization, orchestrator-workers, evaluator-optimizer), every dynamic-workflow
strategy (plan/replan/CodeAct), every representation (graph/event/handoff), and
every design concern (durability, observability, security, eval) is reachable as an
extension over those seven primitives. The research validates the bet: start
simple, compose up, never fork the core.

---

## Sources (primary, verified)

**Taxonomy**
- Anthropic — Building Effective AI Agents — https://www.anthropic.com/engineering/building-effective-agents
- LangChain / LangGraph — Workflows and agents — https://docs.langchain.com/oss/python/langgraph/workflows-agents
- OpenAI Agents SDK (Python) — https://openai.github.io/openai-agents-python/
- OpenAI Swarm — https://github.com/openai/swarm

**Dynamic workflows**
- ReAct (arXiv:2210.03629) — https://arxiv.org/pdf/2210.03629
- CodeAct (arXiv:2402.01030) — https://arxiv.org/abs/2402.01030
- Plan-and-Solve (arXiv:2305.04091) — https://arxiv.org/abs/2305.04091
- LangChain — Planning agents (Plan-Execute / ReWOO / LLMCompiler) — https://www.langchain.com/blog/planning-agents
- LangChain — Human-in-the-loop with interrupt — https://blog.langchain.com/making-it-easier-to-build-human-in-the-loop-agents-with-interrupt/
- Survey: Static Templates to Dynamic Runtime Graphs (arXiv:2603.22386) — https://arxiv.org/pdf/2603.22386

**Representation / data models**
- LangGraph Graph API — https://docs.langchain.com/oss/python/langgraph/graph-api
- LangGraph Persistence — https://docs.langchain.com/oss/python/langgraph/persistence
- LlamaIndex Workflows — https://developers.llamaindex.ai/python/framework/module_guides/workflow/
- OpenAI Agents SDK — Handoffs — https://openai.github.io/openai-agents-python/handoffs/
- Google ADK — Workflow Agents — https://google.github.io/adk-docs/agents/workflow-agents/
- XState — https://github.com/statelyai/xstate
- n8n — Connections — https://docs.n8n.io/workflows/components/connections/

**Design concerns**
- Simon Willison — The lethal trifecta — https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- Anthropic — Effective context engineering — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- OpenTelemetry — GenAI agent spans semantic conventions — https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
- OWASP — LLM01:2025 Prompt Injection — https://genai.owasp.org/llmrisk/llm01-prompt-injection/
- Invariant Labs — MCP Tool Poisoning Attacks — https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks
- Temporal — Dynamic AI agents with Temporal — https://temporal.io/blog/of-course-you-can-build-dynamic-ai-agents-with-temporal

---
*Synthesized 2026-06-20 from four parallel multi-source web sweeps with
source-prioritized verification. A handful of arXiv IDs carry 2026 date stamps;
load-bearing claims rest on the established primary papers (ReAct, CodeAct,
Plan-and-Solve) and the Anthropic / LangChain / OpenAI / OTel / OWASP engineering
sources fetched directly. Figures from preprints are flagged inline.*
