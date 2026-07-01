import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { request } from "./http.js";
import { ClaudeApiUsageResponse, ClaudeCredentials } from "./types.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const OAUTH_BETA = "oauth-2025-04-20";
// Claude Code's public OAuth client id. The token endpoint rejects a refresh
// request that omits it with 400 "Invalid request format". This is the public
// identifier of the Claude Code app, not a secret.
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const log = (line: string) => console.error(`[client] ${line}`);

export class UsageUnavailableError extends Error {}

export class ClaudeUsageClient {
  private readonly credentialsPath: string;
  private credentials: ClaudeCredentials | null = null;
  private credentialsSource: "file" | "keychain" | null = null;
  private readonly httpState = { preferCurl: false };

  constructor() {
    this.credentialsPath = path.join(os.homedir(), ".claude", ".credentials.json");
  }

  // ---- credential loading -------------------------------------------------

  private loadCredentials(): ClaudeCredentials | null {
    try {
      if (!fs.existsSync(this.credentialsPath)) {
        return this.loadFromKeychain();
      }
      const parsed = JSON.parse(
        fs.readFileSync(this.credentialsPath, "utf-8"),
      ) as ClaudeCredentials;
      if (!parsed?.claudeAiOauth?.accessToken) {
        log("credentials file present but has no claudeAiOauth.accessToken");
        return null;
      }
      this.credentials = parsed;
      this.credentialsSource = "file";
      return parsed;
    } catch (e) {
      log(`credentials read failed: ${(e as Error).message}`);
      return null;
    }
  }

  private loadFromKeychain(): ClaudeCredentials | null {
    if (process.platform !== "darwin") return null;
    try {
      const content = execFileSync(
        "/usr/bin/security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      const parsed = JSON.parse(content) as ClaudeCredentials;
      if (!parsed?.claudeAiOauth?.accessToken) return null;
      this.credentials = parsed;
      this.credentialsSource = "keychain";
      log("credentials loaded from macOS Keychain");
      return parsed;
    } catch (e) {
      log(`keychain read failed: ${(e as Error).message}`);
      return null;
    }
  }

  private saveCredentials(creds: ClaudeCredentials): void {
    if (this.credentialsSource === "keychain" && process.platform === "darwin") {
      try {
        execFileSync(
          "/usr/bin/security",
          [
            "add-generic-password",
            "-a",
            os.userInfo().username,
            "-s",
            "Claude Code-credentials",
            "-w",
            JSON.stringify(creds),
            "-U",
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        this.credentials = creds;
        return;
      } catch (e) {
        log(`keychain write failed: ${(e as Error).message}`);
      }
    }
    fs.writeFileSync(this.credentialsPath, JSON.stringify(creds), "utf-8");
    this.credentials = creds;
    this.credentialsSource = "file";
  }

  private isExpired(creds: ClaudeCredentials): boolean {
    return Date.now() >= creds.claudeAiOauth.expiresAt - 60_000;
  }

  private async refreshToken(creds: ClaudeCredentials): Promise<ClaudeCredentials> {
    const r = await request(
      TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          refresh_token: creds.claudeAiOauth.refreshToken,
          grant_type: "refresh_token",
          client_id: OAUTH_CLIENT_ID,
        }),
      },
      this.httpState,
    );
    if (r.status !== 200) {
      throw new Error(`token refresh failed: ${r.status}`);
    }
    const data = JSON.parse(r.body) as { access_token: string; expires_in: number };
    const updated: ClaudeCredentials = {
      ...creds,
      claudeAiOauth: {
        ...creds.claudeAiOauth,
        accessToken: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      },
    };
    this.saveCredentials(updated);
    return updated;
  }

  // Re-read on every call so switching Claude accounts is honoured without a
  // restart. Claude Code usually rotates the on-disk token itself, so prefer a
  // fresh read before attempting our own refresh.
  private async getValidCredentials(): Promise<ClaudeCredentials | null> {
    let creds = this.loadCredentials() ?? this.credentials;
    if (!creds) return null;
    if (this.isExpired(creds)) {
      const fresh = this.loadCredentials();
      if (fresh && !this.isExpired(fresh)) return fresh;
      creds = await this.refreshToken(fresh ?? creds);
    }
    return creds;
  }

  // ---- usage --------------------------------------------------------------

  private callUsageApi(accessToken: string) {
    return request(
      USAGE_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "anthropic-beta": OAUTH_BETA,
          "Content-Type": "application/json",
        },
      },
      this.httpState,
    );
  }

  /**
   * Fetch the raw usage windows. Throws UsageUnavailableError with a
   * human-readable reason (not signed in, rate-limited, endpoint changed, ...).
   */
  async fetchUsage(): Promise<ClaudeApiUsageResponse> {
    const creds = await this.getValidCredentials();
    if (!creds) {
      throw new UsageUnavailableError(
        "No Claude Code OAuth session found. Sign in with `claude` (Claude Code) first.",
      );
    }

    let res = await this.callUsageApi(creds.claudeAiOauth.accessToken);

    if (res.status === 401) {
      // Force a refresh and retry once.
      const refreshed = await this.refreshToken(creds);
      res = await this.callUsageApi(refreshed.claudeAiOauth.accessToken);
    }

    if (res.status === 429) {
      throw new UsageUnavailableError("Rate-limited by the usage endpoint (429). Try again shortly.");
    }
    if (res.status !== 200) {
      throw new UsageUnavailableError(
        `Usage endpoint returned ${res.status}. It is undocumented and may have changed.`,
      );
    }
    return JSON.parse(res.body) as ClaudeApiUsageResponse;
  }
}
