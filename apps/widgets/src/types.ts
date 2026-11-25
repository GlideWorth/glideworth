/**
 * Types shared across the widget. The payload types come from the server's contract as types only: nothing from
 * apps/api is bundled.
 */
export type {
  AnswerView,
  CompareView,
  OutcomeNumbers,
  OutcomeView,
  PendingView,
  PlanRef,
  ReviewView,
  TaxView,
  TemplateParam,
  WidgetPayload,
  WidgetViewName,
  YearView,
} from "../../api/src/mcp/widget-contract";

/** Re-declared rather than imported, so no runtime code from apps/api reaches the bundle. */
export const WIDGET_META_KEY = "glideworth/widget";

interface ContentBlock {
  type: string;
  text?: string;
}

/** An MCP `tools/call` result as the host hands it over. */
export interface ToolResult {
  content?: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}
