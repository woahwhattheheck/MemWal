/**
 * Walrus Memory AI SDK Integration — withMemWal Middleware
 *
 * Wraps any AI SDK model with automatic memory management.
 *
 * @example
 * ```typescript
 * import { generateText } from "ai"
 * import { withMemWal } from "@mysten-incubation/memwal/ai"
 * import { openai } from "@ai-sdk/openai"
 *
 * const model = withMemWal(openai("gpt-4o"), {
 *   key: process.env.MEMWAL_PRIVATE_KEY,  // Ed25519 delegate private key (hex)
 * })
 *
 * const result = await generateText({
 *   model,
 *   messages: [{ role: "user", content: "What do you know about me?" }]
 * })
 * // → Automatically searches memories, injects context, saves new facts
 * ```
 */

import type { LanguageModelV2 } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { MemWal } from "../memwal.js";
import { BackgroundSaves } from "./background-saves.js";
import type { MemWalConfig, RecallMemory } from "../types.js";
import {
    formatUntrustedMemories,
    UNTRUSTED_MEMORY_SYSTEM_INSTRUCTION,
} from "./untrusted-memory.js";

// ============================================================
// Config
// ============================================================

/**
 * Accept both LanguageModelV2 (ai SDK v4/v5) and LanguageModelV3 (ai SDK v6+).
 * We use `any` because LanguageModelV3 may not exist in older @ai-sdk/provider,
 * and the two interfaces are structurally incompatible at the type level.
 * `wrapLanguageModel` from `ai` handles version detection internally.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLanguageModel = any;

export interface WithMemWalOptions extends MemWalConfig {
    /** Max memories to inject per request (default: 5) */
    maxMemories?: number;
    /** Auto-save new facts from conversation (default: true) */
    autoSave?: boolean;
    /** Minimum similarity score to include a memory (0-1, default: 0.3) */
    minRelevance?: number;
    /** Enable debug logging (default: false) */
    debug?: boolean;
    /** Observe recall/auto-save errors without blocking generation. Error objects
     * may contain private application data; redact them before external logging.
     * Without a callback, a content-free warning is emitted even without debug.
     */
    onMemoryError?: (event: {
        operation: "recall" | "autoSave";
        error: unknown;
    }) => void | Promise<void>;
}

// ============================================================
// Middleware
// ============================================================

/**
 * Wrap an AI SDK model with Walrus Memory management
 *
 * BEFORE each LLM call:
 * - Uses the last user message as a search query
 * - Recalls relevant memories (server: search → download → decrypt)
 * - Injects relevant memories as nonce-delimited, untrusted user data
 *
 * AFTER a call whose prompt ends with a new user message:
 * - Analyzes and saves important facts (server: LLM extract → embed → encrypt → Walrus → store)
 * - Fire-and-forget — does not block the response
 */
