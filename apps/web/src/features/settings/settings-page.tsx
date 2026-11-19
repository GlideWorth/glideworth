/**
 * Settings: one page, sectioned (deep-linkable at /settings/<section>). Durable settings save to
 * the API as you change them; device-only preferences are marked with a laptop icon.
 */
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type JSX, lazy, Suspense } from "react";
import { Page } from "../../components/layout/app-shell";
import { NotFound } from "../../components/layout/route-states";
import { Select } from "../../components/ui/select";
import { useCloudSession, useMode } from "../../lib/auth";
import { cn } from "../../lib/cn";
import { serverReachable, useWorkspace } from "../../lib/workspace";
import { ShareLinksPanel } from "../share/share-links";
import { AboutSection } from "./about-section";
import { AiSection } from "./ai-section";
import { AppearanceSection } from "./appearance-section";
import { CheckinsSection } from "./checkins-section";
import { DataSection } from "./data-section";
import { KeysSection } from "./keys-section";
import { AuditSection, ConnectedAppsSection, PeopleSection } from "./people-section";
import { PlanningSection } from "./planning-section";
import { ProfileSection } from "./profile-section";
import { CLOUD_SECTION_IDS, sectionsForMode, settingsSection } from "./sections";
import { SectionIntro, SettingsGroup } from "./settings-ui";
import { WebhooksSection } from "./webhooks-section";

function SharingSection() {
  return (
    <>
      <SectionIntro title="Share links">
        Every read-only link you have made, for every plan. Create new ones from a plan&rsquo;s menu
        on the Plans page or from Results.
      </SectionIntro>
      <SettingsGroup title="Links">
        <div className="px-5 py-4">
          <ShareLinksPanel />
        </div>
      </SettingsGroup>
    </>
  );
}

// Hosted-mode screens: fetched only when a cloud section is opened (never on a self-host server).
const CloudSettings = lazy(() => import("../cloud/settings-sections"));

const BODY: Record<string, () => JSX.Element> = {
  profile: ProfileSection,
  appearance: AppearanceSection,
  planning: PlanningSection,
  checkins: CheckinsSection,
  sharing: SharingSection,
  people: PeopleSection,
  apps: ConnectedAppsSection,
  audit: AuditSection,
  data: DataSection,
  keys: KeysSection,
  webhooks: WebhooksSection,
  ai: AiSection,
  about: AboutSection,
};

function CloudSectionPending() {
  return (
    <div role="status" aria-busy="true" className="h-40 animate-pulse rounded-xl bg-surface-2">
      <span className="sr-only">Loading</span>
    </div>
  );
}

export function SettingsPage() {
  const params = useParams({ strict: false }) as { section?: string };
  const navigate = useNavigate();
  const mode = useMode();
  const sections = sectionsForMode(mode);
  const current = settingsSection(params.section, mode);
  const { data: ws, isPending } = useWorkspace();
  const noWorkspace = useCloudSession()?.workspace === null;
  // Unknown ids (and a hosted section on a self-host server) are not this page.
  if (!current) return <NotFound />;
  const isCloudSection = CLOUD_SECTION_IDS.includes(current.id);
  const Body = BODY[current.id] ?? ProfileSection;
  const groups = [...new Set(sections.map((s) => s.group))];
  // `persisted !== "api"` used to mean "offline", including while the workspace was still loading
  // and while a new workspace had no household yet. Only a failed request is an outage.
  const description = !ws
    ? isPending
      ? "Loading your settings…"
      : "The server is offline: settings are kept in this browser until it is back."
    : noWorkspace || (mode === "cloud" && ws.status === 403)
      ? "You are not in a workspace, so settings are kept in this browser only."
      : ws.firstRun
        ? "Nothing is set up yet, so settings are kept in this browser for now."
        : serverReachable(ws)
          ? "Changes save as you make them."
          : "The server is offline: settings are kept in this browser until it is back.";
  return (
    <Page title="Settings" description={description}>
      <div className="grid gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
        <div className="md:hidden">
          <Select
            aria-label="Settings section"
            value={current.id}
            onValueChange={(section) =>
              void navigate({ to: "/settings/$section", params: { section } })
            }
            options={sections.map((s) => ({
              value: s.id,
              label: s.label,
              hint: s.description,
            }))}
          />
        </div>
        <nav aria-label="Settings sections" className="hidden md:block">
          <div className="sticky top-4 flex flex-col gap-4">
            {groups.map((g) => (
              <div key={g} className="flex flex-col gap-0.5">
                <div className="eyebrow px-2.5 pb-1">{g}</div>
                {sections
                  .filter((s) => s.group === g)
                  .map((s) => {
                    const active = s.id === current.id;
                    return (
                      <Link
                        key={s.id}
                        to="/settings/$section"
                        params={{ section: s.id }}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors pointer-coarse:h-11",
                          active
                            ? "bg-surface text-ink shadow-card"
                            : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                        )}
                      >
                        <s.icon
                          className={cn("size-4", active ? "text-accent" : "text-ink-3")}
                          aria-hidden
                        />
                        {s.label}
                      </Link>
                    );
                  })}
              </div>
            ))}
          </div>
        </nav>
        <div className="flex min-w-0 flex-col gap-5">
          {isCloudSection ? (
            <Suspense fallback={<CloudSectionPending />}>
              <CloudSettings section={current.id} />
            </Suspense>
          ) : (
            <Body />
          )}
        </div>
      </div>
    </Page>
  );
}
