/**
 * The hosted-mode settings screens, as one lazy chunk: the settings page renders `<CloudSettings
 * section="billing" />` and nothing from here is fetched on a self-host server.
 */
import { AccountSection } from "./settings/account-section";
import { BillingSection } from "./settings/billing-section";
import { MembersSection } from "./settings/members-section";
import { SecuritySection } from "./settings/security-section";
import { WorkspaceSection } from "./settings/workspace-section";

export default function CloudSettings({ section }: { section: string }) {
  switch (section) {
    case "account":
      return <AccountSection />;
    case "security":
      return <SecuritySection />;
    case "workspace":
      return <WorkspaceSection />;
    case "members":
      return <MembersSection />;
    case "billing":
      return <BillingSection />;
    default:
      return null;
  }
}
