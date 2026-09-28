import type { AntigravityApiKey } from "../types/types.js";
import { parseApiKey } from "../client/index.js";
import type { CredentialSource } from "./credentials.js";

export class SingleKeyCredentialSource implements CredentialSource {
  private readonly creds: AntigravityApiKey;

  constructor(key: string | AntigravityApiKey) {
    this.creds = typeof key === "string" ? parseApiKey(key) : key;
  }

  async current(): Promise<AntigravityApiKey> {
    return this.creds;
  }

  async rotate(_excluded: ReadonlySet<string>): Promise<AntigravityApiKey | undefined> {
    return undefined;
  }
}
