import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import {
  antigravityHeaders,
  endpointCandidates,
  jsonOrTextError,
  parseApiKey,
} from "../client/client.js";
import { AntigravityRequestType, AntigravityUserAgent } from "../types/enums.js";
import { antigravityFetch } from "../utils/http.js";
import { safeError } from "../utils/security.js";
import { antigravityRequestEnvelope } from "../utils/util.js";
import {
  deriveSources,
  extractGoogleSearchDetails,
  resolveGoogleGroundingRedirectUrls,
  sanitizeSearchResults,
} from "./grounding.js";
import type {
  GroundingMetadata,
  SearchContent,
  SearchStreamResult,
  SearchToolDeclaration,
  UrlContextMetadata,
} from "./types.js";

export const DEFAULT_SEARCH_MODEL = "gemini-3.7-flash-tiered";

export function resolveSearchModel(customModel?: string): string {
  const envModel = process.env.ANTIGRAVITY_SEARCH_MODEL?.trim();
  const raw = customModel?.trim() || envModel || DEFAULT_SEARCH_MODEL;
  if (raw === "gemini-3.7-flash") return "gemini-3.7-flash-tiered";
  return raw;
}

const SEARCH_MODEL_FALLBACKS = [
  "gemini-3.7-flash-tiered",
  "gemini-3.7-flash-low",
  "gemini-3.6-flash-low",
];

interface StreamCandidateChunk {
  error?: { message?: string; code?: number; status?: string };
  response?: {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: GroundingMetadata;
      urlContextMetadata?: UrlContextMetadata;
      url_context_metadata?: UrlContextMetadata;
    }>;
  };
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: GroundingMetadata;
    urlContextMetadata?: UrlContextMetadata;
    url_context_metadata?: UrlContextMetadata;
  }>;
}

export async function executeAntigravitySearchStream(options: {
  apiKey: string;
  contents: SearchContent[];
  tools: SearchToolDeclaration[];
  model?: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}): Promise<SearchStreamResult> {
  const creds = parseApiKey(options.apiKey);
  const preferredModel = resolveSearchModel(options.model);
  const candidateModels = [
    preferredModel,
    ...SEARCH_MODEL_FALLBACKS.filter((id) => id !== preferredModel),
  ];

  const headers = {
    ...antigravityHeaders(creds.token),
    Accept: "text/event-stream",
  };

  let lastError = "No Antigravity endpoint available";

  for (const model of candidateModels) {
    const envelope = antigravityRequestEnvelope(model, false);
    const requestBody = {
      project: creds.projectId,
      model,
      request: {
        contents: options.contents,
        tools: options.tools,
      },
      requestType: AntigravityRequestType.Agent,
      userAgent: AntigravityUserAgent.Antigravity,
      requestId: envelope.requestId,
    };
    const bodyStr = JSON.stringify(requestBody);

    for (const endpoint of endpointCandidates()) {
      if (options.signal?.aborted) throw new Error("Request was aborted");

      try {
        const response = await antigravityFetch(
          `${endpoint}/v1internal:streamGenerateContent?alt=sse`,
          {
            method: "POST",
            headers,
            body: bodyStr,
            signal: options.signal,
          },
        );

        if (!response.ok) {
          const rawErr = await response.text();
          lastError = jsonOrTextError(rawErr).slice(0, 400);
          if (response.status === 404 || [403, 429, 500, 502, 503, 504].includes(response.status)) {
            continue;
          }
          throw new Error(
            `Antigravity search request failed (${response.status}): ${safeError(lastError)}`,
          );
        }

        if (!response.body) {
          throw new Error("No response body received from Antigravity API");
        }

        // Stream and parse SSE chunks
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulatedText = "";
        let groundingMetadata: GroundingMetadata | undefined;
        let urlContextMetadata: UrlContextMetadata | undefined;

        try {
          while (true) {
            if (options.signal?.aborted) throw new Error("Request was aborted");
            const result = await reader.read();
            if (result.done) break;
            if (!(result.value instanceof Uint8Array)) continue;

            buffer += decoder.decode(result.value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const json = line.slice(5).trim();
              if (!json || json === "[DONE]") continue;

              let chunk: StreamCandidateChunk;
              try {
                chunk = JSON.parse(json) as StreamCandidateChunk;
              } catch {
                continue;
              }

              if (chunk.error) {
                const msg = chunk.error.message || JSON.stringify(chunk.error);
                throw new Error(
                  `Antigravity API error (${chunk.error.code || chunk.error.status || "unknown"}): ${msg}`,
                );
              }

              const data = chunk.response || chunk;
              const candidate = data.candidates?.[0];

              if (candidate?.content?.parts) {
                for (const part of candidate.content.parts) {
                  if (part.text) {
                    accumulatedText += part.text;
                    options.onUpdate?.({
                      content: [{ type: "text", text: accumulatedText }],
                      details: { streaming: true },
                    });
                  }
                }
              }

              if (candidate?.groundingMetadata) {
                groundingMetadata = candidate.groundingMetadata;
              }
              if (candidate?.urlContextMetadata || candidate?.url_context_metadata) {
                urlContextMetadata = candidate.urlContextMetadata || candidate.url_context_metadata;
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        // Process citations and grounding results
        const searchDetails = extractGoogleSearchDetails(groundingMetadata);
        await resolveGoogleGroundingRedirectUrls(
          searchDetails.searchResults,
          searchDetails.citations,
          options.signal,
        );
        const searchResults = sanitizeSearchResults(searchDetails.searchResults);
        const citations = sanitizeSearchResults(searchDetails.citations);

        return {
          text: accumulatedText || "No response received.",
          sources: deriveSources(searchResults, citations),
          searchQueries: searchDetails.searchQueries,
          searchResults,
          citations,
          groundingMetadata,
          urlContextMetadata,
          model,
        };
      } catch (err: unknown) {
        lastError = safeError(err);
        if (options.signal?.aborted) {
          throw new Error("Request was aborted", { cause: err });
        }
      }
    }
  }

  throw new Error(`Failed to execute search via Antigravity: ${lastError}`);
}
