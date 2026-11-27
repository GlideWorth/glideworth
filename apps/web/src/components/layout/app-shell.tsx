/**
 * The app shell: navigation (sidebar on desktop, rail on tablets, drawer + bottom bar on phones),
 * the top bar (active plan, money mode, search, theme), and everything mounted once for the whole
 * app: command palette, toasts, confirmations, shortcuts, the tour and first-run routing.
 */
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BookOpen,
  ChartArea,
  Ellipsis,
  Eye,
  EyeOff,
  Keyboard,
  LayoutDashboard,
  ListTree,
  Menu,
  MessageSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Sun,
  Wallet,
  X,
} from "lucide-react";
import { Dialog as D, DropdownMenu as M } from "radix-ui";
import { lazy, type ReactNode, type RefObject, Suspense, useEffect, useRef } from "react";
import { NotificationCentre } from "../../features/checkins/notification-centre";
import { openPalette, usePalette } from "../../features/plan-editor/components/palette-store";
import { dirtyKeys, useEditorStore } from "../../features/plan-editor/state/doc-store";
import { DemoBanner } from "../../features/demo/demo-ui";
import { useAccess } from "../../lib/access";
import { CLOUD_PUBLIC_PATHS, modeOf, useCloudSession, useMode, useSession } from "../../lib/auth";
import { cn } from "../../lib/cn";
import { openFeedback, useFeedbackAvailable } from "../../lib/feedback";
import { isDemo } from "../../lib/demo";
import { setCompactNumbers } from "../../lib/format";
import { useRestoreFocus } from "../../lib/restore-focus";
import { useSettings } from "../../lib/settings";
import { useAppearanceSync, useThemeSync } from "../../lib/theme";
import { LG, MD, useMediaQuery } from "../../lib/use-media";
import { useServerUnreachable, useWorkspace } from "../../lib/workspace";
import { usePrefs } from "../../stores/prefs";
import { useUi } from "../../stores/ui";
import { ConfirmHost } from "../ui/confirm-dialog";
import { Kbd, modKey } from "../ui/kbd";
import { Segmented } from "../ui/segmented";
import { Toaster } from "../ui/toaster";
import { Tooltip, TooltipProvider } from "../ui/tooltip";
import { ApiProblemHost } from "./api-problems-host";
import { AuthGate, Splash } from "./auth-gate";
import { GlideworthMark, Wordmark } from "./logo";
import { DATA_NAV, NAV, type NavItem, SETTINGS_NAV } from "./nav";

const DemoChanceHost = lazy(() =>
  import("../../features/demo/demo-chance-host").then((m) => ({ default: m.DemoChanceHost })),
);
import { NextSteps } from "./next-steps";
import { PlanSwitcher } from "./plan-switcher";
import { ShortcutsOverlay, useGlobalShortcuts } from "./shortcuts";
import { Tour } from "./tour";
import { toggleHideAmounts } from "../command/actions";

// ------------------------------------------------------------------------------------ navigation

export function isNavActive(item: NavItem, path: string): boolean {
  if (item.to === "/") return path === "/";
  if (item.to === "/plans") return path === "/plans";
  if (item.to === "/plans/active") return /^\/plans\/.+/.test(path);
  return path === item.to || path.startsWith(`${item.to}/`);
}

