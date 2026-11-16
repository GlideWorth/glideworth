/**
 * AI & integrations: what MCP access means in Glideworth, copy-paste client configuration, and a live
 * connection test against this server's /mcp endpoint.
 */
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, CircleAlert, KeyRound, Loader2, PlugZap, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { toast } from "../../components/ui/toaster";
import { api } from "../../lib/api";
import { csrfHeaders } from "../../lib/auth";
import { CopyButton } from "./keys-section";
import { CodeBlock, SectionIntro, SettingsGroup } from "./settings-ui";

export const KEY_PLACEHOLDER = "glideworth_xxxxxxxx_your-key-here";

export function mcpSnippets(endpoint: string, key: string) {
  return {
    claudeCode: `claude mcp add --transport http glideworth ${endpoint} \\\n  --header "Authorization: Bearer ${key}"`,
    claudeDesktop: JSON.stringify(
      {
        mcpServers: {
          glideworth: {
            command: "npx",
            // mcp-remote expands ${GLIDEWORTH_AUTH} itself
            args: ["-y", "mcp-remote", endpoint, "--header", "Authorization:${GLIDEWORTH_AUTH}"],
            env: { GLIDEWORTH_AUTH: `Bearer ${key}` },
          },
        },
      },
      null,
      2,
    ),
    generic: `URL:     ${endpoint}\nHeader:  Authorization: Bearer ${key}\nTransport: Streamable HTTP (stateless, JSON responses)`,
  };
}

interface McpResult {
  server?: { name?: string; version?: string };
  protocolVersion?: string;
  tools: { name: string; annotations?: { readOnlyHint?: boolean } }[];
  ms: number;
}

async function rpc(
  endpoint: string,
  key: string | undefined,
  id: number,
  method: string,
  params: unknown,
) {
  const res = await fetch(endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...csrfHeaders("POST"),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
    } catch {
      /* keep status */
    }
    throw new Error(res.status === 401 ? "Not authorised: paste a valid API key above." : msg);
  }
  const body = text.trimStart().startsWith("{")
    ? text
    : (text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .at(-1) ?? "{}");
  const json = JSON.parse(body) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result as Record<string, unknown>;
}

export async function testMcp(endpoint: string, key?: string): Promise<McpResult> {
  const t0 = performance.now();
  const init = await rpc(endpoint, key, 1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "glideworth-settings-test", version: "1" },
  });
  const list = await rpc(endpoint, key, 2, "tools/list", {});
  return {
    server: init.serverInfo as McpResult["server"],
    protocolVersion: init.protocolVersion as string | undefined,
    tools: (list.tools as McpResult["tools"]) ?? [],
    ms: Math.round(performance.now() - t0),
  };
}

