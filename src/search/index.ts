import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { executeAntigravitySearchStream } from "./client.js";
import { applyCitations } from "./grounding.js";
import type {
  SearchContent,
  SearchResultDetail,
  SearchStreamResult,
  SearchToolDeclaration,
  Source,
  UrlContextMetadata,
} from "./types.js";

export * from "./types.js";
export * from "./grounding.js";
export * from "./client.js";

export const YOUTUBE_REGEX =
  /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

export interface WebSearchExecutionResult {
  content: Array<{ type: "text"; text: string }>;
  details: {
    sources: Source[];
    searchQueries: string[];
    searchResults: SearchResultDetail[];
    citations: SearchResultDetail[];
    model: string;
    retrieved?: string[];
    failed?: Array<{ url?: string; status?: string }>;
    resultCount: number;
  };
}

export interface UrlContextExecutionResult {
  content: Array<{ type: "text"; text: string }>;
  details: {
    sources: Source[];
    searchQueries?: string[];
    searchResults?: SearchResultDetail[];
    citations?: SearchResultDetail[];
    model: string;
    retrieved?: string[];
    failed?: Array<{ url?: string; status?: string }>;
    resultCount: number;
  };
}

function formatUrlMeta(urlContextMetadata: UrlContextMetadata | undefined): {
  retrieved: string[];
  failed: Array<{ url?: string; status?: string }>;
} {
  const urlMeta = urlContextMetadata?.urlMetadata || urlContextMetadata?.url_metadata || [];

  const retrieved: string[] = urlMeta
    .filter(
      (m) => (m.urlRetrievalStatus || m.url_retrieval_status) === "URL_RETRIEVAL_STATUS_SUCCESS",
    )
    .map((m) => m.retrievedUrl || m.retrieved_url || m.url)
    .filter((url): url is string => typeof url === "string" && Boolean(url));

  const failed: Array<{ url?: string; status?: string }> = urlMeta
    .filter(
      (m) => (m.urlRetrievalStatus || m.url_retrieval_status) !== "URL_RETRIEVAL_STATUS_SUCCESS",
    )
    .map((m) => ({
      url: m.retrievedUrl || m.retrieved_url || m.url,
      status: m.urlRetrievalStatus || m.url_retrieval_status,
    }));

  return { retrieved, failed };
}

export async function executeWebSearch(options: {
  apiKey: string;
  query: string;
  urls?: string[];
  model?: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}): Promise<WebSearchExecutionResult> {
  const query = options.query?.trim();
  if (!query) throw new Error("Search query is required.");

  const urls = (options.urls || []).map((u) => u.trim()).filter(Boolean);
  const hasUrls = urls.length > 0;

  options.onUpdate?.({
    content: [
      {
        type: "text",
        text: hasUrls
          ? `Searching and analyzing ${urls.length} URL(s)...`
          : `Searching Google for "${query}"...`,
      },
    ],
    details: {},
  });

  const prompt = hasUrls ? `${query}\n\nAlso analyze these URLs:\n${urls.join("\n")}` : query;
  const contents: SearchContent[] = [{ role: "user", parts: [{ text: prompt }] }];
  const tools: SearchToolDeclaration[] = hasUrls
    ? [{ google_search: {} }, { url_context: {} }]
    : [{ google_search: {} }];

  const result: SearchStreamResult = await executeAntigravitySearchStream({
    apiKey: options.apiKey,
    contents,
    tools,
    model: options.model,
    signal: options.signal,
    onUpdate: options.onUpdate,
  });

  const cited = applyCitations(result.text, result.groundingMetadata);
  let summary = cited.text;
  const sources = result.sources.length ? result.sources : cited.sources;
  const extraSearchResults = result.searchResults.filter(
    (item) => item.url && !sources.some((s) => s.url === item.url),
  );

  const { retrieved, failed } = formatUrlMeta(result.urlContextMetadata);

  if (failed.length > 0) {
    summary += `\n\n## URL Status\n✅ Retrieved: ${retrieved.length}\n❌ Failed: ${failed.length}`;
    failed.forEach((f) => {
      summary += `\n- ${f.url || "unknown"}: ${f.status || "failed"}`;
    });
  }

  if (sources.length > 0) {
    summary += `\n\n## Sources\n${sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")}`;
  }

  if (extraSearchResults.length > 0) {
    const visibleResults = extraSearchResults.slice(0, 8);
    summary += `\n\n## Additional Search Results\n${visibleResults
      .map((r, i) => `${i + 1}. [${r.title || r.url || "Result"}](${r.url})`)
      .join("\n")}`;
  }

  return {
    content: [{ type: "text", text: summary }],
    details: {
      sources,
      searchQueries: result.searchQueries,
      searchResults: result.searchResults,
      citations: result.citations,
      model: result.model,
      retrieved: retrieved.length > 0 ? retrieved : undefined,
      failed: failed.length > 0 ? failed : undefined,
      resultCount: result.searchResults.length || sources.length,
    },
  };
}