function NavLink({
  item,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const isActive = isNavActive(item, path);
  const link = (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={isActive ? "page" : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={cn(
        "group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors pointer-coarse:h-11",
        isActive
          ? "bg-surface text-ink shadow-card"
          : "text-ink-2 hover:bg-surface-2 hover:text-ink",
        collapsed && "justify-center px-0",
      )}
    >
      <item.icon
        aria-hidden
        className={cn(
          "size-4 shrink-0",
          isActive ? "text-accent" : "text-ink-3 group-hover:text-ink-2",
        )}
      />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
  return collapsed ? (
    <Tooltip content={item.label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

function NavGroups({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  return (
    <>
      {NAV.map((g) => (
        <div key={g.group} className="flex flex-col gap-0.5" data-tour={`nav-${g.group}`}>
          {collapsed ? (
            <div className="mx-auto my-1 h-px w-5 bg-border" aria-hidden />
          ) : (
            <div className="eyebrow px-2.5 pb-1">{g.group}</div>
          )}
          {g.items.map((i) => (
            <NavLink key={i.to} item={i} collapsed={collapsed} onNavigate={onNavigate} />
          ))}
        </div>
      ))}
    </>
  );
}

function Sidebar() {
  const pref = useUi((s) => s.sidebarCollapsed);
  const toggle = useUi((s) => s.toggleSidebar);
  const wide = useMediaQuery(LG);
  const collapsed = pref || !wide;
  return (
    <aside
      aria-label="Sidebar"
      data-app-chrome
      className={cn(
        "hidden shrink-0 flex-col border-r border-border bg-bg transition-[width] duration-200 md:flex",
        collapsed ? "w-[60px] pointer-coarse:w-[68px]" : "w-[220px]",
      )}
    >
      <div
        className={cn("flex h-14 shrink-0 items-center px-4", collapsed && "justify-center px-0")}
      >
        <Link
          to="/"
          aria-label="Glideworth home"
          className="flex items-center rounded-md pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center"
        >
          {collapsed ? <GlideworthMark /> : <Wordmark />}
        </Link>
      </div>
      <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-2.5 py-2" aria-label="Main">
        <NavGroups collapsed={collapsed} />
      </nav>
      <div className="flex flex-col gap-0.5 border-t border-border px-2.5 py-2">
        <div data-tour="nav-data" className="flex flex-col gap-0.5">
          <NavLink item={DATA_NAV} collapsed={collapsed} />
          <NavLink item={SETTINGS_NAV} collapsed={collapsed} />
        </div>
        {wide ? (
          <button
            type="button"
            onClick={toggle}
            className={cn(
              "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[12.5px] text-ink-3 hover:bg-surface-2 hover:text-ink-2 pointer-coarse:h-11",
              collapsed && "justify-center px-0",
            )}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-keyshortcuts="["
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
            {!collapsed && "Collapse"}
          </button>
        ) : null}
      </div>
    </aside>
  );
}

/** Phones: the full navigation in a drawer from the left. */
function NavDrawer() {
  const open = useUi((s) => s.navOpen);
  const setOpen = useUi((s) => s.setNavOpen);
  const close = () => setOpen(false);
  const restoreFocus = useRestoreFocus();
  const mode = useMode();
  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/30 data-[state=open]:animate-[glideworth-fade_140ms_ease-out]" />
        <D.Content
          {...restoreFocus}
          className="fixed inset-y-0 left-0 z-50 flex w-[min(84vw,300px)] flex-col border-r border-border bg-bg pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] shadow-pop outline-none data-[state=open]:animate-[glideworth-drawer-in_200ms_cubic-bezier(.2,.8,.2,1)]"
          aria-describedby={undefined}
        >
          <div className="flex h-14 shrink-0 items-center justify-between px-4">
            <Wordmark />
            <D.Close
              className="-mr-2 flex items-center justify-center rounded-md p-2 text-ink-3 hover:bg-surface-2 pointer-coarse:size-11"
              aria-label="Close menu"
            >
              <X className="size-4" />
            </D.Close>
          </div>
          <D.Title className="sr-only">Navigation</D.Title>
          {/* The top bar has no room for the workspace switcher on phones, so it lives here. */}
          {mode === "cloud" ? (
            <Suspense fallback={null}>
              <WorkspaceSwitcher className="px-2.5 pb-2" />
            </Suspense>
          ) : null}
          <nav
            className="flex flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-2.5 py-2"
            aria-label="Main"
          >
            <NavGroups collapsed={false} onNavigate={close} />
          </nav>
          <div className="flex flex-col gap-0.5 border-t border-border px-2.5 py-2 pb-safe">
            <NavLink item={DATA_NAV} collapsed={false} onNavigate={close} />
            <NavLink item={SETTINGS_NAV} collapsed={false} onNavigate={close} />
          </div>
          <style>
            {
              "@keyframes glideworth-drawer-in{from{transform:translateX(-24px);opacity:.5}to{transform:none;opacity:1}}@keyframes glideworth-fade{from{opacity:0}to{opacity:1}}"
            }
          </style>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

const BOTTOM: NavItem[] = [
  { to: "/", label: "Home", icon: LayoutDashboard, owner: "h" },
  { to: "/finances", label: "Finances", icon: Wallet, owner: "g" },
  { to: "/plans", label: "Plans", icon: ListTree, owner: "g" },
  { to: "/results", label: "Results", icon: ChartArea, owner: "h" },
];

/** Phones: four primary destinations plus "More" (the drawer). */
function BottomNav() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const setNavOpen = useUi((s) => s.setNavOpen);
  const inBottom = BOTTOM.some(
    (b) => isNavActive(b, path) || (b.to === "/plans" && /^\/plans\/.+/.test(path)),
  );
  return (
    <nav
      aria-label="Primary"
      data-tour="bottom-nav"
      data-app-chrome
      className="chrome-translucent fixed inset-x-0 bottom-0 z-30 border-t border-border pb-safe md:hidden"
    >
      <ul className="grid grid-cols-5">
        {BOTTOM.map((b) => {
          const active = isNavActive(b, path) || (b.to === "/plans" && /^\/plans\/.+/.test(path));
          return (
            <li key={b.to}>
              <Link
                to={b.to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-14 flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium",
                  active ? "text-accent" : "text-ink-3",
                )}
              >
                <b.icon className="size-[18px]" aria-hidden />
                {b.label}
              </Link>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            data-tour="bottom-nav-more"
            onClick={() => setNavOpen(true)}
            className={cn(
              "flex h-14 w-full flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium",
              inBottom ? "text-ink-3" : "text-accent",
            )}
            aria-label="More: all pages"
          >
            <Ellipsis className="size-[18px]" aria-hidden />
            More
          </button>
        </li>
      </ul>
    </nav>
  );
}

// ------------------------------------------------------------------------------------ top bar

function SyncStatus() {
  const { data: ws } = useWorkspace();
  const unreachable = useServerUnreachable();
  const cloud = useMode() === "cloud";
  const noWorkspace = useCloudSession()?.workspace === null;
  // Edits that could not reach the server (the editor retries them in the background).
  const unsavedError = useEditorStore((s) =>
    dirtyKeys(s).some((k) => s.save[k]?.status === "error"),
  );
  // The demo banner says what this is; the sample is not "offline".
  if (!ws || isDemo()) return null;
  // The server answered; there is just nothing in the workspace yet. Not offline.
  if (ws.source === "sample" && ws.firstRun) return null;
  // Signed in but in no workspace (the server refuses with 403): reachable, but nothing is saved.
  // The banner under the top bar explains and offers the way in.
  if (ws.source === "sample" && (noWorkspace || (cloud && ws.status === 403)))
    return (
      <Tooltip content="You are not in a workspace, so this is sample data and nothing you change is saved.">
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ochre-soft px-2 py-0.5 text-[11px] font-medium text-ochre">
          <span className="size-1.5 rounded-full bg-ochre" aria-hidden />
          <span className="hidden sm:inline">Sample data · not saved</span>
          <span className="sm:hidden">Not saved</span>
        </span>
      </Tooltip>
    );
  if (unreachable || (ws.source === "api" && unsavedError))
    return (
      <Tooltip content="Glideworth cannot reach your server right now. You are seeing the data loaded last; edits are kept in this browser and saved as soon as the server is back.">
        <span
          role="status"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ochre-soft px-2 py-0.5 text-[11px] font-medium text-ochre"
        >
          <span className="size-1.5 animate-pulse rounded-full bg-ochre" aria-hidden />
          <span className="hidden sm:inline">Server unreachable · reconnecting</span>
          <span className="sm:hidden">Reconnecting</span>
        </span>
      </Tooltip>
    );
  if (ws.source === "api")
    return (
      <Tooltip content="Connected to your Glideworth server. Changes save automatically.">
        <span className="hidden items-center gap-1.5 text-[11.5px] text-ink-3 lg:inline-flex">
          <span className="size-1.5 rounded-full bg-positive" aria-hidden />
          Saved
        </span>
      </Tooltip>
    );
  return (
    <Tooltip
      content={`The server is unavailable (${ws.error ?? "unknown"}). Showing a synthetic sample; edits stay in this browser.`}
    >
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ochre-soft px-2 py-0.5 text-[11px] font-medium text-ochre">
        <span className="size-1.5 rounded-full bg-ochre" aria-hidden />
        <span className="hidden sm:inline">Sample data · offline</span>
        <span className="sm:hidden">Offline</span>
      </span>
    </Tooltip>
  );
}

/** Viewers can look and simulate but not change anything: say so once, in the top bar. */
function ReadOnlyBadge() {
  const access = useAccess();
  if (access.loading || access.canWrite) return null;
  return (
    <Tooltip
      content={
        access.planReadOnly
          ? "This workspace is read-only until its plan is active again. You can still look, simulate and export."
          : "You have view-only access. Ask the owner for editor access to make changes."
      }
    >
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-2">
        <Eye className="size-3" aria-hidden />
        <span className="hidden sm:inline">{access.planReadOnly ? "Read-only" : "View only"}</span>
      </span>
    </Tooltip>
  );
}

function BasisToggle({ compact }: { compact?: boolean }) {
  const basis = useUi((s) => s.basis);
  const setBasis = useUi((s) => s.setBasis);
  return (
    <div data-tour="basis">
      <Segmented
        aria-label="Show amounts in"
        value={basis}
        onChange={setBasis}
        size={compact ? "sm" : "md"}
        options={[
          {
            value: "real",
            label: compact ? "Today" : "Today's money",
            title: "Today's money: adjusted for inflation (B)",
          },
          {
            value: "nominal",
            label: compact ? "Future" : "Future money",
            title: "Future money: actual amounts in each year (B)",
          },
        ]}
      />
    </div>
  );
}

/**
 * Hide amounts (privacy mode for screen sharing). Off: a plain eye icon. On: an ochre "Amounts
 * hidden" pill that stays in the top bar on every page, so nobody forgets it is on.
 */
function HideAmountsButton() {
  const hidden = useUi((s) => s.hideAmounts);
  return (
    <Tooltip
      content={
        hidden
          ? "Amounts are hidden on this device. Click to show them · ⇧H"
          : "Hide amounts, for sharing your screen · ⇧H"
      }
    >
      <button
        type="button"
        data-tour="hide-amounts"
        aria-pressed={hidden}
        aria-keyshortcuts="Shift+H"
        onClick={toggleHideAmounts}
        className={cn(
          "flex h-8 shrink-0 items-center justify-center gap-1.5 pointer-coarse:h-11 pointer-coarse:min-w-11",
          hidden
            ? "rounded-full bg-ochre-soft px-2.5 text-[12px] font-semibold text-ochre ring-1 ring-ochre/40 ring-inset hover:brightness-95"
            : "w-8 rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink",
        )}
      >
        {hidden ? (
          <>
            <EyeOff className="size-4" aria-hidden="true" />
            <span className="max-sm:sr-only">Amounts hidden</span>
          </>
        ) : (
          <>
            <Eye className="size-4" aria-hidden="true" />
            <span className="sr-only">Hide amounts</span>
          </>
        )}
      </button>
    </Tooltip>
  );
}

function ThemeButton() {
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const resolved = useThemeSync();
  return (
    <Tooltip content={`Theme: ${theme === "system" ? `system (${resolved})` : theme} · ⇧D`}>
      <button
        type="button"
        className="flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink pointer-coarse:size-11"
        aria-label={resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        onClick={() => setTheme(resolved === "dark" ? "light" : "dark")}
      >
        {resolved === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </button>
    </Tooltip>
  );
}

function TopBar() {
  const setNavOpen = useUi((s) => s.setNavOpen);
  const setShortcuts = useUi((s) => s.setShortcutsOpen);
  const md = useMediaQuery(MD);
  const mode = useMode();
  const feedback = useFeedbackAvailable();
  return (
    <header
      data-app-chrome
      className="chrome-translucent sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-5 md:gap-3"
    >
      <button
        type="button"
        data-tour="menu-button"
        onClick={() => setNavOpen(true)}
        className="-ml-1 hidden size-9 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 pointer-coarse:size-11 sm:flex md:hidden"
        aria-label="Open navigation menu"
      >
        <Menu className="size-5" />
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-2 md:flex-none">
        <span className="eyebrow hidden lg:inline">Plan</span>
        <PlanSwitcher className="w-full min-w-0 md:w-[240px]" />
        {mode === "cloud" ? (
          <Suspense fallback={null}>
            <WorkspaceSwitcher className="hidden w-[180px] min-w-0 md:block" />
          </Suspense>
        ) : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1 md:gap-2">
        <SyncStatus />
        <ReadOnlyBadge />
        <NotificationCentre />
        <button
          type="button"
          data-tour="search"
          onClick={openPalette}
          aria-keyshortcuts="Meta+K Control+K"
          className="hidden h-8 items-center gap-2 rounded-md border-border text-[12.5px] text-ink-3 hover:bg-surface-2 hover:text-ink-2 max-lg:w-8 max-lg:justify-center pointer-coarse:max-lg:size-11 sm:flex lg:w-[200px] lg:border lg:bg-surface lg:px-2.5 lg:shadow-card"
        >
          <Search className="size-4 shrink-0" />
          {/* The name is the visible text where there is any (speech input says what it sees); the
              icon-only button on small screens keeps a name of its own. */}
          <span className="sr-only lg:hidden">Search and commands</span>
          <span className="hidden flex-1 text-left lg:inline">Search or run…</span>
          <Kbd className="hidden lg:inline-flex">{modKey}K</Kbd>
        </button>
        <HideAmountsButton />
        <BasisToggle compact={!md} />
        {md ? (
          <>
            <Tooltip content="Keyboard shortcuts · ?">
              <button
                type="button"
                onClick={() => setShortcuts(true)}
                className="flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink pointer-coarse:size-11"
                aria-label="Keyboard shortcuts"
                aria-keyshortcuts="?"
              >
                <Keyboard className="size-4" />
              </button>
            </Tooltip>
            <ThemeButton />
            {feedback ? (
              <Tooltip content="Send feedback">
                <button
                  type="button"
                  onClick={() => openFeedback()}
                  className="flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink pointer-coarse:size-11"
                  aria-label="Send feedback"
                >
                  <MessageSquare className="size-4" />
                </button>
              </Tooltip>
            ) : null}
            <Tooltip content="API reference (opens a new tab)">
              <a
                href="/docs"
                target="_blank"
                rel="noreferrer"
                aria-label="API reference (opens in a new tab)"
                className="hidden size-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink pointer-coarse:size-11 lg:flex"
              >
                <BookOpen className="size-4" />
              </a>
            </Tooltip>
          </>
        ) : (
          <OverflowMenu />
        )}
      </div>
    </header>
  );
}

function OverflowMenu() {
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const setShortcuts = useUi((s) => s.setShortcutsOpen);
  const feedback = useFeedbackAvailable();
  const item =
    "flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-[13px] text-ink outline-none select-none data-[highlighted]:bg-surface-2 pointer-coarse:min-h-11";
  return (
    <M.Root>
      <M.Trigger
        data-tour="more-menu"
        className="flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 pointer-coarse:size-11"
        aria-label="More options"
      >
        <Ellipsis className="size-4" />
      </M.Trigger>
      <M.Portal>
        <M.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 min-w-[210px] rounded-lg border border-border bg-surface p-1 shadow-pop"
        >
          <M.Label className="eyebrow px-2 pt-2 pb-1">Theme</M.Label>
          <M.RadioGroup value={theme} onValueChange={(v) => setTheme(v as typeof theme)}>
            {(["system", "light", "dark"] as const).map((t) => (
              <M.RadioItem key={t} value={t} className={cn(item, "pl-7")}>
                <M.ItemIndicator className="absolute left-2.5">
                  <span className="block size-1.5 rounded-full bg-accent" />
                </M.ItemIndicator>
                {t === "system" ? "Match device" : t === "light" ? "Light" : "Dark"}
              </M.RadioItem>
            ))}
          </M.RadioGroup>
          <M.Separator className="my-1 h-px bg-border" />
          {/* Phones have no room for the search button in the top bar. */}
          <M.Item className={cn(item, "sm:hidden")} onSelect={openPalette}>
            <Search className="size-4 text-ink-3" /> Search and commands
          </M.Item>
          <M.Item className={item} onSelect={() => setShortcuts(true)}>
            <Keyboard className="size-4 text-ink-3" /> Keyboard shortcuts
          </M.Item>
          {feedback ? (
            // Opened after the menu has closed, so the menu's focus return does not land on the survey.
            <M.Item className={item} onSelect={() => setTimeout(openFeedback)}>
              <MessageSquare className="size-4 text-ink-3" /> Send feedback
            </M.Item>
          ) : null}
          <M.Item className={item} asChild>
            <a href="/docs" target="_blank" rel="noreferrer">
              <BookOpen className="size-4 text-ink-3" /> API reference
            </a>
          </M.Item>
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

// ------------------------------------------------------------------------------------ behaviours

/** The tab title follows the page heading, including a heading that changes without a new URL. */
function writeDocumentTitle(h1: Element | null | undefined) {
  const title = h1?.textContent?.trim();
  document.title = title ? `${title} · Glideworth` : "Glideworth";
  return title;
}

/**
 * Move focus to the new page's heading after navigation, and keep the document title in sync.
 * The title also follows a heading that changes in place (the guided setup steps share one URL).
 */
function useRouteFocus(mainRef: RefObject<HTMLElement | null>) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const first = useRef(true);
  const announce = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    let observed: Element | null = null;
    let headingObserver: MutationObserver | undefined;
    let structure: MutationObserver | undefined;
    const heading = () => mainRef.current?.querySelector("h1") ?? document.querySelector("main h1");
    // Re-bind when the heading element is replaced. Text edits of the current heading are watched
    // on the element itself, so the rest of the page updating does not rewrite the title.
    const watchHeading = (h1: Element | null) => {
      if (h1 === observed) return;
      headingObserver?.disconnect();
      observed = h1;
      if (!h1) return;
      writeDocumentTitle(h1);
      headingObserver = new MutationObserver(() => writeDocumentTitle(h1));
      headingObserver.observe(h1, { subtree: true, childList: true, characterData: true });
    };
    const apply = () => {
      if (cancelled) return;
      const main = mainRef.current;
      const h1 = heading();
      if (!h1 && tries++ < 12) {
        setTimeout(apply, 120);
        return;
      }
      const title = writeDocumentTitle(h1);
      if (main && !structure) {
        structure = new MutationObserver(() => watchHeading(heading()));
        structure.observe(main, { childList: true, subtree: true });
      }
      watchHeading(h1);
      if (first.current) {
        first.current = false;
        return;
      }
      if (announce.current) announce.current.textContent = title ? `${title} page` : "Page loaded";
      main?.scrollTo?.({ top: 0 });
      const target = (h1 as HTMLElement | null) ?? main;
      if (target && !target.contains(document.activeElement)) {
        if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
      }
    };
    requestAnimationFrame(apply);
    return () => {
      cancelled = true;
      structure?.disconnect();
      headingObserver?.disconnect();
    };
  }, [path, mainRef]);
  return announce;
}

/** Brand-new installs go to the welcome screen until something exists. */
function useFirstRunRedirect() {
  const { data: ws } = useWorkspace();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  useEffect(() => {
    if (!ws?.firstRun) return;
    if (path.startsWith("/welcome") || path.startsWith("/import") || path.startsWith("/settings"))
      return;
    void navigate({ to: "/welcome", replace: true });
  }, [ws?.firstRun, path, navigate]);
}

/**
 * A view-only partner lands on the plan in brief: the first time the dashboard opens in a browser session it
 * moves to /summary. The dashboard stays one click away in the sidebar.
 */
const VIEWER_LANDED = "glideworth:viewer-landed";
function useViewerLanding() {
  const access = useAccess();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const decided = useRef(false);
  const viewer = !access.loading && access.role === "viewer";
  useEffect(() => {
    // Only the first render of a session as a viewer decides; later visits to / stay on the dashboard.
    if (!viewer || decided.current) return;
    decided.current = true;
    let landed = false;
    try {
      landed = sessionStorage.getItem(VIEWER_LANDED) === "1";
      sessionStorage.setItem(VIEWER_LANDED, "1");
    } catch {
      // Storage blocked: land once per page load instead.
    }
    if (!landed && path === "/") void navigate({ to: "/summary", replace: true });
  }, [viewer, path, navigate]);
}

/** One line on every page: whose plan this is and that nothing here changes it. */
function ViewerBanner() {
  const access = useAccess();
  const { data: ws } = useWorkspace();
  if (access.loading || access.role !== "viewer" || access.planReadOnly) return null;
  const household = ws?.doc?.household.name;
  return (
    <div
      data-viewer-banner
      role="status"
      className="flex items-center gap-2 border-b border-border bg-surface-2 px-4 py-1.5 text-[12.5px] text-ink-2 sm:px-6"
    >
      <Eye className="size-3.5 shrink-0" aria-hidden />
      <span>
        You are viewing {household ? <strong className="text-ink">{household}</strong> : "this"}{" "}
        plan with view-only access. Look around and try what-ifs: nothing you do here changes the
        plan.
      </span>
    </div>
  );
}

/** Mirror the role into the UI store so editors refuse edits before they happen (viewers). */
function useReadOnlySync() {
  const access = useAccess();
  const setReadOnly = useUi((s) => s.setReadOnly);
  useEffect(
    () => setReadOnly(!access.loading && !access.canWrite, access.planReadOnly ? "plan" : "role"),
    [access.loading, access.canWrite, access.planReadOnly, setReadOnly],
  );
}

function useSettingsSync() {
  const { settings } = useSettings();
  useEffect(() => setCompactNumbers(settings.compactNumbers), [settings.compactNumbers]);
  useEffect(() => {
    if (settings.reduceMotion) useUi.getState().setReduceMotion(true);
  }, [settings.reduceMotion]);
  const chartAnimation = usePrefs((s) => s.chartAnimation);
  useEffect(() => {
    document.documentElement.dataset.chartAnimation = chartAnimation ? "on" : "off";
  }, [chartAnimation]);
}

// ------------------------------------------------------------------------------------ shell

// The palette (and the domain tables it lists) loads the first time it is opened.
const CommandPalette = lazy(() =>
  import("../../features/plan-editor/components/command-palette").then((m) => ({
    default: m.CommandPalette,
  })),
);

// Hosted ("cloud") mode only: banners, workspace switcher, suspended page. Never fetched on self-host.
const CloudBanners = lazy(() =>
  import("../../features/cloud/shell-parts").then((m) => ({ default: m.CloudBanners })),
);
const WorkspaceSwitcher = lazy(() =>
  import("../../features/cloud/shell-parts").then((m) => ({ default: m.WorkspaceSwitcher })),
);
const SuspendedPage = lazy(() =>
  import("../../features/cloud/shell-parts").then((m) => ({ default: m.SuspendedPage })),
);
const SubscribePage = lazy(() =>
  import("../../features/cloud/shell-parts").then((m) => ({ default: m.SubscribePage })),
);

/** Cmd/Ctrl+K anywhere toggles the palette; its code is fetched on first use. */
function CommandPaletteHost() {
  const loaded = usePalette((s) => s.loaded);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        usePalette.setState((s) => ({ open: !s.open, loaded: true }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return loaded ? (
    <Suspense fallback={null}>
      <CommandPalette />
    </Suspense>
  ) : null;
}

function GlobalHosts() {
  return (
    <>
      <CommandPaletteHost />
      <ShortcutsOverlay />
      <Toaster />
      <ConfirmHost />
      <ApiProblemHost />
      <Tour />
    </>
  );
}

function Frame() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const mainRef = useRef<HTMLElement>(null);
  const announce = useRouteFocus(mainRef);
  useGlobalShortcuts();
  useFirstRunRedirect();
  useSettingsSync();
  useReadOnlySync();
  useViewerLanding();
  const focusMode = path.startsWith("/welcome") && !isDemo();
  const mode = useMode();
  const access = useCloudSession()?.workspace?.access;
  const suspended = access?.level === "suspended";
  // No subscription record at all (rare: new workspaces start the no-card trial): no access until the owner subscribes.
  const notStarted = access?.level === "read_only" && access.reason === "no_subscription";
  // A suspended or not-started workspace has no data to show; only the settings stay reachable.
  const blocked = (suspended || notStarted) && !path.startsWith("/settings");

  if (focusMode && !blocked)
    return (
      <div data-app-frame className="min-h-dvh bg-bg text-ink">
        <main id="main" ref={mainRef} tabIndex={-1} className="outline-none">
          <Outlet />
        </main>
        <div ref={announce} aria-live="polite" className="sr-only" />
        <GlobalHosts />
      </div>
    );

  return (
    <div
      data-app-frame
      className="flex h-dvh overflow-hidden bg-bg pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] text-ink"
    >
      {isDemo() ? (
        <Suspense fallback={null}>
          <DemoChanceHost />
        </Suspense>
      ) : null}
      <Sidebar />
      <NavDrawer />
      <div className="flex min-w-0 flex-1 flex-col">
        {isDemo() ? <DemoBanner /> : null}
        <TopBar />
        <ViewerBanner />
        <main
          id="main"
          ref={mainRef}
          tabIndex={-1}
          data-app-main
          className="min-h-0 flex-1 overflow-y-auto pb-[calc(56px+env(safe-area-inset-bottom))] outline-none md:pb-0"
        >
          {mode === "cloud" ? (
            <Suspense fallback={null}>
              <CloudBanners />
            </Suspense>
          ) : null}
          {path === "/" && !blocked ? <NextSteps /> : null}
          {blocked ? (
            <Suspense fallback={null}>
              {notStarted ? <SubscribePage /> : <SuspendedPage />}
            </Suspense>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
      <BottomNav />
      <div ref={announce} aria-live="polite" className="sr-only" />
      <GlobalHosts />
    </div>
  );
}

/** Pages anyone can open without signing in; rendered without the app chrome. */
export const isPublicPath = (path: string, mode: "selfhost" | "cloud" = "selfhost") =>
  path.startsWith("/share/") ||
  (mode === "cloud" ? CLOUD_PUBLIC_PATHS.includes(path) : path === "/accept");

export function AppShell() {
  useAppearanceSync();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const session = useSession();
  const mode = modeOf(session.data);
  const bare = (
    <TooltipProvider>
      <Outlet />
    </TooltipProvider>
  );
  if (path.startsWith("/share/") || path === "/accept") return bare;
  if (CLOUD_PUBLIC_PATHS.includes(path)) {
    // Which mode the server runs in decides whether these pages exist at all.
    if (session.isLoading) return <Splash />;
    if (mode === "cloud") return bare;
  }
  return (
    <TooltipProvider>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <AuthGate>
        <Frame />
      </AuthGate>
    </TooltipProvider>
  );
}

export function Page({
  title,
  description,
  actions,
  children,
  eyebrow,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          {eyebrow ? <div className="eyebrow mb-1">{eyebrow}</div> : null}
          <h1
            className="display text-[24px] leading-tight font-semibold text-balance outline-none sm:text-[28px]"
            tabIndex={-1}
          >
            {title}
          </h1>
          {description ? (
            <p className="mt-1 max-w-2xl text-ink-2 text-pretty">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}
