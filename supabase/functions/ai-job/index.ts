// ai-job: POST { action: 'create' | 'step' | 'cancel', ... } -> the content-engine job protocol of ADR 0007
// (AiJobRequest / AiJobResponse / AiJobErrorBody in packages/authoring-core/src/contract.ts). verify_jwt = true.
//
// All logic lives in _shared/ai-job-handler.ts (pure, unit tested). This file only wires the platform:
//   * authoring-core, bundled for Deno by `node scripts/vendor-authoring.mjs` (the step engine and the schemas)
//   * the Anthropic SDK, pinned to the version the engine's adapter was checked against
//   * the caller's Supabase client (RLS applies) and the service-role client (the ai_job_* RPCs only)
//   * EdgeRuntime.waitUntil, so a step keeps running after the 202 has been sent
//
// Secrets (Supabase dashboard, Edge Functions, Secrets, or `supabase secrets set`):
//   ANTHROPIC_API_KEY   the model key. Without it `step` answers 500 "ANTHROPIC_API_KEY is not set for this project".
//   ALLOWED_ORIGINS     comma-separated browser origins of the admin app, for example https://admin.example.com.
//                       http://localhost:<port> and http://127.0.0.1:<port> are always allowed for development.
// Deploy from the repo with the CLI (the bundle is too big for the MCP deploy tool):
//   node scripts/vendor-authoring.mjs && supabase functions deploy ai-job

import Anthropic from 'npm:@anthropic-ai/sdk@0.133.0';
import { serviceClient, userClient } from '../_shared/clients.ts';
import { decodeJwtClaims, handleAiJob } from '../_shared/ai-job-handler.ts';
import type { AiSettings, AuthoringCore, DbClient, JobEngine } from '../_shared/ai-job-types.ts';
import * as authoringCore from '../_shared/vendor/authoring-core.js';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

interface AuthoringCoreModule extends AuthoringCore {
  createJobEngine(): JobEngine;
  createAnthropicLlm(options: {
    client: unknown;
    models: AiSettings['models'];
    timeoutMs?: number;
    maxRetries?: number;
  }): object;
}

const core = authoringCore as unknown as AuthoringCoreModule;
const engine = core.createJobEngine();

const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin !== '');

Deno.serve((req: Request) =>
  handleAiJob(req, {
    core,
    engine,
    hasAnthropicKey: () => Boolean(Deno.env.get('ANTHROPIC_API_KEY')),
    createLlm: (settings) =>
      core.createAnthropicLlm({
        client: new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') }),
        models: settings.models,
        // one call must finish inside the step's lease (150 s); the engine also retries a failed step
        timeoutMs: 120_000,
        maxRetries: 1,
      }),
    userDb: (request) => userClient(request) as unknown as DbClient,
    serviceDb: () => serviceClient() as unknown as DbClient,
    claimsOf: decodeJwtClaims,
    waitUntil: (promise) => EdgeRuntime.waitUntil(promise),
    now: () => new Date(),
    uuid: () => crypto.randomUUID(),
    allowedOrigins,
    log: (event, detail) => console.log(JSON.stringify({ fn: 'ai-job', event, ...detail })),
  }),
);
