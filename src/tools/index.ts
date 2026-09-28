import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  DEFAULT_IMAGE_MODEL,
  generateAntigravityImage,
  IMAGE_ASPECT_RATIOS,
} from "../image/index.js";
import {
  executeUrlContext,
  executeWebSearch,
  UrlContextSchema,
  WebSearchSchema,
} from "../search/index.js";

const NO_CREDENTIALS = "No Antigravity credentials. Run /login antigravity first.";

export function registerAntigravityTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "generate_image",
    label: "Generate image",
    description:
      "Generate an image via Antigravity using the signed-in Google account. Saves under .pi/generated-images/ unless path is set.",
    promptSnippet: "Generate images via Antigravity OAuth (Gemini image models)",
    promptGuidelines: [
      "Use generate_image when the user asks to create, draw, or generate an image.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Image description." }),
      aspectRatio: Type.Optional(StringEnum(IMAGE_ASPECT_RATIOS)),
      model: Type.Optional(
        Type.String({
          description: `Image model id. Default: ${DEFAULT_IMAGE_MODEL}.`,
        }),
      ),
      path: Type.Optional(
        Type.String({
          description: "Project-relative file or directory to save the image.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
      if (!apiKey) throw new Error(NO_CREDENTIALS);
      onUpdate?.({ content: [{ type: "text", text: "Generating image…" }], details: {} });
      const result = await generateAntigravityImage({
        apiKey,
        cwd: ctx.cwd,
        prompt: params.prompt,
        aspectRatio: params.aspectRatio,
        model: params.model,
        path: params.path,
        signal,
      });
      const notes = result.text.join(" ").trim();
      return {
        content: [
          {
            type: "text" as const,
            text: `Saved image to ${result.savedPaths.join(", ")}${notes ? `. ${notes}` : ""}`,
          },
          ...result.images.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ],
        details: { model: result.model, savedPaths: result.savedPaths },
      };
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Google Search via Antigravity for current information, news, and answers. Optionally include URLs to analyze alongside search results.",
    promptSnippet: "Search the web via Google Search (Antigravity)",
    promptGuidelines: [
      "Use web_search to find current information, recent events, news, documentation, or answers on the web.",
    ],
    parameters: WebSearchSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
      if (!apiKey) throw new Error(NO_CREDENTIALS);
      return executeWebSearch({
        apiKey,
        query: params.query,
        urls: params.urls,
        signal,
        onUpdate,
      });
    },
  });

  pi.registerTool({
    name: "url_context",
    label: "URL Context",
    description:
      "Directly analyze, extract, and summarize content from up to 20 public URLs (articles, documentation, web pages, and YouTube videos) via Antigravity.",
    promptSnippet: "Extract and summarize web pages or YouTube videos via Antigravity",
    promptGuidelines: [
      "Use url_context to read, analyze, and extract content from specific URLs or YouTube videos.",
    ],
    parameters: UrlContextSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
      if (!apiKey) throw new Error(NO_CREDENTIALS);
      return executeUrlContext({
        apiKey,
        urls: params.urls,
        query: params.query,
        signal,
        onUpdate,
      });
    },
  });
}
