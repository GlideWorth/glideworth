import {
  Activity,
  Bot,
  Building2,
  Code2,
  CreditCard,
  Database,
  History,
  Info,
  KeyRound,
  type LucideIcon,
  Palette,
  Plug,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  Users,
  Webhook,
} from "lucide-react";
import type { AppMode } from "../../lib/auth";

export interface SettingsSection {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  group:
    | "You"
    | "Planning"
    | "People"
    | "Data"
    | "Developers"
    | "Glideworth"
    | "Account"
    | "Workspace";
  keywords: string;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: "profile",
    label: "Profile & locale",
    description: "Currency, number and date formats, tax year.",
    icon: UserRound,
    group: "You",
    keywords: "currency locale language region date number format tax year",
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Theme, density, motion and chart preferences.",
    icon: Palette,
    group: "You",
    keywords:
      "theme dark light density compact charts animation colour blind patterns transparency motion",
  },
  {
    id: "planning",
    label: "Planning defaults",
    description:
      "New-plan assumptions, spending and tax definitions, simulation and success bands.",
    icon: SlidersHorizontal,
    group: "Planning",
    keywords:
      "defaults inflation returns monte carlo workers seed trials success bands spending tax snapshot",
  },
  {
    id: "checkins",
    label: "Check-ins",
    description: "Scheduled plan health checks and what triggers a notification.",
    icon: Activity,
    group: "Planning",
    keywords: "check-in schedule health notifications alerts cadence success rate milestone slip",
  },
  {
    id: "sharing",
    label: "Share links",
    description: "Read-only links to a plan’s results, with amounts shown or hidden.",
    icon: Share2,
    group: "People",
    keywords: "share link adviser read-only public revoke expire hide amounts",
  },
  {
    id: "people",
    label: "People & access",
    description: "Invite a partner or adviser; roles, invites and passphrase resets.",
    icon: Users,
    group: "People",
    keywords: "users people invite role owner editor viewer partner adviser reset passphrase",
  },
  {
    id: "apps",
    label: "Connected apps",
    description: "Assistants and apps you allowed to connect (OAuth).",
    icon: Plug,
    group: "People",
    keywords: "oauth connected apps grants clients mcp assistant revoke",
  },
  {
    id: "audit",
    label: "Audit log",
    description: "Who changed what, and through which door.",
    icon: History,
    group: "People",
    keywords: "audit log history who changed activity security",
  },
  {
    id: "data",
    label: "Data",
    description: "Export, import, restore and delete.",
    icon: Database,
    group: "Data",
    keywords: "export import backup restore delete erase",
  },
  {
    id: "keys",
    label: "API keys",
    description: "Scoped keys for scripts and integrations.",
    icon: KeyRound,
    group: "Developers",
    keywords: "api key token scopes revoke",
  },
  {
    id: "webhooks",
    label: "Webhooks",
    description: "Signed events sent to your own endpoints.",
    icon: Webhook,
    group: "Developers",
    keywords: "webhook events deliveries signing secret",
  },
  {
    id: "ai",
    label: "AI & integrations",
    description: "Connect Claude and other MCP clients.",
    icon: Bot,
    group: "Developers",
    keywords: "mcp claude ai assistant integration desktop code connect",
  },
  {
    id: "about",
    label: "About",
    description: "Versions, tax data years and sources.",
    icon: Info,
    group: "Glideworth",
    keywords: "version engine schema tax data sources licence",
  },
];

/**
 * Hosted ("cloud") mode only. Their bodies live in features/cloud (lazy); these entries are metadata
 * (navigation, the command palette) and are never listed on a self-host server.
 */
export const CLOUD_SECTIONS: SettingsSection[] = [
  {
    id: "account",
    label: "Account",
    description: "Your name, email address, sign-in alerts, your data and deleting your account.",
    icon: UserRound,
    group: "Account",
    keywords: "account name email change alerts download personal data delete close",
  },
  {
    id: "security",
    label: "Security",
    description: "Password, two-factor sign-in, recovery codes and signed-in browsers.",
    icon: ShieldCheck,
    group: "Account",
    keywords: "password two-factor 2fa totp authenticator recovery codes sessions devices sign out",
  },
  {
    id: "workspace",
    label: "Workspace",
    description: "Name, AI assistant changes, support access, export and deletion.",
    icon: Building2,
    group: "Workspace",
    keywords: "workspace rename ai assistants mcp support access export delete",
  },
  {
    id: "members",
    label: "Members",
    description: "Invite people, change roles, transfer ownership or leave.",
    icon: Users,
    group: "Workspace",
    keywords: "members invite invitation role owner editor viewer remove transfer leave seats",
  },
  {
    id: "billing",
    label: "Billing",
    description: "Your plan, trial, subscription and invoices.",
    icon: CreditCard,
    group: "Workspace",
    keywords: "billing plan subscription trial price invoice card stripe cancel refund",
  },
];
export const CLOUD_SECTION_IDS: readonly string[] = CLOUD_SECTIONS.map((s) => s.id);

/**
 * The sections a mode shows. Cloud replaces "People & access" (the passphrase household) with the
 * account, security, members and billing screens.
 */
export const sectionsForMode = (mode: AppMode): SettingsSection[] =>
  mode === "cloud"
    ? [...CLOUD_SECTIONS, ...SETTINGS_SECTIONS.filter((s) => s.id !== "people")]
    : SETTINGS_SECTIONS;

export const DEVELOPER_DOCS_ICON = Code2;

/**
 * The section for a settings URL. `/settings` (no id) opens the mode's first section. An id this
 * mode does not list is not a page: callers show the 404 instead of falling back to another section.
 */
export const settingsSection = (
  id: string | undefined,
  mode: AppMode = "selfhost",
): SettingsSection | undefined => {
  const list = sectionsForMode(mode);
  if (id === undefined) return list[0];
  return list.find((s) => s.id === id);
};
