import type { GroundingMetadata, SearchResultDetail, Source } from "./types.js";

const JUNK_SUFFIXES = [
  ".gz",
  ".zip",
  ".tgz",
  ".tar",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".webm",
  ".mp4",
  ".mp3",
  ".wav",
  ".eps",
  ".sql",
  ".csv",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
];

const REMOVABLE_PARAMS = [
  "ref",
  "referral_type",
  "openLinerExtension",
  "_clear",
  "lang",
  "api-mode",
];

export function normalizeSearchUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    if (
      !/(^|\.)youtube\.com$/i.test(parsed.hostname) &&
      !/(^|\.)youtu\.be$/i.test(parsed.hostname)
    ) {
      for (const name of REMOVABLE_PARAMS) parsed.searchParams.delete(name);
      for (const name of [...parsed.searchParams.keys()]) {
        if (name.toLowerCase().startsWith("utm_")) parsed.searchParams.delete(name);
      }
    }
    const query = parsed.searchParams.toString();
    parsed.search = query ? `?${query}` : "";
    return parsed.toString();
  } catch {
    return url;
  }
}

export function isLikelyJunkSearchUrl(url: string | undefined): boolean {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    const decodedPath = decodeURIComponent(parsed.pathname).toLowerCase();
    if (JUNK_SUFFIXES.some((suffix) => decodedPath.endsWith(suffix))) return true;
    if (decodedPath === "/%" || decodedPath.endsWith("/%")) return true;
    return false;
  } catch {
    return false;
  }
}

export function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop();
    return lastSegment || parsed.hostname || url;
  } catch {
    return url;
  }
}

export function pushUniqueSource(sources: Source[], source: Source): number {
  const existing = sources.findIndex((s) => s.url === source.url);
  if (existing >= 0) {
    const current = sources[existing];
    if (current && (!current.title || current.title === "Unknown") && source.title) {
      current.title = source.title;
    }
    return existing;
  }
  sources.push(source);
  return sources.length - 1;
}

export function pushUniqueSearchResult(
  results: SearchResultDetail[],
  result: SearchResultDetail,
): void {
  const key = `${result.url || ""}\t${result.title || ""}\t${result.query || ""}\t${result.citedText || ""}\t${result.type || ""}`;
  const exists = results.some(
    (item) =>
      `${item.url || ""}\t${item.title || ""}\t${item.query || ""}\t${item.citedText || ""}\t${item.type || ""}` ===
      key,
  );
  if (!exists) results.push(result);
}

export function extractGoogleSearchDetails(groundingMetadata: GroundingMetadata | undefined): {
  searchQueries: string[];
  searchResults: SearchResultDetail[];
  citations: SearchResultDetail[];
} {
  const searchQueries: string[] = groundingMetadata?.webSearchQueries || [];
  const chunks = groundingMetadata?.groundingChunks || [];
  const supports = groundingMetadata?.groundingSupports || [];
  const searchResults: SearchResultDetail[] = [];
  const citations: SearchResultDetail[] = [];

  chunks.forEach((chunk, index) => {
    if (!chunk.web) return;
    pushUniqueSearchResult(searchResults, {
      title: chunk.web.title || "Unknown",
      url: chunk.web.uri || "",
      source: "google.groundingChunks",
      type: "web",
      raw: { index, ...chunk.web },
    });
  });

  supports.forEach((support) => {
    for (const index of support.groundingChunkIndices || []) {
      const web = chunks[index]?.web;
      if (!web) continue;
      pushUniqueSearchResult(citations, {
        title: web.title || "Unknown",
        url: web.uri || "",
        citedText: support.segment?.text,
        source: "google.groundingSupports",
        type: "citation",
        raw: support,
      });
    }
  });

  return { searchQueries, searchResults, citations };
}

export function isGoogleGroundingRedirect(url: string | undefined): boolean {
  return (
    typeof url === "string" &&
    /^https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//.test(url)
  );
}

