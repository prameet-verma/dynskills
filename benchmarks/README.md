# Performance benchmarks

The benchmark suite drives real generation runs against the fixture repositories in [`fixtures/`](../fixtures). Each scenario in [`scenarios.json`](scenarios.json) has a known task and known expected context. Every run is measured end to end on the same monotonic clock the SLA controller uses.

## How to run

```bash
dynskills benchmark                       # all scenarios, Markdown table
dynskills benchmark --host-latency-ms 8000  # simulate 8 s of host LLM time per host turn
dynskills benchmark --json --out bench.json # full BenchmarkReport as JSON
```

From code:

```ts
import { runBenchmarks, formatBenchmarkTable } from "./src/benchmark/index.js"; // dist/benchmark/index.js when built
const report = await runBenchmarks({ hostLatencyMs: 0, scenarioIds: ["go-readiness-handler"] });
console.log(formatBenchmarkTable(report));
```

`runBenchmarks` options:

- `scenariosPath`: defaults to this directory's `scenarios.json`.
- `fixturesRoot`: defaults to `fixtures/`.
- `hostLatencyMs`: defaults to 0.
- `scenarioIds`: run only these scenarios.
- `harness`: defaults to `claude`.

Scenarios run one after another so their timings do not interfere.

## What one scenario does

1. Copies the fixture into a temp directory. It uses a temp home directory and `PATH=""`, so no real harness directories or CLIs are touched.
2. Runs `start` with `forceGenerate`, so the generation path is measured even when an existing skill would be reused.
3. The stand-in host (below) writes the analysis, which is submitted with `analyze`.
4. If clarification is requested, every question is declined. The SLA clock is paused during that wait, as §6.4 requires.
5. Runs `compile --deterministic`. A `revision_required` response is answered with another deterministic compile.
6. Stops at the first terminal or `active` response, reads `status(runId).metrics`, and removes the temp directories.

## What is measured

| §18.7 metric | Report field (per scenario) | Source |
| --- | --- | --- |
| Total active processing time | `activeMs` | `metrics.activeMs` (SLA clock, pause-aware). Falls back to the last response's `budget.consumedMs` if the run never activated. |
| Discovery duration | `discoveryMs` | Preflight excluded, scan plus packet build included. |
| Context packet size | `packetTokens`, `packetFiles` | Estimated tokens of the serialised packet, and files read. |
| LLM interaction count | `hostTurns`, `hostSubmissions`, `bridgeCalls` | See the note below this table. |
| Compilation duration | `compilationMs` | Summed over revision attempts. |
| Evaluation duration | `evaluationMs` | Generation and behavioural evaluations, run in parallel. |
| Activation duration | `activationMs` | Harness `loadSkillForSession`. |
| Timeout rate | `timedOut` per scenario, `summary.timeoutRate` | |
| Token consumption | `packetTokens` (input to the host) and `skillTokens` (activated `SKILL.md` bundle) | Host model tokens are not observable. The stand-in host consumes none. |

The interaction counts mean different things:

- `hostTurns` counts every analyze or compile step the host would perform.
- `hostSubmissions` counts the LLM-written JSON the orchestrator validated. A deterministic compile is not counted.
- `bridgeCalls` counts every CLI command issued.

Each scenario also reports:

- `wallMs`
- `clarificationRounds`
- `targetedDiscoveryRounds`
- `finalStatus` and `finalState`
- `slaViolated`
- **Discovery accuracy**, which is the recall of the scenario's `expected` facts in the Context Packet:
  - Recall is reported per category (languages, frameworks, package managers, instruction files).
  - `null` means the scenario expects nothing in that category.
  - `overall` is micro-averaged across all expected facts.
  - `missed` lists the facts that were not found.
  - Names are compared case- and punctuation-insensitively. Instruction files are compared by path.

The summary gives p50, p95 and max for active time, discovery time, packet tokens and skill tokens. It also gives the activated count, the timeout rate, the mean recall, and `slaViolations`: the ids of scenarios that exceeded 60 000 ms of active time or timed out.

## The stand-in host, and how to read the numbers

A real run has two steps that belong to the host agent's own LLM: analysing the Context Packet and drafting the skill. The benchmark replaces them as follows:

- **Analysis** uses `standInAnalysis(packet)` from `src/benchmark/stand-in-host.ts`. It is a deterministic function that restates the packet:
  - technology and structure
  - instruction lines as conventions
  - observed claims that cite real evidence ids or paths
  - runtime version pins that actually disagree, reported as conflicts

  It always passes `validateContextAnalysisResult`. It never adds unknowns or targeted context requests.
- **Drafting** uses the core's deterministic compiler (`compile --deterministic`).

So, by default, **host LLM time is excluded**, and the measured `activeMs` is the core's own overhead.

- **Simulating the host.** `--host-latency-ms N` sleeps N ms before each host turn (analyze and compile). That time runs on the SLA clock and counts against the 60 s budget, just as real model time does (§15.4: all LLM time consumes the budget). The §15.1 envelope gives the host about 15 s for analysis and 15 s for compilation, so `--host-latency-ms 15000` is a realistic worst case.
- **What it cannot measure.** It cannot measure the quality of real model output, the extra rounds it causes (invalid input, revisions, targeted discovery), or real token consumption by the host model.

## The 60 s SLA is an end-to-end invariant

§18.7: *"The 60-second SLA must be tested as an end-to-end invariant, not inferred by adding component-level averages."*

- `slaViolations` is computed per scenario. It uses that run's own end-to-end active time on the orchestrator's monotonic, pause-aware budget clock, plus its `timedOut` flag. It is never derived by adding up per-stage averages or percentiles.
- The per-stage columns are there for diagnosis only. The stage percentiles in the summary come from different runs, so they do not add up to any real run.
- A suite passes the SLA only when `slaViolations` is empty, for the host latency you care about.
