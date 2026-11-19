/** Import & export centre: ProjectionLab migration, CSV imports, backup / tables / restore. */
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { Page } from "../../components/layout/app-shell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { CsvImport } from "./csv-import";
import { BackupCard, RestoreCard, TablesCard } from "./data-export";
import { ProjectionLabImport } from "./pl-import";

const TABS = ["projectionlab", "csv", "backup"] as const;
type Tab = (typeof TABS)[number];

export function ImportPage() {
  const search = useSearch({ strict: false }) as { tab?: string };
  const navigate = useNavigate();
  const tab: Tab = TABS.includes(search.tab as Tab) ? (search.tab as Tab) : "projectionlab";
  return (
    <Page
      title="Import & export"
      description={
        <span className="inline-flex items-start gap-1.5">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
          Files are read in this browser. Only what you choose to import is saved, to your own
          Glideworth server.
        </span>
      }
    >
      <Tabs
        value={tab}
        onValueChange={(t) => void navigate({ to: "/import", search: { tab: t }, replace: true })}
        className="flex flex-col gap-5"
      >
        <TabsList aria-label="Import and export" className="overflow-x-auto">
          <TabsTrigger value="projectionlab">From ProjectionLab</TabsTrigger>
          <TabsTrigger value="csv">CSV files</TabsTrigger>
          <TabsTrigger value="backup">Backup & export</TabsTrigger>
        </TabsList>
        <TabsContent value="projectionlab">
          <ProjectionLabImport />
        </TabsContent>
        <TabsContent value="csv">
          <CsvImport />
        </TabsContent>
        <TabsContent value="backup" className="grid gap-5 lg:grid-cols-2">
          <BackupCard />
          <RestoreCard />
          <div className="lg:col-span-2">
            <TablesCard />
          </div>
        </TabsContent>
      </Tabs>
    </Page>
  );
}
