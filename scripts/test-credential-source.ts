/**
 * Unit and integration tests for CredentialSource and account rotation decoupling:
 * 1. SingleKeyCredentialSource provides static credentials and does not rotate.
 * 2. AccountCredentialSource invokes the custom getter or accounts store.
 * 3. streamAntigravity injects CredentialSource and rotates on 429 Quota reached
 *    without touching real credential storage files.
 * 4. streamAntigravity fails cleanly when CredentialSource rotation is exhausted.
 */
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import {
  AccountCredentialSource,
  SingleKeyCredentialSource,
  type CredentialSource,
} from "../src/runtime/index.js";
import { streamAntigravity } from "../src/stream/index.js";
import type { AntigravityApiKey } from "../src/types/types.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function testSingleKeyCredentialSource(): Promise<void> {
  const jsonKey = JSON.stringify({ token: "token-abc", projectId: "proj-123" });
  const source1 = new SingleKeyCredentialSource(jsonKey);
  const cred1 = await source1.current();
  assert(cred1.token === "token-abc", "SingleKey source parses token from json string");
  assert(cred1.projectId === "proj-123", "SingleKey source parses projectId from json string");
  const rotate1 = await source1.rotate(new Set(["token-abc"]));
  assert(rotate1 === undefined, "SingleKey source returns undefined on rotate");

  const source2 = new SingleKeyCredentialSource({ token: "token-direct", projectId: "proj-direct" });
  const cred2 = await source2.current();
  assert(cred2.token === "token-direct", "SingleKey source supports object constructor");
  assert(cred2.projectId === "proj-direct", "SingleKey source preserves projectId from object");
  console.log("✓ SingleKeyCredentialSource tests passed");
}

async function testAccountCredentialSourceGetter(): Promise<void> {
  const source = new AccountCredentialSource(() =>
    JSON.stringify({ token: "getter-token", projectId: "getter-proj" }),
  );
  const cred = await source.current();
  assert(cred.token === "getter-token", "AccountCredentialSource respects apiKeyGetter token");
  assert(cred.projectId === "getter-proj", "AccountCredentialSource respects apiKeyGetter projectId");
  console.log("✓ AccountCredentialSource getter tests passed");
}

async function testStreamAntigravityRotation(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const authHeadersReceived: string[] = [];

  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // If prewarm HEAD request arrives, respond with 200
    if (init?.method === "HEAD") {
      return new Response(null, { status: 200 });
    }

    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.Authorization || headers.authorization || "";
    authHeadersReceived.push(auth);

    if (auth === "Bearer token-alpha") {
      // 429 Quota reached
      return new Response(
        JSON.stringify({
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            message: "Individual quota reached. Resets in 3h.",
          },
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (auth === "Bearer token-beta") {
      // 200 OK SSE stream
      const sseBody = [
        `data: ${JSON.stringify({
          response: {
            candidates: [
              {
                content: { parts: [{ text: "Hello from rotated token!" }] },
                finishReason: "STOP",
              },
            ],
          },
        })}\n`,
        "data: [DONE]\n\n",
      ].join("\n");

      return new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    return new Response("Unexpected auth header", { status: 400 });
  };

  try {
    let rotateCalls = 0;
    const rotateExcluded: string[] = [];

    const fakeSource: CredentialSource = {
      async current(): Promise<AntigravityApiKey> {
        return { token: "token-alpha", projectId: "test-proj-alpha" };
      },
      async rotate(excluded: ReadonlySet<string>): Promise<AntigravityApiKey | undefined> {
        rotateCalls += 1;
        for (const tok of excluded) rotateExcluded.push(tok);
        return { token: "token-beta", projectId: "test-proj-beta" };
      },
    };

    const model: Model<Api> = {
      id: "gemini-3.7-flash",
      name: "Gemini 3.7 Flash",
      provider: "antigravity",
      api: "antigravity-api",
    } as Model<Api>;

    const context: Context = {
      messages: [{ role: "user", content: "Test rotation" }],
    };

    const stream = streamAntigravity(model, context, {
      credentialSource: fakeSource,
    });

    let collectedText = "";
    for await (const event of stream) {
      if (event.type === "text_delta") {
        collectedText += event.delta;
      }
    }

    assert(
      collectedText === "Hello from rotated token!",
      `Expected 'Hello from rotated token!', got: '${collectedText}'`,
    );
    assert(rotateCalls === 1, `Expected rotate to be called once, got: ${rotateCalls}`);
    assert(
      rotateExcluded.includes("token-alpha"),
      "Excluded set in rotate() must include exhausted token-alpha",
    );
    assert(authHeadersReceived.length === 2, `Expected 2 POST requests, got: ${authHeadersReceived.length}`);
    assert(authHeadersReceived[0] === "Bearer token-alpha", "First request used token-alpha");
    assert(authHeadersReceived[1] === "Bearer token-beta", "Second request used rotated token-beta");

    console.log("✓ streamAntigravity 429 quota rotation test passed");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStreamAntigravityExhaustion(): Promise<void> {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.method === "HEAD") {
      return new Response(null, { status: 200 });
    }
    return new Response(
      JSON.stringify({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "Individual quota reached. Resets in 2h.",
        },
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    let rotateCalled = false;
    const fakeSource: CredentialSource = {
      async current(): Promise<AntigravityApiKey> {
        return { token: "only-token", projectId: "test-proj" };
      },
      async rotate(): Promise<AntigravityApiKey | undefined> {
        rotateCalled = true;
        return undefined; // Exhausted
      },
    };

    const model: Model<Api> = {
      id: "gemini-3.7-flash",
      name: "Gemini 3.7 Flash",
      provider: "antigravity",
      api: "antigravity-api",
    } as Model<Api>;

    const context: Context = {
      messages: [{ role: "user", content: "Test exhaustion" }],
    };

    const stream = streamAntigravity(model, context, {
      credentialSource: fakeSource,
    });

    let caughtError = false;
    for await (const event of stream) {
      if (event.type === "error") {
        caughtError = true;
        assert(
          /Quota reached/i.test(event.error.errorMessage || ""),
          `Expected Quota reached in error message, got: ${event.error.errorMessage}`,
        );
      }
    }

    assert(rotateCalled, "rotate() should have been called before failing");
    assert(caughtError, "Stream should emit error event when quota is exhausted");
    console.log("✓ streamAntigravity exhaustion test passed");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main(): Promise<void> {
  await testSingleKeyCredentialSource();
  await testAccountCredentialSourceGetter();
  await testStreamAntigravityRotation();
  await testStreamAntigravityExhaustion();
  console.log("All credential source tests passed successfully!");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
