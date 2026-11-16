/**
 * Colour + icon for people, plans and entities. Colours are design-token names (schema rule:
 * Appearance.color is a token, never a hex), resolved to the chart palette so they follow theme.
 */
import {
  Anchor,
  Bike,
  Briefcase,
  Check,
  Coffee,
  Compass,
  Flag,
  Gem,
  GraduationCap,
  Heart,
  House,
  Landmark,
  Leaf,
  type LucideIcon,
  Moon,
  Mountain,
  PiggyBank,
  Plane,
  Sailboat,
  Smile,
  Sprout,
  Star,
  Sun,
  Tent,
  User,
  UserRound,
} from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "../../lib/cn";

export const APPEARANCE_COLORS: { id: string; label: string; cssVar: string }[] = [
  { id: "spruce", label: "Spruce", cssVar: "--chart-1" },
  { id: "slate", label: "Slate", cssVar: "--chart-2" },
  { id: "ochre", label: "Ochre", cssVar: "--chart-3" },
  { id: "clay", label: "Clay", cssVar: "--chart-4" },
  { id: "sage", label: "Sage", cssVar: "--chart-5" },
  { id: "plum", label: "Plum", cssVar: "--chart-6" },
  { id: "sand", label: "Sand", cssVar: "--chart-7" },
  { id: "stone", label: "Stone", cssVar: "--chart-8" },
];
const ALIASES: Record<string, string> = { moss: "spruce", rust: "clay", ember: "clay" };

export const APPEARANCE_ICONS: Record<string, LucideIcon> = {
  user: User,
  "user-round": UserRound,
  smile: Smile,
  sun: Sun,
  moon: Moon,
  star: Star,
  leaf: Leaf,
  sprout: Sprout,
  mountain: Mountain,
  compass: Compass,
  anchor: Anchor,
  heart: Heart,
  house: House,
  briefcase: Briefcase,
  plane: Plane,
  "graduation-cap": GraduationCap,
  "piggy-bank": PiggyBank,
  landmark: Landmark,
  flag: Flag,
  tent: Tent,
  sailboat: Sailboat,
  bike: Bike,
  coffee: Coffee,
  gem: Gem,
};

/** CSS colour for a token name; falls back by index so un-styled items still differ. */
export function appearanceColor(color: string | undefined, fallbackIndex = 0): string {
  const id = color ? (ALIASES[color] ?? color) : undefined;
  const c =
    APPEARANCE_COLORS.find((x) => x.id === id) ??
    APPEARANCE_COLORS[fallbackIndex % APPEARANCE_COLORS.length]!;
  return `var(${c.cssVar})`;
}

export function AppearanceDot({
  appearance,
  fallbackIndex = 0,
  fallbackIcon,
  size = 24,
  label,
  className,
}: {
  appearance?: { color?: string; icon?: string };
  fallbackIndex?: number;
  fallbackIcon?: LucideIcon;
  size?: number;
  label?: string;
  className?: string;
}) {
  const Icon = (appearance?.icon && APPEARANCE_ICONS[appearance.icon]) || fallbackIcon;
  const color = appearanceColor(appearance?.color, fallbackIndex);
  return (
    <span
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full", className)}
      style={
        {
          width: size,
          height: size,
          background: `color-mix(in oklab, ${color} 18%, transparent)`,
          color,
          boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 35%, transparent)`,
        } as CSSProperties
      }
    >
      {Icon ? (
        <Icon style={{ width: size * 0.55, height: size * 0.55 }} />
      ) : (
        <span
          className="rounded-full"
          style={{ width: size * 0.36, height: size * 0.36, background: color }}
        />
      )}
    </span>
  );
}

export function AppearancePicker({
  value,
  onChange,
  showIcons = true,
  fallbackIndex = 0,
}: {
  value: { color?: string; icon?: string } | undefined;
  onChange: (v: { color?: string; icon?: string }) => void;
  showIcons?: boolean;
  fallbackIndex?: number;
}) {
  const current = value?.color
    ? (ALIASES[value.color] ?? value.color)
    : APPEARANCE_COLORS[fallbackIndex % 8]!.id;
  return (
    <div className="flex flex-col gap-2.5">
      <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-1.5">
        {APPEARANCE_COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={current === c.id}
            aria-label={c.label}
            title={c.label}
            onClick={() => onChange({ ...value, color: c.id })}
            className="flex size-6 items-center justify-center rounded-full ring-offset-2 ring-offset-surface transition-shadow focus-visible:ring-2 focus-visible:ring-focus aria-checked:ring-2 aria-checked:ring-ink/40"
            style={{ background: `var(${c.cssVar})` }}
          >
            {current === c.id ? (
              <Check className="size-3.5 text-white mix-blend-luminosity" />
            ) : null}
          </button>
        ))}
      </div>
      {showIcons ? (
        <div role="radiogroup" aria-label="Icon" className="flex flex-wrap gap-1">
          {Object.entries(APPEARANCE_ICONS).map(([id, Icon]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={value?.icon === id}
              aria-label={id.replace("-", " ")}
              onClick={() => onChange({ ...value, icon: value?.icon === id ? undefined : id })}
              className={cn(
                "flex size-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink",
                value?.icon === id && "bg-accent-soft text-accent",
              )}
            >
              <Icon className="size-3.5" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
