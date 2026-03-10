/**
 * LLM adapter interface for vidzy.
 *
 * The pipeline needs LLM calls in two places:
 * - Scene analysis (multimodal vision)
 * - Editorial planning (text reasoning)
 *
 * Consumers provide an implementation via VidzyConfig.
 * If no LLM is configured, those phases are skipped
 * and heuristic-only logic is used instead.
 */

/** A single message part (text or image). */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** A chat message for the LLM. */
export interface LlmMessage {
  role: "user" | "assistant" | "system";
  content: string | ContentPart[];
}

/** Result from an LLM call. */
export interface LlmResult {
  result: string;
  costUsd: number;
}

/**
 * LLM adapter function signature.
 *
 * Implementations can wrap OpenRouter, Anthropic, OpenAI, Ollama, etc.
 * The pipeline passes messages and options, expects text back.
 */
export type LlmAdapter = (
  messages: LlmMessage[],
  options: {
    /** Model identifier (e.g. "anthropic/claude-3.5-sonnet"). */
    model?: string;
    /** Max output tokens. */
    maxTokens?: number;
    /** Sampling temperature. */
    temperature?: number;
  },
) => Promise<LlmResult>;

/** No-op adapter that returns empty results. */
export const nullAdapter: LlmAdapter = async () => ({
  result: "",
  costUsd: 0,
});
