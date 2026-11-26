/** Drag-and-drop (or click / keyboard) file chooser. Files are read locally with FileReader. */
import { FileUp } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { cn } from "../../lib/cn";

export interface PickedFile {
  name: string;
  size: number;
  text: string;
}

export function readFileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error ?? new Error("could not read the file"));
    r.readAsText(file);
  });
}

export function formatBytes(n: number, locale?: string): string {
  const units = ["B", "KB", "MB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: i ? 1 : 0 }).format(v)} ${units[i]}`;
}

export function FileDrop({
  accept,
  onFile,
  title,
  hint,
  busy,
  className,
  maxBytes = 25 * 1024 * 1024,
  maxChars,
  refuse,
}: {
  accept: string;
  onFile: (f: PickedFile) => void;
  title: ReactNode;
  hint?: ReactNode;
  busy?: boolean;
  className?: string;
  maxBytes?: number;
  /** A limit on the file's text, checked once it is read, with the message shown when it is over. */
  maxChars?: { chars: number; message: (size: string) => string };
  /** After the file is read: return a message to refuse it, or null to accept it. */
  refuse?: (file: PickedFile) => string | null;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const take = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > maxBytes) {
      setError(`That file is ${formatBytes(file.size)}; the limit is ${formatBytes(maxBytes)}.`);
      return;
    }
    try {
      const text = await readFileText(file);
      if (maxChars && text.length > maxChars.chars) {
        setError(maxChars.message(formatBytes(file.size)));
        return;
      }
      const picked = { name: file.name, size: file.size, text };
      const refused = refuse?.(picked);
      if (refused) {
        setError(refused);
        return;
      }
      onFile(picked);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className={className}>
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- drop zone; the file input inside is the keyboard path */}
      <label
        htmlFor={id}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void take(e.dataTransfer.files[0]);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
          "focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/20",
          over
            ? "border-accent bg-accent-soft/50"
            : "border-border-strong bg-surface hover:border-accent/60",
          busy && "pointer-events-none opacity-60",
        )}
      >
        <span className="flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent">
          <FileUp className="size-5" aria-hidden />
        </span>
        <span className="text-[14px] font-semibold text-ink">{title}</span>
        <span className="text-[12.5px] text-ink-3">
          Drop the file here, or{" "}
          <span className="font-medium text-accent underline underline-offset-2">choose one</span>
        </span>
        {hint ? <span className="max-w-md text-[12px] text-ink-3">{hint}</span> : null}
        <input
          ref={input}
          id={id}
          type="file"
          accept={accept}
          className="sr-only"
          onChange={(e) => {
            void take(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </label>
      {error ? (
        <p role="alert" className="mt-2 text-[12.5px] text-negative">
          {error}
        </p>
      ) : null}
    </div>
  );
}
