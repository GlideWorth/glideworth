/** Full-document JSON export and re-import. Exports round-trip exactly (modulo the `exportedAt` stamp). */
import {
  type GlideworthDocument,
  migrateDocument,
  SCHEMA_VERSION,
  ValidationError,
} from "@glideworth/core";
import { detectProjectionLabExport } from "../projectionlab/index.js";

/** Serialise a document for backup/export. `exportedAt` is a file stamp, not document content. */
export function exportDocument(doc: GlideworthDocument, now: Date): string {
  return JSON.stringify(
    { ...doc, app: "glideworth", schemaVersion: SCHEMA_VERSION, exportedAt: now.toISOString() },
    null,
    2,
  );
}

export interface ParsedExport {
  /** The document, migrated to the current schema version, without the `exportedAt` stamp. */
  document: GlideworthDocument;
  exportedAt?: string;
  /** Schema version the file was written with, before migration. */
  fromSchemaVersion: number;
}

/** Parse an exported document (any supported schema version). Throws ValidationError. */
export function parseExportedDocument(text: string): ParsedExport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ValidationError("export is not valid JSON", {
      cause: e instanceof Error ? e.message : String(e),
    });
  }
  if (detectProjectionLabExport(raw)) {
    throw new ValidationError("this is a ProjectionLab export; use importProjectionLab instead");
  }
  const from =
    typeof (raw as { schemaVersion?: unknown })?.schemaVersion === "number"
      ? (raw as { schemaVersion: number }).schemaVersion
      : 0;
  const document = migrateDocument(raw);
  const exportedAt = document.exportedAt;
  const { exportedAt: _drop, ...rest } = document;
  void _drop;
  return { document: rest as GlideworthDocument, exportedAt, fromSchemaVersion: from };
}
