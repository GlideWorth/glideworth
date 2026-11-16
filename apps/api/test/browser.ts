import type { Harness } from "./helpers.js";

function formBody(f: Record<string, string | string[]>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f))
    for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
  return p.toString();
}

export interface BrowserResponse {
  status: number;
  headers: { get(name: string): string | null; getSetCookie(): string[] };
  // oxlint-disable-next-line typescript/no-explicit-any -- tests probe arbitrary JSON
  json: any;
  text: string;
}
export interface Browser {
  req(
    path: string,
    init?: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      form?: Record<string, string | string[]>;
    },
  ): Promise<BrowserResponse>;
  jar: Map<string, string>;
  csrf(): string | undefined;
}

/** A minimal cookie jar over app.request, the way a browser would behave. */
export function browser(app: Harness["app"]): Browser {
  const jar = new Map<string, string>();
  async function req(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      form?: Record<string, string | string[]>;
    } = {},
  ) {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.form) headers["content-type"] = "application/x-www-form-urlencoded";
    if (
      init.method &&
      init.method !== "GET" &&
      !init.headers?.["x-csrf-token"] &&
      jar.has("glideworth_csrf") &&
      !init.form
    )
      headers["x-csrf-token"] = jar.get("glideworth_csrf")!;
    const res = await app.request(path, {
      method: init.method ?? "GET",
      headers,
      redirect: "manual",
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      ...(init.form ? { body: formBody(init.form) } : {}),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, ...v] = pair!.split("=");
      const value = v.join("=");
      if (/max-age=0/i.test(c) || value === "") jar.delete(k!);
      else jar.set(k!, value);
    }
    const text = await res.text();
    // oxlint-disable-next-line typescript/no-explicit-any -- tests probe arbitrary JSON
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, json, text };
  }
  return { req, jar, csrf: () => jar.get("glideworth_csrf") };
}
