// tutor-chat: POST { action: 'turn' | 'fetch_turn', ... } -> the AI tutor of ADR 0008 (TutorRequest / TutorStreamEvent /
// TutorErrorBody in packages/tutor-core/src/contract.ts). A turn answers with Server-Sent Events. verify_jwt = true.
//
// All logic lives in _shared/tutor-chat-handler.ts (pure, unit tested). This file only wires the platform:
//   * tutor-core, bundled for Deno by `node scripts/vendor-tutor.mjs` (the contract, redaction, the safety layer, the
//     grounding and the turn pipeline, the streaming Anthropic adapter)
//   * authoring-core (the structured model client the classifier and the output check use, and the cast schema) and
//     content-schema (parsing the published unit), both already vendored for the other functions
//   * the Anthropic SDK, pinned to the version the adapters were checked against
//   * the caller's Supabase client (RLS applies to every read) and the service-role client (the tutor_* RPCs only,
//     after the caller has been authorised)
//   * EdgeRuntime.waitUntil, so a turn keeps running and is stored after the response was started (or abandoned)
//
// Secrets (Supabase dashboard, Edge Functions, Secrets, or `supabase secrets set`):
//   ANTHROPIC_API_KEY   the model key. Without it a turn answers 500 before any state changes.
//   ALLOWED_ORIGINS     comma-separated browser origins that may call the function (the web build of the app).
//                       http://localhost:<port> and http://127.0.0.1:<port> are always allowed for development. Native
//                       apps send no Origin header and need nothing here.
// Deploy from the repo with the CLI (the bundles are about 3 MB together, too big for the MCP deploy tool):
//   node scripts/vendor-tutor.mjs && supabase functions deploy tutor-chat
// The tutor stays switched off (tutor.enabled = false) until a super_admin names and confirms the safeguarding owner and
// calls set_tutor_enabled(true); every turn also needs the household's consent for the child.

import Anthropic from 'npm:@anthropic-ai/sdk@0.133.0';
import { serviceClient, userClient } from '../_shared/clients.ts';
import { parseUnit } from '../_shared/schema.ts';
import { decodeJwtClaims, handleTutorChat } from '../_shared/tutor-chat-handler.ts';
import type {
  DbClient,
  Parser,
  TutorChatDeps,
  TutorCore,
  TutorTurnInput,
  TutorTurnRun,
} from '../_shared/tutor-chat-types.ts';
import * as authoringModule from '../_shared/vendor/authoring-core.js';
import * as tutorModule from '../_shared/vendor/tutor-core.js';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

/** What this file takes from the vendored tutor-core bundle (plain JS without types). */
interface TutorCoreModule extends TutorCore {
  runTutorTurn(deps: object, input: TutorTurnInput): TutorTurnRun;
  createAnthropicTutorLlm(options: {
    client: unknown;
    models: { authoring: string; tutor: string; moderation: string };
    timeoutMs?: number;
    maxRetries?: number;
  }): object;
  buildGrounding(
    unit: unknown,
    options: { versionNo: number; unitId: string; subjectName?: string },
  ): unknown;
  buildMasteryGuard(unit: unknown): string[][];
}

/** What this file takes from the vendored authoring-core bundle. */
interface AuthoringModule {
  CastTraits: Parser<Record<string, unknown>>;
  createAnthropicLlm(options: {
    client: unknown;
    models: { authoring: string; tutor: string; moderation: string };
    timeoutMs?: number;
    maxRetries?: number;
  }): object;
}

const tutor = tutorModule as unknown as TutorCoreModule;
const authoring = authoringModule as unknown as AuthoringModule;

const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin !== '');

// One model client for the life of the isolate (created on the first turn, when the key is known to be set).
let anthropic: Anthropic | undefined;

const deps: TutorChatDeps = {
  core: tutor,
  prepareUnit: ({ content, unitId, versionNo, subjectName }) => {
    // parseUnit throws on content that does not fit the schema; the handler turns that into a calm 500
    const unit = parseUnit(content);
    return {
      grounding: tutor.buildGrounding(unit, {
        versionNo,
        unitId,
        ...(subjectName !== undefined ? { subjectName } : {}),
      }),
      masteryGuard: tutor.buildMasteryGuard(unit),
    };
  },
  castTraits: authoring.CastTraits,
  runTurn: (input, context) => {
    anthropic ??= new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });
    // one call must finish well inside the turn's budget; each adapter retries a failed call once
    const options = { client: anthropic, models: context.models, timeoutMs: 120_000, maxRetries: 1 };
    return tutor.runTutorTurn(
      {
        llm: authoring.createAnthropicLlm(options),
        tutorLlm: tutor.createAnthropicTutorLlm(options),
        settings: context.settings,
        now: () => new Date(),
        signal: context.signal,
      },
      input,
    );
  },
  hasAnthropicKey: () => Boolean(Deno.env.get('ANTHROPIC_API_KEY')),
  userDb: (request) => userClient(request) as unknown as DbClient,
  serviceDb: () => serviceClient() as unknown as DbClient,
  claimsOf: decodeJwtClaims,
  waitUntil: (promise) => EdgeRuntime.waitUntil(promise),
  now: () => new Date(),
  uuid: () => crypto.randomUUID(),
  allowedOrigins,
  log: (event, detail) => console.log(JSON.stringify({ fn: 'tutor-chat', event, ...detail })),
};

Deno.serve((req: Request) => handleTutorChat(req, deps));
