/** Building blocks shared by the settings sections: a titled group and a label/control row. */
import { Cloud, Laptop } from "lucide-react";
import { type ReactNode, useId } from "react";
import { Tooltip } from "../../components/ui/tooltip";
import { cn } from "../../lib/cn";

export function SettingsGroup({
  title,
  description,
  children,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-[var(--radius-card)] border border-border bg-surface shadow-card",
        className,
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
          {description ? <p className="mt-0.5 text-[12.5px] text-ink-3">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

/** One setting: label + help on the left, the control on the right (stacked on phones). */
export function SettingRow({
  label,
  hint,
  children,
  where,
  htmlFor,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  /** Where the value is stored, shown as a small icon. */
  where?: "server" | "device";
  htmlFor?: string;
  className?: string;
}) {
  const fallback = useId();
  const id = htmlFor ?? fallback;
  return (
    <div
      className={cn(
        "flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center sm:gap-6",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <label htmlFor={id} className="text-[13px] font-medium text-ink">
            {label}
          </label>
          {where ? <StoredWhere where={where} /> : null}
        </div>
        {hint ? <p className="mt-0.5 text-[12px] leading-relaxed text-ink-3">{hint}</p> : null}
      </div>
      <div className="shrink-0 sm:max-w-[60%]">{children}</div>
    </div>
  );
}

export function StoredWhere({ where }: { where: "server" | "device" }) {
  return (
    <Tooltip
      content={
        where === "server"
          ? "Saved to your Glideworth server: follows you to every device"
          : "Saved on this device only"
      }
    >
      <span
        className="inline-flex text-ink-3"
        role="img"
        aria-label={where === "server" ? "Saved to your Glideworth server" : "Saved on this device"}
      >
        {where === "server" ? <Cloud className="size-3" /> : <Laptop className="size-3" />}
      </span>
    </Tooltip>
  );
}

export function SectionIntro({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-1">
      <h2 className="display text-[22px] leading-tight font-semibold">{title}</h2>
      {children ? <p className="mt-1 max-w-2xl text-[13px] text-ink-2">{children}</p> : null}
    </div>
  );
}

export function CodeBlock({ children, label }: { children: string; label?: string }) {
  return (
    <pre
      title={label}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable code must be reachable by keyboard
      tabIndex={0}
      className="overflow-x-auto rounded-lg border border-border bg-surface-2 px-3.5 py-3 font-mono text-[11.5px] leading-relaxed whitespace-pre text-ink"
    >
      {children}
    </pre>
  );
}
