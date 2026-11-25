import { type ToolResult, WIDGET_META_KEY, type WidgetPayload, type WidgetViewName } from "./types";

const VIEWS: readonly WidgetViewName[] = [
  "outcome",
  "pending",
  "compare",
  "answer",
  "review",
  "year",
  "tax",
];

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A tool error as the Glideworth MCP server reports it: text content `{ "error": { code, message, hint } }`. */
export interface ToolErrorInfo {
  code: string;
  message: string;
  hint?: string;
}

export class ToolError extends Error {
  readonly code: string;
  constructor(info: ToolErrorInfo) {
    super(info.message);
    this.name = "ToolError";
    this.code = info.code;
  }
}

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("\n")
    .trim();
}

/** The JSON body of a result: structuredContent, or the text content parsed as JSON. */
export function bodyOf(result: ToolResult): Obj {
  if (isObj(result.structuredContent)) return result.structuredContent;
  try {
    const parsed: unknown = JSON.parse(textOf(result));
    return isObj(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function errorFrom(result: ToolResult): ToolErrorInfo {
  const body = bodyOf(result);
  const error = isObj(body.error) ? body.error : body;
  const message =
    typeof error.message === "string" && error.message
      ? error.message
      : textOf(result) || "Something went wrong.";
  return {
    code: typeof error.code === "string" ? error.code : "ERROR",
    message: message.charAt(0).toUpperCase() + message.slice(1),
    ...(typeof error.hint === "string" ? { hint: error.hint } : {}),
  };
}

/** The widget payload in `_meta["glideworth/widget"]`, if it looks like one. */
export function payloadFrom(result: ToolResult | null | undefined): WidgetPayload | null {
  if (!result) return null;
  const candidates = [
    result._meta,
    isObj(result.structuredContent) ? result.structuredContent._meta : null,
  ];
  for (const meta of candidates) {
    const value = isObj(meta) ? meta[WIDGET_META_KEY] : null;
    if (
      isObj(value) &&
      typeof value.view === "string" &&
      (VIEWS as readonly string[]).includes(value.view) &&
      isObj(value.plan)
    )
      return value as unknown as WidgetPayload;
  }
  return null;
}

export type ViewModel =
  | { kind: "payload"; payload: WidgetPayload }
  | { kind: "error"; message: string }
  | { kind: "empty"; reason: "waiting" | "cancelled" | "none" };

export function routeToolResult(
  result: ToolResult | null | undefined,
  options: { cancelled?: boolean } = {},
): ViewModel {
  if (options.cancelled && !result) return { kind: "empty", reason: "cancelled" };
  if (!result) return { kind: "empty", reason: "waiting" };
  if (result.isError) return { kind: "error", message: errorFrom(result).message };
  const payload = payloadFrom(result);
  if (payload) return { kind: "payload", payload };
  return { kind: "empty", reason: options.cancelled ? "cancelled" : "none" };
}