export function withMemWal(
    model: AnyLanguageModel,
    options: WithMemWalOptions
) {
    const memwal = MemWal.create(options);
    const maxMemories = options.maxMemories ?? 5;
    const autoSave = options.autoSave ?? true;
    const minRelevance = options.minRelevance ?? 0.3;
    const debug = options.debug ?? false;

    const log = debug
        ? (...args: unknown[]) => console.warn("[Walrus Memory]", ...args)
        : () => { };

    function reportMemoryError(operation: "recall" | "autoSave", error: unknown): void {
        // Do not emit memory text, credentials, or raw relayer errors by default.
        const warn = () => console.warn(
            `[Walrus Memory] ${operation} failed; configure onMemoryError for details.`,
        );
        if (!options.onMemoryError) {
            warn();
            return;
        }
        try {
            // Telemetry callbacks are observational, including async callbacks.
            // Their failure must not break inference or create an unhandled rejection.
            void Promise.resolve(options.onMemoryError({ operation, error })).catch(warn);
        } catch {
            warn();
        }
    }

    const saves = new BackgroundSaves(error => reportMemoryError("autoSave", error));

    function saveInBackground(userMessage: string): void {
        saves.add(() => memwal.analyze(userMessage));
    }

    const wrapped = (wrapLanguageModel as any)({
        model,
        middleware: {
            specificationVersion: 'v3', // Required by ai SDK v6+; ignored by v4/v5
            // ============================================================
            // BEFORE: Search memories + inject into prompt
            // ============================================================
            transformParams: async ({ params }: any) => {
                try {
                    const lastUserMessage = findLastUserMessage(params.prompt);
                    if (!lastUserMessage) return params;

                    const recallResult = await memwal.recall(lastUserMessage, maxMemories);

                    // Filter by minimum relevance (distance < 1 - minRelevance)
                    const relevant = recallResult.results.filter(
                        (m: RecallMemory) => (1 - m.distance) >= minRelevance
                    );

                    if (relevant.length === 0) return params;

                    const memoryContext = formatUntrustedMemories(relevant);
                    const enrichedPrompt = injectMemoryContext(
                        params.prompt,
                        memoryContext
                    );

                    log(`🔍 Found ${relevant.length} relevant memories`);

                    return { ...params, prompt: enrichedPrompt };
                } catch (error) {
                    reportMemoryError("recall", error);
                    return params;
                }
            },

            // ============================================================
            // AFTER: Analyze and save important facts (fire-and-forget)
            // ============================================================
            wrapGenerate: async ({ doGenerate, params }: any) => {
                const result = await doGenerate();

                if (autoSave && isNewUserTurn(params.prompt)) {
                    const userMessage = findLastUserMessage(params.prompt);
                    if (userMessage) {
                        saveInBackground(userMessage);
                    }
                }

                return result;
            },

            // Stream variant — needed for streamText()
            wrapStream: async ({ doStream, params }: any) => {
                const result = await doStream();

                if (autoSave && isNewUserTurn(params.prompt)) {
                    const userMessage = findLastUserMessage(params.prompt);
                    if (userMessage) {
                        saveInBackground(userMessage);
                    }
                }

                return result;
            },
        },
    });

    wrapped.specificationVersion = model.specificationVersion;

    // Call after generation/stream startup. Flush waits for pending analyze
    // acceptance and rejects once for failures observed since the previous flush.
    // Acceptance is not proof that the downstream Walrus jobs finished storing.
    wrapped.flush = (): Promise<void> => saves.flush();

    return wrapped;
}

// ============================================================
// Helpers
// ============================================================

// AI SDK tool continuations end in assistant/tool messages. Only a prompt
// ending in user input starts an auto-save; do not dedupe globally by text,
// because equal text in a later independent user turn is still a new turn.
function isNewUserTurn(prompt: unknown): boolean {
    return Array.isArray(prompt) && prompt.at(-1)?.role === "user";
}

function findLastUserMessage(
    prompt: unknown
): string | null {
    if (!Array.isArray(prompt)) return null;

    for (let i = prompt.length - 1; i >= 0; i--) {
        const msg = prompt[i] as { role?: string; content?: unknown };
        if (msg.role === "user") {
            if (typeof msg.content === "string") return msg.content;
            if (Array.isArray(msg.content)) {
                const textParts = msg.content
                    .filter((p: any) => p.type === "text")
                    .map((p: any) => p.text);
                return textParts.join(" ") || null;
            }
        }
    }
    return null;
}

export function injectMemoryContext(
    prompt: unknown,
    memoryContext: string
): unknown {
    if (!Array.isArray(prompt)) return prompt;

    // Keep the fixed trust policy in a system message, but recalled bytes only
    // in a separate user message. No memory-controlled text receives system
    // priority.
    const lastUserIndex = prompt.reduce(
        (idx: number, m: any, i: number) => (m.role === "user" ? i : idx),
        -1
    );

    const memoryMessage = {
        role: "user" as const,
        content: [{ type: "text" as const, text: memoryContext }],
    };

    const result = [...prompt];
    if (lastUserIndex > 0) {
        result.splice(lastUserIndex, 0, memoryMessage);
    } else {
        result.unshift(memoryMessage);
    }

    const leading = result[0] as { role?: string; content?: unknown };
    if (leading.role === "system") {
        result[0] = {
            ...leading,
            content: `${leading.content}\n\n${UNTRUSTED_MEMORY_SYSTEM_INSTRUCTION}`,
        };
    } else {
        result.unshift({
            role: "system" as const,
            content: UNTRUSTED_MEMORY_SYSTEM_INSTRUCTION,
        });
    }

    return result;
}
