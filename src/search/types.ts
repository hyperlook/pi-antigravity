import { Type, type Static } from "@earendil-works/pi-ai";

export const WebSearchSchema = Type.Object({
  query: Type.String({ description: "The search query or question to answer" }),
  urls: Type.Optional(
    Type.Array(Type.String(), {
      description: "Additional URLs to analyze along with search (up to 20)",
      maxItems: 20,
    }),
  ),
});
export type WebSearchInput = Static<typeof WebSearchSchema>;

export const UrlContextSchema = Type.Object({
  urls: Type.Array(Type.String(), {
    description:
      "Public URLs to analyze (web pages, documents, images, YouTube videos, etc). Up to 20 URLs.",
    minItems: 1,
    maxItems: 20,
  }),
  query: Type.Optional(
    Type.String({
      description:
        "Optional question or specific task to perform on the URLs. If omitted, provides a comprehensive summary and key information extraction.",
    }),
  ),
});
export type UrlContextInput = Static<typeof UrlContextSchema>;

export interface Source {
  title: string;
  url: string;
}

export interface SearchResultDetail {
  title?: string;
  url?: string;
  source?: string;
  type?: string;
  status?: string;
  query?: string;
  citedText?: string;
  raw?: unknown;
}

export interface GroundingWebChunk {
  uri?: string;
  title?: string;
}

export interface GroundingChunk {
  web?: GroundingWebChunk;
}

export interface GroundingSegment {
  startIndex?: number;
  endIndex?: number;
  text?: string;
}

export interface GroundingSupport {
  segment?: GroundingSegment;
  groundingChunkIndices?: number[];
  confidenceScores?: number[];
}

export interface GroundingMetadata {
  webSearchQueries?: string[];
  groundingChunks?: GroundingChunk[];
  groundingSupports?: GroundingSupport[];
}

export interface UrlMetadataItem {
  retrievedUrl?: string;
  retrieved_url?: string;
  url?: string;
  urlRetrievalStatus?: string;
  url_retrieval_status?: string;
}

export interface UrlContextMetadata {
  urlMetadata?: UrlMetadataItem[];
  url_metadata?: UrlMetadataItem[];
}

export type SearchContentPart =
  { text: string } | { file_data: { file_uri: string; mime_type: string } };

export interface SearchContent {
  role: "user";
  parts: SearchContentPart[];
}

export type SearchToolDeclaration =
  { google_search: Record<string, never> } | { url_context: Record<string, never> };

export interface SearchStreamResult {
  text: string;
  sources: Source[];
  searchQueries: string[];
  searchResults: SearchResultDetail[];
  citations: SearchResultDetail[];
  groundingMetadata?: GroundingMetadata;
  urlContextMetadata?: UrlContextMetadata;
  model: string;
}