export async function resolveGoogleGroundingRedirectUrls(
  searchResults: SearchResultDetail[],
  citations: SearchResultDetail[],
  signal?: AbortSignal,
): Promise<void> {
  const redirectUrls = [
    ...new Set(
      [...searchResults, ...citations]
        .map((item) => item.url)
        .filter((url): url is string => isGoogleGroundingRedirect(url)),
    ),
  ];
  if (redirectUrls.length === 0) return;

  const resolved = new Map<string, string>();
  await Promise.all(
    redirectUrls.slice(0, 20).map(async (url) => {
      try {
        const response = await fetch(url, { method: "HEAD", redirect: "manual", signal });
        const location = response.headers.get("location");
        if (location) resolved.set(url, location);
      } catch {
        // Keep original URL on error
      }
    }),
  );

  if (resolved.size === 0) return;
  for (const item of [...searchResults, ...citations]) {
    if (!item.url) continue;
    const canonicalUrl = resolved.get(item.url);
    if (!canonicalUrl) continue;
    item.url = canonicalUrl;
    if (!item.title || item.title === "Unknown") item.title = titleFromUrl(canonicalUrl);
  }
}

export function sanitizeSearchResults(results: SearchResultDetail[]): SearchResultDetail[] {
  const sanitized: SearchResultDetail[] = [];
  for (const result of results) {
    const normalizedUrl = result.url ? normalizeSearchUrl(result.url) : result.url;
    const normalized = { ...result, url: normalizedUrl };
    if (normalized.url && isLikelyJunkSearchUrl(normalized.url)) continue;
    pushUniqueSearchResult(sanitized, normalized);
  }
  return sanitized;
}

export function deriveSources(
  searchResults: SearchResultDetail[],
  citations: SearchResultDetail[] = [],
): Source[] {
  const sources: Source[] = [];
  for (const item of [...citations, ...searchResults]) {
    if (!item.url) continue;
    const url = normalizeSearchUrl(item.url);
    if (isLikelyJunkSearchUrl(url)) continue;
    pushUniqueSource(sources, {
      title: item.title || titleFromUrl(url),
      url,
    });
  }
  return sources;
}

/**
 * Byte-safe citation insertion into generated markdown text.
 * Google Grounding segment.endIndex is given as UTF-8 byte offset,
 * not JavaScript UTF-16 character index.
 */
export function applyCitations(
  text: string,
  groundingMetadata: GroundingMetadata | undefined,
): { text: string; sources: Source[] } {
  const chunks = groundingMetadata?.groundingChunks || [];
  const supports = groundingMetadata?.groundingSupports || [];

  const sources: Source[] = chunks
    .filter((c) => Boolean(c.web))
    .map((c) => ({ title: c.web?.title || "Unknown", url: c.web?.uri || "" }));

  if (!supports.length || !sources.length) return { text, sources };

  const insertions = supports
    .filter(
      (s): s is typeof s & { segment: { endIndex: number } } =>
        typeof s.segment?.endIndex === "number" && Boolean(s.groundingChunkIndices?.length),
    )
    .map((s) => ({
      index: s.segment.endIndex,
      marker: (s.groundingChunkIndices || []).map((i) => `[${i + 1}]`).join(""),
    }))
    .sort((a, b) => b.index - a.index);

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(text);

  const parts: Uint8Array[] = [];
  let lastIndex = bytes.length;

  for (const ins of insertions) {
    const pos = Math.min(ins.index, lastIndex);
    if (pos < lastIndex) parts.unshift(bytes.subarray(pos, lastIndex));
    parts.unshift(encoder.encode(ins.marker));
    lastIndex = pos;
  }
  if (lastIndex > 0) parts.unshift(bytes.subarray(0, lastIndex));

  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const final = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    final.set(part, offset);
    offset += part.length;
  }

  return { text: decoder.decode(final), sources };
}
