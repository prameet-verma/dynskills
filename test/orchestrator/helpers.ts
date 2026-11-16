import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ContextAnalysisResult, ContextPacket, SkillDraft } from "../../src/contracts/index.js";

/** A small, realistic TypeScript service repository. */
export async function makeRepo(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ds-e2e-repo-"));
  const home = await mkdtemp(path.join(tmpdir(), "ds-e2e-home-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify(
      {
        name: "billing-service",
        version: "1.0.0",
        type: "module",
        packageManager: "pnpm@9.12.0",
        engines: { node: ">=20" },
        scripts: { test: "vitest run", build: "tsc -p ." },
        dependencies: { express: "4.19.2", stripe: "16.2.0", zod: "3.23.8" },
        devDependencies: { typescript: "5.5.4", vitest: "2.0.5" },
      },
      null,
      2,
    ),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "nodenext", target: "es2022" } }, null, 2),
    "CLAUDE.md": "# Billing service\n\nAll payment provider calls go through src/payments/gateway.ts.\nErrors are mapped to PaymentError in src/payments/errors.ts.\n",
    "src/server.ts": "import express from 'express';\nimport { router } from './payments/routes.js';\nconst app = express();\napp.use('/payments', router);\napp.listen(3000);\n",
    "src/payments/gateway.ts": "import Stripe from 'stripe';\nimport { PaymentError } from './errors.js';\nexport class PaymentGateway {\n  constructor(private readonly stripe: Stripe) {}\n  async charge(amount: number, currency: string) {\n    try {\n      return await this.stripe.paymentIntents.create({ amount, currency });\n    } catch (err) {\n      throw PaymentError.from(err);\n    }\n  }\n}\n",
    "src/payments/errors.ts": "export class PaymentError extends Error {\n  static from(err: unknown) { return new PaymentError(String(err)); }\n}\n",
    "src/payments/routes.ts": "import { Router } from 'express';\nimport { z } from 'zod';\nexport const router = Router();\nconst Charge = z.object({ amount: z.number().int().positive(), currency: z.string().length(3) });\nrouter.post('/charge', (req, res) => { const body = Charge.parse(req.body); res.json(body); });\n",
    "src/payments/gateway.test.ts": "import { describe, it, expect } from 'vitest';\ndescribe('gateway', () => { it('works', () => expect(1).toBe(1)); });\n",
    ".env": `STRIPE_SECRET_KEY=${["sk", "test", "51ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"].join("_")}\n`,
  };
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content);
  }
  return { root, home };
}

export async function readPacket(packetPath: string): Promise<ContextPacket> {
  return JSON.parse(await readFile(packetPath, "utf8")) as ContextPacket;
}

/** Pick an evidence id whose claim/source matches `re`, else the first evidence id. */
export function evidenceFor(packet: ContextPacket, re: RegExp): string {
  const hit = packet.evidence.find((e) => re.test(e.claim) || re.test(e.source));
  const id = (hit ?? packet.evidence[0])?.id;
  if (!id) throw new Error("packet has no evidence");
  return id;
}

/** A valid ContextAnalysisResult citing real packet evidence, as a host agent would write it. */
export function analysisFor(packet: ContextPacket, overrides: Partial<ContextAnalysisResult> = {}): ContextAnalysisResult {
  const ts = evidenceFor(packet, /typescript/i);
  const stripe = evidenceFor(packet, /stripe/i);
  return {
    schemaVersion: "1.0",
    runId: packet.runId,
    technology: { languages: ["TypeScript"], frameworks: ["express", "stripe"], runtimes: ["node"], packageManagers: ["pnpm"] },
    architecture: {
      patterns: ["Gateway class wraps the payment provider"],
      moduleStructure: ["src/payments"],
      conventions: ["Payment provider errors are mapped to PaymentError"],
      dependencies: ["stripe", "zod"],
    },
    taskContext: {
      relevantComponents: ["src/payments/gateway.ts"],
      existingImplementations: ["PaymentGateway.charge"],
      constraints: ["All payment provider calls go through the PaymentGateway in src/payments/gateway.ts"],
    },
    evidence: [
      { claim: "The service is written in TypeScript", source: ts, type: "observed" },
      { claim: "Stripe is the payment provider", source: stripe, type: "observed" },
      { claim: "All payment provider calls go through the PaymentGateway in src/payments/gateway.ts", source: "CLAUDE.md", type: "observed" },
      { claim: "Payment provider errors are mapped to PaymentError", source: "CLAUDE.md", type: "observed" },
    ],
    unknowns: [],
    conflicts: [],
    ...overrides,
  };
}

/** A valid SkillDraft citing packet evidence, as a host LLM would write it. */
export function draftFor(packet: ContextPacket, overrides: Partial<SkillDraft> = {}): SkillDraft {
  const stripe = evidenceFor(packet, /stripe/i);
  return {
    schemaVersion: "1.0",
    runId: packet.runId,
    name: "stripe-refund-integration",
    description: "Add Stripe refund support to the billing service using its PaymentGateway and PaymentError conventions. Use when implementing or reviewing refund flows.",
    specialist: {
      identity: "Payments integration engineer for this Express + Stripe billing service",
      responsibility: "Implement refund flows that follow the gateway and error-mapping conventions",
    },
    authority: {
      ownership: ["Refund logic in src/payments/"],
      decisionRights: ["Choose refund request validation rules with zod"],
      boundaries: ["Do not call the Stripe SDK outside src/payments/gateway.ts", "Never read or print the .env file"],
      accountability: ["Refund behaviour is covered by vitest tests"],
    },
    workflow: [
      "Add a refund method to PaymentGateway that wraps stripe.refunds.create",
      "Map provider errors with PaymentError.from",
      "Expose POST /payments/refund with a zod-validated body",
      "Add vitest tests for success and provider failure",
    ],
    projectConstraints: [
      { statement: "All payment provider calls go through PaymentGateway in src/payments/gateway.ts", evidence: ["CLAUDE.md", "src/payments/gateway.ts"] },
      { statement: "Stripe is the payment provider", evidence: [stripe] },
    ],
    verification: ["Run pnpm test and confirm refund tests pass", "Confirm no Stripe import exists outside src/payments/gateway.ts"],
    ...overrides,
  };
}

export const TASK = "Add Stripe refund support to the billing service payment gateway";
