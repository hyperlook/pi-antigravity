import type { AntigravityApiKey } from "../types/types.js";
import { failoverToNextAccount, getActiveApiKey } from "../auth/accounts.js";
import { parseApiKey } from "../client/index.js";
import type { CredentialSource } from "./credentials.js";

export class AccountCredentialSource implements CredentialSource {
  constructor(
    private readonly apiKeyGetter?: () => Promise<string | undefined> | string | undefined,
  ) {}

  async current(): Promise<AntigravityApiKey> {
    if (this.apiKeyGetter) {
      const raw = await this.apiKeyGetter();
      if (raw) return parseApiKey(raw);
    }
    return getActiveApiKey();
  }

  async rotate(excluded: ReadonlySet<string>): Promise<AntigravityApiKey | undefined> {
    return failoverToNextAccount(excluded);
  }
}
