import { spawn } from "node:child_process";

// Anthropic's edge fingerprints the TLS ClientHello (JA3/JA4) and currently
// rejects Node's OpenSSL handshake with `403 "Request not allowed"` while
// accepting curl. So we try Node `fetch` first (fast, no subprocess) and fall
// back to the system `curl` binary on that specific rejection. curl ships with
// Windows 10+ and every macOS / Linux. This mirrors the ClaudeCodeUsage
// extension's transport strategy.

export interface HttpResponse {
  status: number;
  body: string;
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const log = (line: string) => console.error(`[http] ${line}`);

export async function requestViaFetch(url: string, opts: HttpOptions): Promise<HttpResponse> {
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: opts.headers,
    body: opts.body,
  });
  const body = await res.text();
  return { status: res.status, body };
}

// Build a curl config file (passed on stdin via `-K -`) so the bearer token is
// never placed in argv, where it would be visible in `ps`.
function curlConfig(url: string, opts: HttpOptions): string {
  const esc = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const lines: string[] = [
    `url = ${esc(url)}`,
    `request = ${esc(opts.method ?? "GET")}`,
    "silent",
    "show-error",
  ];
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    lines.push(`header = ${esc(`${k}: ${v}`)}`);
  }
  if (opts.body != null) {
    lines.push(`data = ${esc(opts.body)}`);
  }
  return lines.join("\n") + "\n";
}

export function requestViaCurl(url: string, opts: HttpOptions): Promise<HttpResponse> {
  const config = curlConfig(url, opts);
  return new Promise((resolve, reject) => {
    // `-K -` reads the config (url, method, headers, data) from stdin.
    // `-w "\n%{http_code}"` appends the status code as the last line.
    const child = spawn("curl", ["-K", "-", "-w", "\n%{http_code}"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", () => {
      const nl = out.lastIndexOf("\n");
      const codeStr = nl >= 0 ? out.slice(nl + 1).trim() : out.trim();
      const status = parseInt(codeStr, 10);
      const body = nl >= 0 ? out.slice(0, nl) : "";
      if (!Number.isFinite(status)) {
        reject(new Error(`curl produced no status code${err ? `: ${err.trim()}` : ""}`));
        return;
      }
      resolve({ status, body });
    });
    child.stdin.write(config);
    child.stdin.end();
  });
}

// Try fetch, fall back to curl on the TLS-fingerprint gate. Once curl has been
// needed, `state.preferCurl` sticks so we don't keep paying for a doomed fetch.
export async function request(
  url: string,
  opts: HttpOptions,
  state: { preferCurl: boolean },
): Promise<HttpResponse> {
  const forceCurl = process.env.CLAUDE_USAGE_FORCE_CURL === "1";
  if (!state.preferCurl && !forceCurl) {
    try {
      const r = await requestViaFetch(url, opts);
      if (r.status === 403 && r.body.includes("Request not allowed")) {
        log('fetch 403 "Request not allowed" -> falling back to curl');
        state.preferCurl = true;
      } else {
        return r;
      }
    } catch (e) {
      log(`fetch error (${(e as Error).message}) -> trying curl`);
      state.preferCurl = true;
    }
  }
  return requestViaCurl(url, opts);
}
