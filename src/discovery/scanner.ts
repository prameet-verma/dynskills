import path from "node:path";
import type {
  DiscoveryContext,
  DiscoveryEvidence,
  DiscoveryLimits,
  DiscoveryPriority,
  DiscoveryProvider,
  DiscoveryReport,
  ProviderRunResult,
  TaskIntent,
} from "../contracts/index.js";
import { errorMessage, mapWithConcurrency, stopwatch, TimeoutError, withTimeout } from "../core/index.js";
import { buildFileIndex } from "./file-index.js";
import { BuildConfigProvider } from "./providers/build-config.js";
import { CicdProvider } from "./providers/cicd.js";
import { DocumentationProvider } from "./providers/documentation.js";
import { ExistingSkillsProvider } from "./providers/existing-skills.js";
import { FileSystemProvider } from "./providers/filesystem.js";
import { FrameworkProvider } from "./providers/framework.js";
import { InstructionsProvider } from "./providers/instructions.js";
import { ManifestProvider } from "./providers/manifest.js";
import { MonorepoProvider } from "./providers/monorepo.js";
import { PackageManagerProvider } from "./providers/package-manager.js";
import { RuntimeProvider } from "./providers/runtime.js";
import { SourceFilesProvider } from "./providers/source-files.js";
import { TestConfigProvider } from "./providers/test-config.js";
import { compareEvidence, PRIORITY_RANK } from "./util.js";

/** One provider per §5.1 scanner, plus the P1 task-relevant source-file scanner. */
export function createDefaultProviders(): DiscoveryProvider[] {
  return [
    new FileSystemProvider(),
    new ManifestProvider(),
    new RuntimeProvider(),
    new FrameworkProvider(),
    new PackageManagerProvider(),
    new MonorepoProvider(),
    new TestConfigProvider(),
    new BuildConfigProvider(),
    new InstructionsProvider(),
    new ExistingSkillsProvider(),
    new CicdProvider(),
    new DocumentationProvider(),
    new SourceFilesProvider(),
  ];
}

export interface ScanInput {
  root: string;
  task: TaskIntent;
  limits: DiscoveryLimits;
  /** Highest priority tier to run (default "P1"). */
  maxPriority?: DiscoveryPriority;
  signal?: AbortSignal;
}

/**
 * §5.1 / §15.2 RepositoryScanner: builds the file index once, then runs supported providers
 * concurrently with bounded concurrency, per-provider timeouts, AbortSignal propagation and
 * error isolation. Evidence is de-duplicated by id and deterministically ordered.
 */
export class RepositoryScanner {
  private readonly providers: DiscoveryProvider[];

  constructor(providers?: DiscoveryProvider[]) {
    this.providers = providers ?? createDefaultProviders();
  }

  async scan(input: ScanInput): Promise<DiscoveryReport> {
    const elapsed = stopwatch();
    const root = path.resolve(input.root);
    const maxPriority = input.maxPriority ?? "P1";
    const fileIndex = await buildFileIndex(root);
    const context: DiscoveryContext = { root, task: input.task, limits: input.limits, maxPriority, fileIndex };

    const results = await mapWithConcurrency(this.providers, Math.max(1, input.limits.concurrency), async (provider) => {
      const sw = stopwatch();
      const result = (status: ProviderRunResult["status"], evidence: DiscoveryEvidence[], error?: string) => ({
        run: {
          providerId: provider.id,
          status,
          durationMs: sw(),
          evidenceCount: evidence.length,
          ...(error !== undefined ? { error } : {}),
        } satisfies ProviderRunResult,
        evidence,
      });
      // P0 always runs; higher tiers only up to maxPriority.
      if (PRIORITY_RANK[provider.priority] > PRIORITY_RANK[maxPriority]) return result("skipped", [], `priority ${provider.priority} above ${maxPriority}`);
      if (input.signal?.aborted) return result("error", [], `aborted: ${errorMessage(input.signal.reason ?? "aborted")}`);
      try {
        if (!provider.supports(context)) return result("skipped", []);
        const evidence = await withTimeout((signal) => provider.discover(context, signal), input.limits.providerTimeoutMs, input.signal);
        return result("ok", Array.isArray(evidence) ? evidence.filter(isEvidence) : []);
      } catch (err) {
        if (err instanceof TimeoutError) return result("timeout", [], err.message);
        return result("error", [], errorMessage(err));
      }
    });

    const byId = new Map<string, DiscoveryEvidence>();
    for (const r of results) for (const e of r.evidence) if (!byId.has(e.id)) byId.set(e.id, e);
    return {
      evidence: [...byId.values()].sort(compareEvidence),
      providers: results.map((r) => r.run),
      fileIndexSize: fileIndex.length,
      durationMs: elapsed(),
    };
  }
}

function isEvidence(e: unknown): e is DiscoveryEvidence {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as DiscoveryEvidence).id === "string" &&
    typeof (e as DiscoveryEvidence).kind === "string" &&
    typeof (e as DiscoveryEvidence).source === "string" &&
    typeof (e as DiscoveryEvidence).claim === "string"
  );
}
