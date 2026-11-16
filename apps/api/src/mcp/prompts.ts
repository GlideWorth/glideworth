import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpContext } from "./server.js";

const user = (text: string) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
});

export function registerPrompts(server: McpServer, ctx: McpContext): void {
  const planArg = z.string().optional().describe("Plan id (default: the main plan).");
  const pick = (id?: string) =>
    id ??
    ctx.services.plans.list({ status: "active" }).find((p) => p.isMain)?.id ??
    ctx.services.plans.list({ status: "active" })[0]?.id ??
    "<planId>";

  server.registerPrompt(
    "review_my_plan",
    {
      title: "Review my plan",
      description:
        "A structured review: outcome, assumptions, risks and the three most useful changes.",
      argsSchema: { planId: planArg },
    },
    ({ planId }) => {
      const id = pick(planId);
      return user(
        `Review my retirement plan (planId "${id}").\n\n` +
          "1. Call get_plan_summary to see the plan and its deterministic outcome.\n" +
          "2. Call run_monte_carlo for the chance of success, and audit_plan for modelling mistakes.\n" +
          "3. Call explain_projection (and sensitivity) to find what drives the result.\n" +
          "4. Report: headline outcome (success rate, first shortfall year if any, end net worth in today's money), the top risks, any audit findings, and the three most valuable changes with their estimated effect (use preview_changes to quantify).\n" +
          "Do not change anything. Money is in major currency units; quote figures in today's money.",
      );
    },
  );
  server.registerPrompt(
    "can_i_retire_earlier",
    {
      title: "Can I retire earlier?",
      description: "Find the earliest retirement date that still meets a target success rate.",
      argsSchema: {
        planId: planArg,
        targetSuccessRate: z.string().optional().describe("e.g. 0.85 (default 0.85)"),
      },
    },
    ({ planId, targetSuccessRate }) => {
      const id = pick(planId);
      return user(
        `Can I retire earlier? Plan "${id}", target success rate ${targetSuccessRate ?? "0.85"}.\n\n` +
          "1. get_plan_summary: find the retirement milestone id and the current retirement date.\n" +
          "2. solve_retirement_date with that milestoneId and the target success rate; quote `answer`.\n" +
          "3. Explain the trade-off (what the plan gives up) with run_monte_carlo on a branch or sensitivity.\n" +
          "4. If the answer is earlier than today's plan, offer to save it: preview_whatif early-retirement with params {years: N} then create_branch_from_template, so the user can explore it without touching the main plan. Do not change the main plan without asking.",
      );
    },
  );
  server.registerPrompt(
    "retire_earlier_as_branch",
    {
      title: "Retire N years earlier, as a branch",
      description: "Show the difference of retiring earlier and save the scenario as a branch.",
      argsSchema: { planId: planArg, years: z.string().describe("How many years earlier, e.g. 3") },
    },
    ({ planId, years }) =>
      user(
        `What if I retire ${years} years earlier? Plan "${pick(planId)}".\n\n` +
          `1. preview_whatif { templateId: "early-retirement", params: { years: ${years} } } to see the ops and before/after.\n` +
          "2. create_branch_from_template with the same arguments and a clear name (needs write access): the main plan is untouched.\n" +
          "3. run_monte_carlo on the main plan and on the new branch, then compare_plans { planIds: [main, branch], explain: true }.\n" +
          "4. Report the difference in chance of success, end net worth and first shortfall year, in today's money, and say the branch id.",
      ),
  );
  server.registerPrompt(
    "how_much_can_i_spend",
    {
      title: "How much can I spend?",
      description: "The most I can spend per year while keeping a target chance of success.",
      argsSchema: {
        planId: planArg,
        targetSuccessRate: z.string().optional().describe("e.g. 0.9 (default 0.85)"),
      },
    },
    ({ planId, targetSuccessRate }) =>
      user(
        `What is the most I can spend, keeping a ${targetSuccessRate ?? "0.85"} chance of success? Plan "${pick(planId)}".\n\n` +
          "1. solve_max_spending with targetSuccessRate; quote `answer` (money per year) and details.currentAnnualSpending.\n" +
          "2. If asked to apply it: preview_changes with the returned `ops`, then propose_change_set; apply only after the user agrees.",
      ),
  );
  server.registerPrompt(
    "why_might_my_plan_fail",
    {
      title: "Chance of success and why it fails",
      description: "The chance of success, and when and why the failures happen.",
      argsSchema: { planId: planArg },
    },
    ({ planId }) =>
      user(
        `What is my chance of success, and why does the plan fail when it fails? Plan "${pick(planId)}".\n\n` +
          "1. run_monte_carlo: quote the headline. If it can fail, read failureAnalysis (failure years, sequence risk, before/after retirement).\n" +
          "2. explain_year on the earliest failure year (and explain_projection) to say what ran short.\n" +
          "3. sensitivity to show which assumptions matter most; show two example changes to the inputs and quantify them with preview_changes.",
      ),
  );
  server.registerPrompt(
    "check_my_assumptions",
    {
      title: "Review my assumptions and show what changing the top finding would do",
      description:
        "Audit the plan and show how changing the most important finding would change the results.",
      argsSchema: { planId: planArg },
    },
    ({ planId }) =>
      user(
        `Review the assumptions in my plan "${pick(planId)}" and show the effect of changing the most important one.\n\n` +
          "1. audit_plan: list the findings by severity.\n" +
          "2. Take the top finding that has a suggested change (`fix`); preview_changes with fix.patch and report before and after.\n" +
          "3. propose_change_set with those ops (summary = the finding title); show the user the changes, and apply_change_set only after they agree.",
      ),
  );
  server.registerPrompt(
    "what_if_spending",
    {
      title: "What if I spend more or less?",
      description: "Quantify the effect of changing spending.",
      argsSchema: {
        planId: planArg,
        change: z.string().describe('e.g. "+500/month on dining" or "-10% overall"'),
      },
    },
    ({ planId, change }) =>
      user(
        `What happens to my plan "${pick(planId)}" if I change spending: ${change}?\n\n` +
          "1. get_plan_summary to find the right expense ids and their current amounts/frequency (watch monthly vs yearly).\n" +
          "2. preview_changes with the equivalent ops (replace the amount value; keep the basis).\n" +
          "3. Report before/after: success, first shortfall year, end net worth (today's money). Then run_monte_carlo on a branch if the user wants chance of success (create_branch, then run_monte_carlo on the branch).",
      ),
  );
  server.registerPrompt(
    "monthly_checkin",
    {
      title: "Monthly check-in",
      description: "Update balances, record a snapshot and compare against the plan.",
      argsSchema: { householdId: z.string().optional() },
    },
    ({ householdId }) =>
      user(
        `Run my monthly check-in${householdId ? ` for household "${householdId}"` : ""}.\n\n` +
          "1. list_accounts, then ask me for the current balance of each account (or use values I paste).\n" +
          "2. update_account_balances with the new balances (records a progress snapshot).\n" +
          "3. list_progress_snapshots to compare with previous months, then get_plan_summary / run_monte_carlo to see whether the plan is still on track. Summarise in a few sentences.",
      ),
  );
}