export async function executeUrlContext(options: {
  apiKey: string;
  urls: string[];
  query?: string;
  model?: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}): Promise<UrlContextExecutionResult> {
  const urls = (options.urls || []).map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) throw new Error("At least one URL is required for url_context.");

  const defaultPrompt =
    "Provide a comprehensive summary and extract key details, structure, and main points from the provided URL(s).";
  const userPrompt = options.query?.trim() || defaultPrompt;

  options.onUpdate?.({
    content: [
      {
        type: "text",
        text: `Analyzing ${urls.length} URL${urls.length > 1 ? "s" : ""} via Antigravity...`,
      },
    ],
    details: {},
  });

  const youtubeUrls: string[] = [];
  const otherUrls: string[] = [];
  for (const url of urls) {
    if (YOUTUBE_REGEX.test(url)) {
      youtubeUrls.push(url);
    } else {
      otherUrls.push(url);
    }
  }

  let contents: SearchContent[];
  const tools: SearchToolDeclaration[] = [{ url_context: {} }];

  if (youtubeUrls.length > 0) {
    const parts: SearchContent["parts"] = [];
    for (const url of youtubeUrls) {
      parts.push({
        file_data: { file_uri: url, mime_type: "video/mp4" },
      });
    }
    let promptText = userPrompt;
    if (otherUrls.length > 0) {
      promptText += `\n\nURLs:\n${otherUrls.join("\n")}`;
    }
    parts.push({ text: promptText });
    contents = [{ role: "user", parts }];
  } else {
    const combinedPrompt = `${userPrompt}\n\nURLs:\n${urls.join("\n")}`;
    contents = [{ role: "user", parts: [{ text: combinedPrompt }] }];
  }

  const result: SearchStreamResult = await executeAntigravitySearchStream({
    apiKey: options.apiKey,
    contents,
    tools,
    model: options.model,
    signal: options.signal,
    onUpdate: options.onUpdate,
  });

  const cited = applyCitations(result.text, result.groundingMetadata);
  let summary = cited.text;
  const sources = result.sources.length ? result.sources : cited.sources;
  const extraSearchResults = result.searchResults.filter(
    (item) => item.url && !sources.some((s) => s.url === item.url),
  );

  const { retrieved, failed } = formatUrlMeta(result.urlContextMetadata);

  if (failed.length > 0) {
    summary += `\n\n## URL Status\n✅ Retrieved: ${retrieved.length}\n❌ Failed: ${failed.length}`;
    failed.forEach((f) => {
      summary += `\n- ${f.url || "unknown"}: ${f.status || "failed"}`;
    });
  }

  if (sources.length > 0 && !summary.includes("## Sources")) {
    summary += `\n\n## Sources\n${sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")}`;
  }

  if (extraSearchResults.length > 0) {
    const visibleResults = extraSearchResults.slice(0, 8);
    summary += `\n\n## Additional Search Results\n${visibleResults
      .map((r, i) => `${i + 1}. [${r.title || r.url || "Result"}](${r.url})`)
      .join("\n")}`;
  }

  return {
    content: [{ type: "text", text: summary }],
    details: {
      sources,
      searchQueries: result.searchQueries,
      searchResults: result.searchResults,
      citations: result.citations,
      model: result.model,
      retrieved: retrieved.length > 0 ? retrieved : undefined,
      failed: failed.length > 0 ? failed : undefined,
      resultCount: result.searchResults.length || sources.length,
    },
  };
}