export function AiSection() {
  const endpoint = `${typeof window !== "undefined" ? window.location.origin : "http://localhost:8787"}/mcp`;
  const [key, setKey] = useState("");
  const shown = key.trim() || KEY_PLACEHOLDER;
  const snippets = mcpSnippets(endpoint, shown);
  const create = useMutation({
    mutationFn: () => api.createKey({ name: "Claude (read-only)", scopes: ["read"] }),
    onSuccess: (k) => {
      setKey(k.key);
      toast({
        title: "Read-only key created",
        description:
          "It is filled into the snippets below. It will not be shown again once you leave this page.",
        tone: "positive",
      });
    },
    onError: (e) =>
      toast({
        title: "Could not create a key",
        description: e instanceof Error ? e.message : String(e),
        tone: "negative",
      }),
  });
  const test = useMutation({ mutationFn: () => testMcp("/mcp", key.trim() || undefined) });
  const writeTools = (test.data?.tools ?? []).filter((t) => t.annotations?.readOnlyHint === false);

  return (
    <>
      <SectionIntro title="AI & integrations">
        Connect Claude or any other assistant that speaks the Model Context Protocol (MCP). It can
        read your plans, run simulations and solvers, and explain results in plain language, against
        your own server.
      </SectionIntro>
      <div className="grid gap-3 md:grid-cols-3">
        {[
          {
            title: "Read-only by default",
            body: "Assistants see only what their key allows. A read key can look and simulate, never change.",
          },
          {
            title: "Edits are proposals",
            body: "With writes switched on, changes arrive as change sets with a before/after preview. Nothing applies until you approve.",
          },
          {
            title: "Every change is recorded",
            body: "Applied changes become plan versions with the assistant’s name on them, and can be undone.",
          },
        ].map((x) => (
          <div key={x.title} className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
              <ShieldCheck className="size-4 text-accent" aria-hidden /> {x.title}
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{x.body}</p>
          </div>
        ))}
      </div>

      <SettingsGroup
        title="1 · A key for the assistant"
        description="Use a separate, least-privilege key per assistant."
      >
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => create.mutate()}
              disabled={create.isPending}
            >
              {create.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />} Create a
              read-only key
            </Button>
            <span className="text-[12px] text-ink-3">
              or paste an existing one (it stays in this page, nothing is stored). Manage keys in{" "}
              <Link
                to="/settings/$section"
                params={{ section: "keys" }}
                className="text-accent underline underline-offset-2"
              >
                API keys
              </Link>
              .
            </span>
          </div>
          <Input
            aria-label="API key for the snippets and the connection test"
            placeholder={KEY_PLACEHOLDER}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-[12px]"
          />
        </div>
      </SettingsGroup>

      <SettingsGroup title="2 · Add Glideworth to your client">
        <Tabs defaultValue="code" className="px-5 py-4">
          <TabsList aria-label="Client">
            <TabsTrigger value="code">Claude Code</TabsTrigger>
            <TabsTrigger value="desktop">Claude Desktop</TabsTrigger>
            <TabsTrigger value="other">Other clients</TabsTrigger>
          </TabsList>
          <TabsContent value="code" className="flex flex-col gap-2 pt-3">
            <p className="text-[12.5px] text-ink-2">Run this in a terminal:</p>
            <CodeBlock label="Claude Code command">{snippets.claudeCode}</CodeBlock>
            <div className="flex justify-end">
              <CopyButton text={snippets.claudeCode} label="Copy command" />
            </div>
          </TabsContent>
          <TabsContent value="desktop" className="flex flex-col gap-2 pt-3">
            <p className="text-[12.5px] text-ink-2">
              Add this to{" "}
              <code className="rounded bg-surface-2 px-1">claude_desktop_config.json</code>{" "}
              (Settings → Developer → Edit config), then restart Claude Desktop. It uses the{" "}
              <code className="rounded bg-surface-2 px-1">mcp-remote</code> bridge, which needs
              Node.js.
            </p>
            <CodeBlock label="Claude Desktop configuration">{snippets.claudeDesktop}</CodeBlock>
            <div className="flex justify-end">
              <CopyButton text={snippets.claudeDesktop} label="Copy configuration" />
            </div>
          </TabsContent>
          <TabsContent value="other" className="flex flex-col gap-2 pt-3">
            <CodeBlock label="Connection details">{snippets.generic}</CodeBlock>
            <p className="text-[12px] text-ink-3">
              A local stdio server is also available for clients on the same machine; see
              docs/MCP.md. Write tools appear only when the server runs with{" "}
              <code className="rounded bg-surface-2 px-1">GLIDEWORTH_MCP_ALLOW_WRITES=true</code>{" "}
              and the key has the write scope.
            </p>
          </TabsContent>
        </Tabs>
      </SettingsGroup>

      <SettingsGroup
        title="3 · Test the connection"
        description="Talks to this server’s MCP endpoint exactly as a client would."
        actions={
          <Button size="sm" onClick={() => test.mutate()} disabled={test.isPending}>
            {test.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />} Test now
          </Button>
        }
      >
        <div className="px-5 py-4 text-[13px]" aria-live="polite">
          {test.isIdle ? (
            <p className="text-ink-3">
              Not tested yet. Without a key the test uses this browser’s own access.
            </p>
          ) : test.isPending ? (
            <p className="flex items-center gap-2 text-ink-2">
              <Loader2 className="size-4 animate-spin" /> Connecting…
            </p>
          ) : test.isError ? (
            <p className="flex items-start gap-2 text-negative">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />{" "}
              {test.error instanceof Error ? test.error.message : String(test.error)}
            </p>
          ) : test.data ? (
            <div className="flex flex-col gap-2">
              <p className="flex items-center gap-2 font-medium text-positive">
                <CheckCircle2 className="size-4" /> Connected to{" "}
                {test.data.server?.name ?? "Glideworth"}{" "}
                {test.data.server?.version ? `v${test.data.server.version}` : ""} in {test.data.ms}{" "}
                ms
              </p>
              <p className="text-[12.5px] text-ink-2">
                {test.data.tools.length} tools available ·{" "}
                {writeTools.length
                  ? `${writeTools.length} can propose or apply changes`
                  : "read-only"}
                {test.data.protocolVersion ? ` · protocol ${test.data.protocolVersion}` : ""}
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {test.data.tools.map((t) => (
                  <li key={t.name}>
                    <Badge
                      tone={t.annotations?.readOnlyHint === false ? "ochre" : "neutral"}
                      className="font-mono"
                    >
                      {t.name}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </SettingsGroup>
    </>
  );
}
