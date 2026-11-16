/**
 * Key-path coverage for ProjectionLab exports.
 *
 * Every key path in a source file (array indexes collapsed to `[]`) is matched against RULES and
 * classified:
 *   mapped       carried into the Glideworth document (possibly approximated; see mapping doc)
 *   ignored      intentionally not carried over (UI state, derived values, redundant copies, secrets)
 *   unsupported  real planning content with no home in the Glideworth schema yet
 *   unknown      no rule matches (a field from a newer export version): reported as an issue
 *
 * The same table generates docs/projectionlab-mapping.md (see scripts/gen-mapping-doc.ts).
 * Paths are structure only. No values are ever read here except to decide whether an unsupported
 * field is "set" (non-default), which only influences issue severity.
 */
import type { CoverageEntry, CoverageStatus, ImportCoverage } from "../types.js";
import { isObj } from "../util/read.js";

export interface Rule {
  /** `$.a.b[].c`; `*` = any single key; trailing `.**` = any descendants. */
  pattern: string;
  status: Exclude<CoverageStatus, "unknown">;
  /** Glideworth destination (mapped) or suggested schema field (unsupported). */
  target?: string;
  note?: string;
}

const M = (pattern: string, target: string, note?: string): Rule => ({
  pattern,
  status: "mapped",
  target,
  note,
});
const I = (pattern: string, note: string): Rule => ({ pattern, status: "ignored", note });
const _U = (pattern: string, target: string, note?: string): Rule => ({
  pattern,
  status: "unsupported",
  target,
  note,
});

/** A date reference object `{type, value, modifier}` at `prefix`. */
function dateRef(prefix: string, target: string, note?: string): Rule[] {
  return [
    M(prefix, target, note),
    M(`${prefix}.type`, target, note),
    M(`${prefix}.value`, target, note),
    M(`${prefix}.modifier`, target, note),
  ];
}

/** A `{type:'%'|'today$', data:[{x,y}]}` custom time series. */
function customSeries(prefix: string, target: string): Rule[] {
  return [
    M(prefix, target),
    M(`${prefix}.type`, target),
    M(`${prefix}.data`, target),
    M(`${prefix}.data[]`, target),
    M(`${prefix}.data[].x`, target),
    M(`${prefix}.data[].y`, target),
  ];
}

const UI_ITEM = "view or layout state; not planning data";
const REDUNDANT =
  "redundant copy of the Current Finances value; divergence is reported as an issue";

/** Account object shape shared by today.savingsAccounts[], today.investmentAccounts[] and plan account events. */
function accountRules(prefix: string, t: string, planLevel: boolean): Rule[] {
  const b = `${t}.behaviour`;
  const rules: Rule[] = [
    M(prefix, t),
    M(`${prefix}.id`, `${t}.id`),
    M(`${prefix}.name`, `${t}.name`),
    M(`${prefix}.title`, `${t}.name`, "used when `name` is absent"),
    M(`${prefix}.subtitle`, `${t}.notes`),
    M(`${prefix}.icon`, `${t}.appearance.icon`),
    M(`${prefix}.color`, `${t}.appearance.color`, "ProjectionLab colour name stored verbatim"),
    M(`${prefix}.type`, `${t}.type`, "unknown types become `other` with a warning"),
    M(`${prefix}.owner`, `${t}.owner`, "me -> primary, spouse -> partner, joint -> joint"),
    M(`${prefix}.balance`, `${t}.balance`),
    M(`${prefix}.costBasis`, `${t}.costBasis`),
    M(`${prefix}.liquid`, `${b}.liquid`),
    M(`${prefix}.withdraw`, `${b}.withdrawals`),
    ...dateRef(`${prefix}.withdrawAge`, `${b}.withdrawals`),
    M(`${prefix}.investmentGrowthType`, `${b}.growth`),
    M(`${prefix}.investmentGrowthRate`, `${b}.growth`),
    M(`${prefix}.dividendType`, `${b}.dividends.yield`),
    M(`${prefix}.dividendRate`, `${b}.dividends.yield`),
    M(`${prefix}.yearlyFee`, `${b}.fees`),
    M(`${prefix}.yearlyFeeType`, `${b}.fees`),
    M(`${prefix}.country`, `${t}.jurisdiction`),
    M(`${prefix}.drawdownMethod`, `${b}.ukDrawdownMethod`),
    M(`${prefix}.taxFreeWithdrawalPercentage`, `${b}.taxFreeWithdrawalShare`),
    M(`${prefix}.EWAge`, `${b}.earlyWithdrawal.qualifiedAge`),
    M(`${prefix}.EWPenaltyRate`, `${b}.earlyWithdrawal.penaltyRate`),
    M(`${prefix}.hasEWPenalty`, `${b}.earlyWithdrawal.enabled`),
    M(`${prefix}.repurpose`, `${b}.isExcessCash`),
  ];
  if (planLevel) {
    const copies = [
      "name",
      "title",
      "subtitle",
      "icon",
      "color",
      "type",
      "owner",
      "balance",
      "costBasis",
      "country",
    ];
    for (const r of rules) {
      const suffix = r.pattern.slice(prefix.length + 1);
      if (copies.includes(suffix)) {
        r.status = "ignored";
        r.target = undefined;
        r.note = REDUNDANT;
      }
    }
    rules.push(
      M(`${prefix}.accountId`, "Plan.accountSettings key"),
      M(`${prefix}.monteCarloTreatment`, `${b}.monteCarlo`),
      ...customSeries(
        `${prefix}.dividendRateCustom`,
        `${b}.dividends.yield (when dividendType is custom)`,
      ),
      I(`${prefix}.persistent`, UI_ITEM),
      I(`${prefix}.key`, "UI render key"),
      I(`${prefix}.planPath`, "UI breadcrumb"),
    );
  }
  return rules;
}

/** Real-asset shape shared by today.assets[] and plan asset events. */
function assetRules(prefix: string, t: string, planLevel: boolean): Rule[] {
  const b = `${t}.behaviour`;
  const rules: Rule[] = [
    M(prefix, t),
    M(`${prefix}.id`, `${t}.id`),
    M(`${prefix}.name`, `${t}.name`),
    M(`${prefix}.title`, `${t}.name`, "used when `name` is absent"),
    M(`${prefix}.icon`, `${t}.appearance.icon`),
    M(`${prefix}.color`, `${t}.appearance.color`),
    M(`${prefix}.type`, `${t}.type`),
    M(`${prefix}.owner`, `${t}.owner`),
    M(`${prefix}.amount`, `${t}.currentValue`, "planned assets: purchase.price"),
    M(`${prefix}.amountType`, "value basis"),
    M(`${prefix}.initialValue`, `${t}.purchasePrice`, "planned assets: purchase.marketValue"),
    M(`${prefix}.initialValueType`, "value basis"),
    M(`${prefix}.balance`, `${t}.loan.balance`),
    M(`${prefix}.balanceType`, "value basis"),
    M(`${prefix}.interestRate`, `${t}.loan.interest.apr`),
    M(`${prefix}.interestType`, `${t}.loan.interest.method`),
    M(`${prefix}.compounding`, `${t}.loan.interest.compounding`),
    M(`${prefix}.monthlyPayment`, `${t}.loan.monthlyPayment`),
    M(`${prefix}.monthlyPaymentType`, "value basis"),
    M(`${prefix}.paymentMethod`, `${t}.loan`, "pay-in-full: no loan"),
    M(
      `${prefix}.downPayment`,
      "PlannedRealAsset.purchase.downPayment",
      "only meaningful for purchases in a plan",
    ),
    M(`${prefix}.downPaymentType`, "value basis"),
    M(`${prefix}.taxRate`, `${b}.propertyTax.cost`),
    M(`${prefix}.taxRateType`, `${b}.propertyTax.cost`),
    M(`${prefix}.insuranceRate`, `${b}.insurance`),
    M(`${prefix}.insuranceRateType`, `${b}.insurance`),
    M(`${prefix}.maintenanceRate`, `${b}.maintenance`),
    M(`${prefix}.maintenanceRateType`, `${b}.maintenance`),
    M(`${prefix}.improvementRate`, `${b}.improvements`),
    M(`${prefix}.improvementRateType`, `${b}.improvements`),
    M(`${prefix}.managementRate`, `${b}.rental.management`, "approximated: see mapping doc"),
    M(`${prefix}.managementRateType`, `${b}.rental.management`),
    M(`${prefix}.monthlyHOA`, `${b}.hoa`),
    M(`${prefix}.monthlyHOAType`, `${b}.hoa`),
    M(`${prefix}.assessedValue`, `${b}.propertyTax.assessedValue`),
    M(`${prefix}.assessedValueType`, `${b}.propertyTax.assessedValue`),
    M(`${prefix}.assessedValueGrowthRateLimit`, `${b}.propertyTax.reassessment`),
    M(`${prefix}.assessedValueGrowthRateLimitType`, `${b}.propertyTax.reassessment`),
    M(`${prefix}.incomeRate`, `${b}.rental.income`),
    M(`${prefix}.incomeRateType`, `${b}.rental.income`),
    M(`${prefix}.percentRented`, `${b}.rental.rentedShare`),
    M(`${prefix}.generateIncome`, `${b}.rental.enabled`),
    M(`${prefix}.selfEmployment`, `${b}.rental.taxSettings.selfEmployment`),
    M(`${prefix}.estimateRentalDeductions`, `${b}.rental.taxSettings.estimateDeductions`),
    M(`${prefix}.estimateQBI`, `${b}.rental.taxSettings.qbiDeduction`),
    M(`${prefix}.initialBuildingValue`, `${b}.rental.taxSettings.buildingValue`),
    M(`${prefix}.initialBuildingValueType`, "value basis"),
    M(`${prefix}.classification`, `${b}.rental.taxSettings.classification`),
    M(`${prefix}.isPassiveIncome`, `${b}.rental.countsAsPassiveIncome`),
    M(
      `${prefix}.cancelRent`,
      "RealAssetBehaviour.rental.cancelOnSale",
      "read as: tenancy ends at the sale",
    ),
    M(`${prefix}.yearlyChange`, `${b}.appreciation`),
    M(`${prefix}.yearlyChange.type`, `${b}.appreciation`),
    M(`${prefix}.yearlyChange.amount`, `${b}.appreciation`),
    M(`${prefix}.yearlyChange.amountType`, `${b}.appreciation`),
    M(
      `${prefix}.yearlyChange.limitEnabled`,
      "RealAssetBehaviour.appreciationLimit",
      "ceiling when appreciating, floor when depreciating; % = share of the initial value",
    ),
    M(
      `${prefix}.yearlyChange.limit`,
      "RealAssetBehaviour.appreciationLimit",
      "cap/floor on asset growth",
    ),
    M(
      `${prefix}.yearlyChange.limitType`,
      "RealAssetBehaviour.appreciationLimit",
      "ceiling when appreciating, floor when depreciating; % = share of the initial value",
    ),
    M(`${prefix}.sellIfNeeded`, `${b}.liquidateIfNeeded`),
    M(`${prefix}.excludeLoanFromLNW`, `${b}.excludeLoanFromLiquidNetWorth`),
    M(
      `${prefix}.brokersFee`,
      `${b}.sale.brokerFeeRate`,
      "only when the asset is sold (end is a date/milestone)",
    ),
    M(`${prefix}.repeat`, `${b}.recurrence`),
    M(`${prefix}.repeatInterval`, `${b}.recurrence.yearsBetween`),
    M(`${prefix}.repeatIntervalType`, `${b}.recurrence.yearsBetween`),
    M(`${prefix}.repeatScaler`, `${b}.recurrence.scalingRate`),
    ...dateRef(`${prefix}.repeatEnd`, `${b}.recurrence.until`),
    ...dateRef(`${prefix}.start`, "owned-since / PlannedRealAsset.purchase.at"),
    ...dateRef(`${prefix}.end`, `${b}.sale.at`),
    I(`${prefix}.order`, "UI ordering"),
    I(`${prefix}.planPath`, "UI breadcrumb"),
  ];
  if (planLevel) {
    const copies = [
      "name",
      "title",
      "icon",
      "color",
      "type",
      "owner",
      "amount",
      "amountType",
      "initialValue",
      "initialValueType",
      "balance",
      "balanceType",
      "interestRate",
      "interestType",
      "compounding",
      "monthlyPayment",
      "monthlyPaymentType",
      "paymentMethod",
    ];
    const note =
      "redundant copy of the Current Finances loan/value; divergence is reported as an issue (Glideworth cannot override a loan per plan)";
    for (const r of rules) {
      const suffix = r.pattern.slice(prefix.length + 1);
      if (copies.includes(suffix)) {
        r.status = "ignored";
        r.target = undefined;
        r.note = note;
      }
    }
    rules.push(
      M(`${prefix}.assetId`, "Plan.realAssetSettings key"),
      I(`${prefix}.persistent`, UI_ITEM),
      I(`${prefix}.key`, "UI render key"),
      I(`${prefix}.hidden`, "chart visibility"),
    );
  }
  return rules;
}

/** Date-ref-bearing event fields shared by income/expense/priority events. */
function eventRules(prefix: string, t: string): Rule[] {
  return [
    M(prefix, t),
    M(`${prefix}.id`, `${t}.id`),
    M(`${prefix}.name`, `${t}.name`),
    M(`${prefix}.title`, `${t}.name`, "used when `name` is absent"),
    M(`${prefix}.icon`, `${t}.appearance.icon`),
    M(`${prefix}.color`, `${t}.appearance.color`),
    M(`${prefix}.owner`, `${t}.owner`),
    M(`${prefix}.type`, `${t}.type`),
    M(`${prefix}.frequency`, `${t}.frequency`),
    M(`${prefix}.amount`, `${t}.amount.value`),
    M(`${prefix}.amountType`, `${t}.amount.basis`, "'today$' -> real"),
    ...dateRef(`${prefix}.start`, `${t}.range.start`),
    ...dateRef(`${prefix}.end`, `${t}.range.end`),
    I(`${prefix}.frequencyChoices`, UI_ITEM),
    I(`${prefix}.key`, "UI render key"),
    I(`${prefix}.planPath`, "UI breadcrumb"),
    I(`${prefix}.persistent`, UI_ITEM),
    I(`${prefix}.hidden`, "chart visibility"),
    I(`${prefix}.showChartIcon`, "chart visibility"),
  ];
}

function changeRules(prefix: string, t: string): Rule[] {
  return [
    M(`${prefix}.yearlyChange`, `${t}.change`),
    M(`${prefix}.yearlyChange.type`, `${t}.change`),
    M(`${prefix}.yearlyChange.amount`, `${t}.change`),
    M(`${prefix}.yearlyChange.amountType`, `${t}.change`),
    M(`${prefix}.yearlyChange.limitEnabled`, `${t}.changeLimit`),
    M(`${prefix}.yearlyChange.limit`, `${t}.changeLimit`),
    M(`${prefix}.yearlyChange.limitType`, `${t}.changeLimit`),
  ];
}

/** Debt shape (today.debts[] and the `debt` expense events that mirror them in a plan). */
function debtRules(prefix: string, t: string, planLevel: boolean): Rule[] {
  const dup = (suffix: string, target: string): Rule =>
    planLevel ? I(`${prefix}.${suffix}`, REDUNDANT) : M(`${prefix}.${suffix}`, target);
  return [
    dup("amount", `${t}.balance`),
    dup("amountType", "value basis"),
    dup("interestRate", `${t}.interest.apr`),
    dup("interestType", `${t}.interest.method`),
    dup("compounding", `${t}.interest.compounding`),
    M(
      `${prefix}.monthlyPayment`,
      planLevel ? "Plan.debtSettings[].monthlyPaymentOverride" : `${t}.monthlyPayment`,
    ),
    M(`${prefix}.monthlyPaymentType`, "value basis"),
    ...dateRef(`${prefix}.start`, `${t}.behaviour.paymentsStart`),
    I(`${prefix}.effectiveDate`, "the balance is stated as of the export month (finances.asOf)"),
    I(
      `${prefix}.effectiveDate.type`,
      "the balance is stated as of the export month (finances.asOf)",
    ),
    I(
      `${prefix}.effectiveDate.value`,
      "the balance is stated as of the export month (finances.asOf)",
    ),
    I(
      `${prefix}.effectiveDate.modifier`,
      "the balance is stated as of the export month (finances.asOf)",
    ),
    ...dateRef(`${prefix}.forgiveAt`, `${t}.behaviour.forgiveness.at`),
    M(`${prefix}.hasForgiveness`, `${t}.behaviour.forgiveness`),
    M(`${prefix}.end.type`, "DebtBehaviour.paymentsEnd"),
    M(`${prefix}.end.value`, "DebtBehaviour.paymentsEnd"),
    M(`${prefix}.end.modifier`, "DebtBehaviour.paymentsEnd"),
    M(
      `${prefix}.end`,
      "DebtBehaviour.paymentsEnd",
      "scheduled payments stop at this date; `never`/end of plan = no end",
    ),
    I(`${prefix}.frequency`, "payments are monthly in Glideworth; other values are reported"),
    I(`${prefix}.frequencyChoices`, UI_ITEM),
    I(`${prefix}.order`, "UI ordering"),
    I(`${prefix}.additionalFields`, UI_ITEM),
    I(`${prefix}.additionalFields.disabled`, UI_ITEM),
    I(`${prefix}.additionalFields.whitelist`, UI_ITEM),
    I(`${prefix}.additionalFields.whitelist[]`, UI_ITEM),
    I(`${prefix}.planPath`, "UI breadcrumb"),
    M(
      `${prefix}.yearlyChange`,
      "DebtBehaviour.balanceChange",
      "yearly % drift of the balance; the limit caps (or floors) it",
    ),
    M(`${prefix}.yearlyChange.type`, "DebtBehaviour.balanceChange"),
    M(`${prefix}.yearlyChange.amount`, "DebtBehaviour.balanceChange"),
    M(`${prefix}.yearlyChange.amountType`, "DebtBehaviour.balanceChange"),
    M(`${prefix}.yearlyChange.limitEnabled`, "DebtBehaviour.balanceChange"),
    M(`${prefix}.yearlyChange.limit`, "DebtBehaviour.balanceChange"),
    M(`${prefix}.yearlyChange.limitType`, "DebtBehaviour.balanceChange"),
  ];
}

const WS_STRATEGIES: [string, string[]][] = [
  ["initial-%", ["amount", "min", "minType", "minEnabled", "max", "maxType", "maxEnabled"]],
  ["fixed-%", ["amount", "min", "minType", "minEnabled", "max", "maxType", "maxEnabled"]],
  ["fixed-amount", ["amount", "amountType", "adjust"]],
  ["1/N", ["min", "minType", "minEnabled", "max", "maxType", "maxEnabled"]],
  ["vpw", ["min", "minType", "minEnabled", "max", "maxType", "maxEnabled"]],
  [
    "kitces-ratchet",
    [
      "amount",
      "threshold",
      "ratchet",
      "cooldown",
      "min",
      "minType",
      "minEnabled",
      "max",
      "maxType",
      "maxEnabled",
    ],
  ],
  [
    "clyatt-95%",
    ["amount", "percentOfPrevious", "min", "minType", "minEnabled", "max", "maxType", "maxEnabled"],
  ],
  [
    "guyton-klinger",
    [
      "amount",
      "guardrail",
      "adjustment",
      "min",
      "minType",
      "minEnabled",
      "max",
      "maxType",
      "maxEnabled",
    ],
  ],
];

function withdrawalRules(): Rule[] {
  const p = "$.plans[].withdrawalStrategy";
  const rules: Rule[] = [
    M(p, "Plan.withdrawalStrategy"),
    M(`${p}.enabled`, "Plan.withdrawalStrategy.enabled"),
    M(`${p}.strategy`, "Plan.withdrawalStrategy.rule.kind"),
    ...dateRef(`${p}.start`, "Plan.withdrawalStrategy.start"),
    M(`${p}.income`, "Plan.withdrawalStrategy.incomeHandling"),
    M(`${p}.spendMode`, "Plan.withdrawalStrategy.treatAsSpending"),
  ];
  for (const [name, fields] of WS_STRATEGIES) {
    rules.push(
      M(
        `${p}.${name}`,
        "Plan.withdrawalStrategy.rule",
        "parameters of non-selected strategies are dropped (info issue)",
      ),
    );
    for (const f of fields) {
      const target = /^(min|max)/.test(f)
        ? `Plan.withdrawalStrategy.bounds.${f.startsWith("min") ? "floor" : "ceiling"}`
        : "Plan.withdrawalStrategy.rule";
      rules.push(M(`${p}.${name}.${f}`, target));
    }
  }
  return rules;
}

const MC_SOURCES = ["investmentReturn", "bondReturn", "inflation", "dividendRate", "cryptoReturn"];

function monteCarloRules(): Rule[] {
  const p = "$.plans[].montecarlo";
  const rules: Rule[] = [
    M(p, "Plan.monteCarlo"),
    M(`${p}.sampling`, "Plan.monteCarlo.method"),
    M(`${p}.trials`, "Plan.monteCarlo.trials"),
    M(`${p}.blockSize`, "Plan.monteCarlo.blockLength"),
    M(`${p}.splitPoint`, "Plan.monteCarlo.splitAtMilestoneId"),
    I(`${p}.iterations`, "run batching parameter of the source engine"),
    I(`${p}.metrics`, "chart statistic selection (UI)"),
    I(`${p}.metrics[]`, "chart statistic selection (UI)"),
    I(`${p}.metric`, "chart statistic selection (UI)"),
    I(`${p}.statsMetric`, "chart statistic selection (UI)"),
  ];
  for (const s of MC_SOURCES) {
    rules.push(
      M(
        `${p}.${s}`,
        "Plan.monteCarlo.sources",
        "backtest = the sampling method, custom = the distribution",
      ),
      M(`${p}.${s}Mean`, `Plan.monteCarlo.distributions.${s}.mean`),
      M(`${p}.${s}StdDev`, `Plan.monteCarlo.distributions.${s}.stdDev`),
    );
  }
  return rules;
}

function variablesRules(): Rule[] {
  const v = "$.plans[].variables";
  const A = "Plan.assumptions";
  const T = "Plan.tax";
  const mod = (k: string, target: string): Rule =>
    M(`${v}.${k}`, target, "additive modifier; ignored in fixed mode as in the source");
  return [
    M(v, "Plan"),
    M(`${v}.inflation`, `${A}.inflation`),
    M(`${v}.investmentReturn`, `${A}.stockReturn`),
    M(`${v}.dividendRate`, `${A}.dividendYield`),
    M(`${v}.bondInvestmentReturn`, `${A}.bondReturn`),
    M(`${v}.bondDividendRate`, `${A}.bondYield`),
    M(`${v}.assumptionsMode`, `${A}.* (fixed | historical | schedule)`),
    M(`${v}.startYear`, `${A}.*.historical.startYear`, "only when assumptionsMode is historical"),
    M(`${v}.loopYear`, `${A}.*.historical.loopYear`, "only when assumptionsMode is historical"),
    mod("inflationModifier", `${A}.inflation.modifier (historical) / schedule points (custom)`),
    mod(
      "investmentReturnModifier",
      `${A}.stockReturn.modifier (historical) / schedule points (custom)`,
    ),
    mod(
      "dividendRateModifier",
      `${A}.dividendYield.modifier (historical) / schedule points (custom)`,
    ),
    mod(
      "bondInvestmentReturnModifier",
      `${A}.bondReturn.modifier (historical) / schedule points (custom)`,
    ),
    mod("bondDividendRateModifier", `${A}.bondYield (schedule points, custom mode)`),
    mod("incomeTaxModifier", `${T}.flat.modifier.ordinary`),
    mod("capGainsModifier", `${T}.flat.modifier.capitalGains`),
    ...customSeries(`${v}.inflationCustom`, `${A}.inflation (schedule)`),
    ...customSeries(`${v}.investmentReturnCustom`, `${A}.stockReturn (schedule)`),
    ...customSeries(`${v}.dividendRateCustom`, `${A}.dividendYield (schedule)`),
    ...customSeries(`${v}.bondInvestmentReturnCustom`, `${A}.bondReturn (schedule)`),
    ...customSeries(`${v}.bondDividendRateCustom`, `${A}.bondYield (schedule)`),
    M(`${v}.benefitColaModifier`, `${A}.benefitColaModifier`),
    M(`${v}.dividendSettings`, `${A}.dividendReinvestment`),
    M(`${v}.dividendSettings.reinvestment`, `${A}.dividendReinvestment`),
    M(`${v}.dividendSettings.reinvestment.enabled`, `${A}.dividendReinvestment.enabled`),
    M(`${v}.bondSettings`, `${A}.bondAllocation`),
    M(`${v}.bondSettings.allocation`, `${A}.bondAllocation.points`),
    M(`${v}.bondSettings.allocation[]`, `${A}.bondAllocation.points`),
    M(`${v}.bondSettings.allocation[].x`, `${A}.bondAllocation.points[].at (age)`),
    M(`${v}.bondSettings.allocation[].y`, `${A}.bondAllocation.points[].value`),
    M(`${v}.bondSettings.allocationType`, `${A}.bondAllocation.kind`),
    M(`${v}.bondSettings.location`, `${A}.bondAllocation.locationPriority`),
    M(`${v}.bondSettings.location.type`, `${A}.bondAllocation.locationPriority`),
    M(`${v}.bondSettings.location.accountOrder`, `${A}.bondAllocation.locationPriority`),
    M(`${v}.bondSettings.location.accountOrder[]`, `${A}.bondAllocation.locationPriority`),
    M(`${v}.drawdownOrder`, "Plan.drawdown.order"),
    M(`${v}.drawdownOrder[]`, "Plan.drawdown.order"),
    M(`${v}.cashFlowDefault`, "Plan.leftover"),
    M(`${v}.flexSpending`, "Plan.flexSpending"),
    M(`${v}.flexSpending.enabled`, "Plan.flexSpending.enabled"),
    M(`${v}.flexSpending.scope`, "Plan.flexSpending.scope"),
    M(`${v}.flexSpending.interpolation`, "Plan.flexSpending.interpolation"),
    M(`${v}.flexSpending.points`, "Plan.flexSpending.rules"),
    M(`${v}.flexSpending.points[]`, "Plan.flexSpending.rules"),
    M(`${v}.flexSpending.points[].*`, "Plan.flexSpending.rules"),
    M(`${v}.estate`, `${T}.estate`),
    M(`${v}.estate.assetLiquidationFee`, `${T}.estate.liquidationCostRate`),
    M(`${v}.estate.adminRate`, `${T}.estate.adminCostRate`),
    M(`${v}.estate.stepUpBasis`, `${T}.estate.stepUpBasis`),
    M(`${v}.estate.taxDeferredRate`, `${T}.estate.heirTaxDeferredRate`),
    M(`${v}.estate.taxableGainsRate`, `${T}.estate.heirCapitalGainsRate`),
    M(`${v}.estate.charityRate`, `${T}.estate.charitableShare`),
    M(`${v}.estimateTaxes`, `${T}.mode`),
    M(`${v}.incomeTaxMode`, `${T}.mode`),
    M(`${v}.effectiveIncomeTaxRate`, `${T}.flat.ordinary + ${T}.custom.flatEffectiveRate`),
    M(`${v}.capGainsMode`, `${T}.mode`),
    M(`${v}.capGainsTaxRate`, `${T}.flat.capitalGains`),
    M(`${v}.capGainsTaxablePercent`, `${T}.custom.capitalGainsInclusion`),
    M(`${v}.capGainsTaxAsIncome`, `${T}.custom.capitalGainsAsOrdinary`),
    M(`${v}.dividendTaxMode`, `${T}.mode`),
    M(`${v}.dividendTaxRate`, `${T}.flat.dividends`),
    M(
      `${v}.localIncomeTaxRate`,
      `${T}.flat.local (flat) / ${T}.localIncomeTaxRate (estimate, custom)`,
    ),
    M(`${v}.filingStatus`, `${T}.filingStatus`),
    M(`${v}.tcjaReversion`, `${T}.lawToggles`, "US households only"),
    M(`${v}.bbbSaltReversion`, `${T}.lawToggles`, "US households only"),
    M(`${v}.bbbSeniorReversion`, `${T}.lawToggles`, "US households only"),
    M(`${v}.withholding`, `${T}.withholding`),
    M(`${v}.withholding.taxDeferred`, `${T}.withholding.taxDeferred`),
    M(`${v}.withholding.taxable`, `${T}.withholding.taxable`),
    M(`${v}.withholding.conversions`, `${T}.withholding.conversions`),
    M(`${v}.incomeTaxNational`, `${T}.custom.ordinary`),
    M(`${v}.incomeTaxNational.brackets`, `${T}.custom.ordinary.brackets`),
    M(`${v}.incomeTaxNational.brackets[]`, `${T}.custom.ordinary.brackets`),
    M(`${v}.incomeTaxNational.brackets[].*`, `${T}.custom.ordinary.brackets`),
    M(`${v}.incomeTaxNational.standardDeduction`, `${T}.custom.standardDeduction`),
    I(`${v}.incomeTaxNational.name`, "label of the national tax preset"),
    I(`${v}.incomeTaxNational.icon`, "label of the national tax preset"),
    M(`${v}.capGains`, `${T}.custom.capitalGains`),
    M(`${v}.capGains.brackets`, `${T}.custom.capitalGains.brackets`),
    M(`${v}.capGains.brackets[]`, `${T}.custom.capitalGains.brackets`),
    M(`${v}.capGains.brackets[].*`, `${T}.custom.capitalGains.brackets`),
    M(
      `${v}.capGains.offset`,
      `${T}.custom.capitalGainsOffset`,
      "any value but `none` stacks gains on other income",
    ),
    M(`${v}.dividendTax`, `${T}.custom.dividends`),
    M(`${v}.dividendTax.brackets`, `${T}.custom.dividends.brackets`),
    M(`${v}.dividendTax.brackets[]`, `${T}.custom.dividends.brackets`),
    M(`${v}.dividendTax.brackets[].*`, `${T}.custom.dividends.brackets`),
    M(
      `${v}.dividendTax.offset`,
      `${T}.custom.dividendOffset`,
      "any value but `none` stacks dividends on other income",
    ),
    M(`${v}.dividendTax.allowance`, `${T}.custom.dividendAllowance`),
    M(
      `${v}.bondDividendTax`,
      `${T}.custom.bondDividends`,
      "bond fund distributions taxed with their own table",
    ),
    M(`${v}.bondDividendTax.brackets`, `${T}.custom.bondDividends.brackets`),
    M(`${v}.bondDividendTax.brackets[]`, `${T}.custom.bondDividends.brackets`),
    M(`${v}.bondDividendTax.brackets[].*`, `${T}.custom.bondDividends.brackets`),
    I(`${v}.bondDividendTax.offset`, "bond dividends are taxed from the bottom of their own table"),
    M(`${v}.bondDividendTaxMode`, `${T}.flat.bondDividends.treatment`),
    M(`${v}.bondDividendTaxRate`, `${T}.flat.bondDividends.rate`),
    M(
      `${v}.incomeTaxExtra`,
      `${T}.custom.extraTaxes`,
      "additional named income taxes on ordinary income",
    ),
    M(`${v}.incomeTaxExtra[]`, `${T}.custom.extraTaxes[]`),
    M(`${v}.incomeTaxExtra[].*`, `${T}.custom.extraTaxes[]`),
    M(`${v}.wealthTaxMode`, `${T}.custom.wealthTax`),
    M(`${v}.wealthTaxMetric`, `${T}.custom.wealthTax.metric`),
    M(`${v}.wealthTaxRate`, `${T}.custom.wealthTax.table`, "flat rate when no brackets are given"),
    M(`${v}.wealthTax`, `${T}.custom.wealthTax`),
    M(`${v}.wealthTax.brackets`, `${T}.custom.wealthTax.table.brackets`),
    M(`${v}.wealthTax.brackets[]`, `${T}.custom.wealthTax.table.brackets`),
    M(`${v}.wealthTax.brackets[].*`, `${T}.custom.wealthTax.table.brackets`),
    M(
      `${v}.wealthTax.standardDeduction`,
      `${T}.custom.wealthTax.table`,
      "becomes a zero-rate first bracket",
    ),
    M(
      `${v}.wealthTax.allowance`,
      `${T}.custom.wealthTax.table`,
      "becomes a zero-rate first bracket",
    ),
    M(`${v}.fttMode`, `${T}.custom.financialTransactionTax`, "only when not `none`"),
    M(`${v}.fttRate`, `${T}.custom.financialTransactionTax.rate`),
    M(`${v}.fttTaxableEvent`, `${T}.custom.financialTransactionTax.base`),
    M(
      `${v}.projectFrom`,
      "Plan.startingConditions",
      "only `now` (live) is representable; others are reported",
    ),
    I(`${v}.startDate`, "plan start is finances.asOf in Glideworth"),
    M(`${v}.showFutureDollars`, "settings.valueBasis"),
    I(`${v}.showRothConversionIcons`, "chart visibility"),
  ];
}

function incomeRules(): Rule[] {
  const p = "$.plans[].income.events[]";
  const t = "Plan.income[]";
  return [
    ...eventRules(p, t),
    ...changeRules(p, t),
    M(`${p}.taxCharacter`, `${t}.tax.character`),
    M(`${p}.taxExempt`, `${t}.tax.exemptIn`),
    M(`${p}.taxExempt[]`, `${t}.tax.exemptIn`),
    M(`${p}.withholdingMode`, `${t}.tax.withholding`),
    M(`${p}.withholdingRate`, `${t}.tax.withholding.rate`),
    M(`${p}.routeToAccounts`, `${t}.sendTo`),
    M(`${p}.routeToAccounts[]`, `${t}.sendTo.accountIds`),
    M(
      `${p}.preventOverflow`,
      `${t}.sendTo.preventOverflow`,
      "fill each routed account up to its limit",
    ),
    M(
      `${p}.repeat`,
      `${t}.recurrence`,
      "no interval fields exist on income events; `true` is reported",
    ),
    M(`${p}.goPartTime`, `${t}.partTime`),
    M(`${p}.partTimeRate`, `${t}.partTime.share`),
    ...dateRef(`${p}.partTimeStart`, `${t}.partTime.range.start`),
    ...dateRef(`${p}.partTimeEnd`, `${t}.partTime.range.end`),
    M(`${p}.hasPension`, `${t}.pension`),
    M(`${p}.pensionContribution`, `${t}.pension.employeeContribution`),
    M(`${p}.pensionContributionType`, `${t}.pension.employeeContribution`),
    M(`${p}.contribsReduceTaxableIncome`, `${t}.pension.contributionsReduceTaxableIncome`),
    M(`${p}.pensionPayoutType`, `${t}.pension.payout.kind`),
    M(`${p}.pensionPayoutRate`, `${t}.pension.payout.rate`),
    M(`${p}.pensionPayoutAmount`, `${t}.pension.payout.amount`),
    M(`${p}.pensionPayoutsAreTaxFree`, `${t}.pension.payoutsTaxFree`),
    ...dateRef(`${p}.pensionPayoutsStart`, `${t}.pension.payouts.start`),
    ...dateRef(`${p}.pensionPayoutsEnd`, `${t}.pension.payouts.end`),
  ];
}

function expenseRules(): Rule[] {
  const p = "$.plans[].expenses.events[]";
  const t = "Plan.expenses[]";
  return [
    ...eventRules(p, t),
    ...changeRules(p, t),
    ...debtRules(p, "finances.debts[]", true),
    M(`${p}.spendingType`, `${t}.spendingType`),
    M(`${p}.debtId`, "Plan.debtSettings key", "`debt` events become debtSettings, not expenses"),
    M(`${p}._meta`, "Plan.debtSettings"),
    M(`${p}._meta.overriddenFields`, "Plan.debtSettings"),
    M(`${p}._meta.overriddenFields.*`, "Plan.debtSettings[].monthlyPaymentOverride"),
    M(`${p}.repeat`, `${t}.recurrence`),
    M(`${p}.repeatInterval`, `${t}.recurrence.yearsBetween`),
    M(`${p}.repeatIntervalType`, `${t}.recurrence.yearsBetween`),
    M(`${p}.repeatScaler`, `${t}.recurrence.scalingRate`),
    ...dateRef(`${p}.repeatEnd`, `${t}.recurrence.until`),
    M(`${p}.taxDeductible`, `${t}.tax.deductible`),
    M(`${p}.itemized`, `${t}.tax.itemized`),
    M(`${p}.deductFromIncomeId`, `${t}.tax.payrollDeductionFromIncomeId`),
    M(`${p}.taxTreatment`, `${t}.tax.treatment`),
    M(`${p}.fundWithAccounts`, `${t}.payFrom`),
    M(`${p}.fundWithAccounts[]`, `${t}.payFrom.accountIds`),
  ];
}

function priorityRules(): Rule[] {
  const p = "$.plans[].priorities.events[]";
  const t = "Plan.flows[]";
  return [
    ...eventRules(p, t),
    M(`${p}.goalIntent`, `${t}.kind / method`),
    M(`${p}.desiredContribution`, `${t}.method`),
    M(`${p}.mode`, `${t}.strategy`),
    M(`${p}.contribution`, `${t}.method`),
    M(`${p}.contributionType`, `${t}.method.amount.basis`),
    M(`${p}.extra`, `${t}.method.amount`),
    M(`${p}.extraType`, `${t}.method.amount.basis`),
    M(`${p}.contributionsAreFixed`, `${t}.mandatory`, 'approximation of "always fund"'),
    M(`${p}.accountId`, `${t}.accountId / fromAccountId`),
    M(`${p}.debtId`, `${t}.targetId`),
    M(`${p}.assetId`, `${t}.targetId`),
    M(`${p}.destination`, `${t}.to`),
    M(`${p}.destination.id`, `${t}.to.accountId`),
    M(`${p}.destination.type`, `${t}.to.kind`),
    M(`${p}.taxTreatment`, `${t}.taxHandling`, "transfers only; reported on contributions"),
    M(`${p}.tapFund`, `${t}.tapFund`, "after the saving window the fund pays out `tapRate` a year"),
    M(`${p}.tapRate`, `${t}.tapFund.rate`),
    I(`${p}.maxMsg`, "cached UI message"),
  ];
}

function milestoneRules(): Rule[] {
  const m = "$.plans[].milestones[]";
  const c = "$.plans[].computedMilestones[]";
  return [
    M(m, "Plan.milestones[]"),
    M(`${m}.id`, "Plan.milestones[].id"),
    M(`${m}.name`, "Plan.milestones[].name"),
    M(`${m}.icon`, "Plan.milestones[].appearance.icon"),
    M(`${m}.color`, "Plan.milestones[].appearance.color"),
    M(`${m}.removable`, "Plan.milestones[].builtIn"),
    M(`${m}.criteria`, "Plan.milestones[].criteria"),
    M(`${m}.criteria[]`, "Plan.milestones[].criteria"),
    M(`${m}.criteria[].type`, "Plan.milestones[].criteria[].kind"),
    M(`${m}.criteria[].value`, "Plan.milestones[].criteria[]"),
    M(`${m}.criteria[].valueType`, "Plan.milestones[].criteria[].threshold"),
    M(`${m}.criteria[].operator`, "Plan.milestones[].criteria[].comparator"),
    M(`${m}.criteria[].measurement`, "Plan.milestones[].criteria[].threshold.measurement"),
    M(
      `${m}.criteria[].modifier`,
      "Plan.milestones[].criteria[].offsetMonths",
      "include/exclude on a milestone/date criterion",
    ),
    M(
      `${m}.criteria[].range`,
      "Plan.milestones[].criteria[].threshold.averageYears",
      "averaging window in years for `avg` measurements",
    ),
    I(`${m}.criteria[].fixedRange`, "the averaging window always starts at the evaluated year"),
    M(
      `${m}.location`,
      "Plan.milestones[].effects[relocate].location",
      "Move milestone destination -> residency timeline (inferred key shape; not in the export checked)",
    ),
    M(
      `${m}.location.*`,
      "Plan.milestones[].effects[relocate].location",
      "country / state / province / city",
    ),
    M(`${m}.relocation`, "Plan.milestones[].effects[relocate].location", "inferred key shape"),
    M(`${m}.relocation.**`, "Plan.milestones[].effects[relocate].location", "inferred key shape"),
    M(`${m}.taxResidence`, "Plan.milestones[].effects[relocate].location", "inferred key shape"),
    M(`${m}.taxResidence.**`, "Plan.milestones[].effects[relocate].location", "inferred key shape"),
    M(c, "Plan.milestones[]", "account-balance milestones generated by flows"),
    M(`${c}.id`, "Plan.milestones[].id"),
    I(`${c}.goalId`, "link back to the generating priority; the flow target carries it"),
    M(`${c}.name`, "Plan.milestones[].name"),
    M(`${c}.icon`, "Plan.milestones[].appearance.icon"),
    M(`${c}.color`, "Plan.milestones[].appearance.color"),
    M(`${c}.showChartIcon`, "Plan.milestones[].showOnChart"),
    M(`${c}.hidden`, "Plan.milestones[].showOnChart"),
    M(`${c}.criteria`, "Plan.milestones[].criteria"),
    M(`${c}.criteria[]`, "Plan.milestones[].criteria"),
    M(`${c}.criteria[].type`, "Plan.milestones[].criteria[].metric"),
    M(`${c}.criteria[].refId`, "Plan.milestones[].criteria[].metric.accountId"),
    M(`${c}.criteria[].value`, "Plan.milestones[].criteria[].threshold.amount"),
    M(`${c}.criteria[].valueType`, "Plan.milestones[].criteria[].threshold.amount.basis"),
    M(`${c}.criteria[].operator`, "Plan.milestones[].criteria[].comparator"),
  ];
}

function settingsRules(): Rule[] {
  const s = "$.settings";
  const mc = `${s}.montecarlo`;
  const ot = `${mc}.outcomeTypes`;
  const rules: Rule[] = [
    M(s, "settings"),
    I(`${s}.lastUpdated`, "sync timestamp"),
    I(`${s}.schema`, "format revision"),
    M(`${s}.theme`, "settings.theme"),
    I(`${s}.acceptedTerms`, "account state of the source app"),
    I(`${s}.storageChoice`, "account state of the source app"),
    I(`${s}.keepMeLoggedIn`, "account state of the source app"),
    I(`${s}.allowSupportAccess`, "account state of the source app"),
    I(`${s}.enablePlugins`, "source-app plugin feature"),
    I(`${s}.plugins`, "source-app plugin feature"),
    I(`${s}.plugins.enabled`, "source-app plugin feature"),
    I(`${s}.plugins.apiKey`, "SECRET: discarded and never read into the output or the report"),
    M(`${s}.completedOnboarding`, "settings.onboarding.completed"),
    I(`${s}.skipPlanWizard`, "source-app wizard preference"),
    I(`${s}.seenVersion`, "source-app changelog state"),
    I(`${s}.seenRebrand`, "source-app changelog state"),
    M(`${s}.autoProgress`, "settings.autoProgressSnapshots"),
    M(`${s}.ci`, "household.currency / locale"),
    M(`${s}.ci.currency`, "household.currency"),
    M(`${s}.ci.locale`, "household.locale"),
    I(`${s}.plots.**`, "chart appearance preferences"),
    I(`${s}.plots`, "chart appearance preferences"),
    I(`${s}.tables.**`, "table appearance preferences"),
    I(`${s}.tables`, "table appearance preferences"),
    I(`${s}.progress.**`, "progress page view state"),
    I(`${s}.progress`, "progress page view state"),
    I(`${s}.today.**`, UI_ITEM),
    I(`${s}.today`, UI_ITEM),
    I(`${s}.plan.tabs.**`, UI_ITEM),
    I(`${s}.plan.tabs`, UI_ITEM),
    M(`${s}.plan`, "Plan.assumptions.yearAlignment"),
    M(`${s}.plan.alignment`, "Plan.assumptions.yearAlignment"),
    M(`${s}.plan.alignment.type`, "Plan.assumptions.yearAlignment"),
    M(
      `${s}.plan.alignment.*`,
      "Plan.assumptions.yearAlignment",
      "extra alignment fields (e.g. start month) when present",
    ),
    I(`${s}.summary.**`, "summary card layout"),
    I(`${s}.summary`, "summary card layout"),
    M(mc, "Plan.monteCarlo.seed + settings.outcomeCategories"),
    I(`${mc}.view`, UI_ITEM),
    I(`${mc}.percentileRange`, UI_ITEM),
    I(`${mc}.chart.**`, "chart appearance preferences"),
    I(`${mc}.chart`, "chart appearance preferences"),
    I(`${mc}.maxWorkers`, "source-engine worker count"),
    M(`${mc}.useRandomSeed`, "Plan.monteCarlo.seed"),
    M(`${mc}.randomSeed`, "Plan.monteCarlo.seed"),
    M(`${mc}.successRates`, "settings.successRateBands", "value (%) becomes minRate"),
    M(`${mc}.successRates[]`, "settings.successRateBands[]"),
    I(`${mc}.successRates[].icon`, UI_ITEM),
    M(`${mc}.successRates[].*`, "settings.successRateBands[]"),
    M(ot, "settings.outcomeCategories"),
    M(`${ot}.*`, "settings.outcomeCategories[]"),
    M(`${ot}.*.name`, "settings.outcomeCategories[].name"),
    M(`${ot}.*.type`, "settings.outcomeCategories[].kind"),
    M(
      `${ot}.*.icon`,
      "settings.outcomeCategories[]",
      "icon not stored (Glideworth categories carry a colour only)",
    ),
    M(`${ot}.*.color`, "settings.outcomeCategories[].color"),
    M(`${ot}.*.value`, "settings.outcomeCategories[].threshold", "approximated: units differ"),
    M(`${ot}.*.order`, "settings.outcomeCategories order"),
    I(`${ot}.unknown.**`, 'the "unknown" bucket for unclassified runs is implicit in Glideworth'),
    I(`${ot}.*.description`, "category help text"),
    I(`${s}.eventContainers.**`, UI_ITEM),
    I(`${s}.eventContainers`, UI_ITEM),
    I(`${s}.tours.**`, "onboarding tour state"),
    I(`${s}.tours`, "onboarding tour state"),
    I(`${s}.forms.**`, UI_ITEM),
    I(`${s}.forms`, UI_ITEM),
    I(`${s}.billing`, "account state of the source app"),
    I(`${s}.taxCenter.**`, UI_ITEM),
    I(`${s}.taxCenter`, UI_ITEM),
    M(`${s}.effectiveTaxRate`, "settings.effectiveTaxRate"),
    M(`${s}.effectiveTaxRate.tax`, "settings.effectiveTaxRate"),
    M(`${s}.effectiveTaxRate.tax.local`, "settings.effectiveTaxRate.includeLocal"),
    M(`${s}.effectiveTaxRate.tax.property`, "settings.effectiveTaxRate.includeProperty"),
    M(`${s}.effectiveTaxRate.income`, "settings.effectiveTaxRate.income"),
    M(`${s}.effectiveTaxRate.income.*`, "settings.effectiveTaxRate.income"),
    M(`${s}.spending`, "settings.spending"),
    M(`${s}.spending.taxes`, "settings.spending.includeTaxes"),
    M(`${s}.spending.mortgage`, "settings.spending.includeMortgage"),
    M(`${s}.spending.mortgagePrincipal`, "settings.spending.includeMortgagePrincipal"),
    M(`${s}.spending.consumerDebtPrincipal`, "settings.spending.includeConsumerDebtPrincipal"),
    I(`${s}.layout.**`, UI_ITEM),
    I(`${s}.layout`, UI_ITEM),
    I(`${s}.accessibility.**`, UI_ITEM),
    I(`${s}.accessibility`, UI_ITEM),
    I(`${s}.pro.**`, UI_ITEM),
    I(`${s}.pro`, UI_ITEM),
  ];
  return rules;
}

export const RULES: Rule[] = [
  M("$", "GlideworthDocument"),
  // Optional currency fields (multi-currency): the entity keeps its currency; FX converts it.
  M(
    "$.today.*[].currency",
    "finances.*[].currency",
    "converted to the household currency with finances.fxRates",
  ),
  M("$.plans[].*.events[].currency", "Plan event / planned entity currency"),
  M("$.settings.ci.exchangeRates", "finances.fxRates"),
  M("$.settings.ci.exchangeRates.*", "finances.fxRates[]"),
  M("$.settings.ci.exchangeRates[]", "finances.fxRates[]"),
  M("$.settings.ci.exchangeRates[].*", "finances.fxRates[]"),
  M("$.settings.ci.fxRates", "finances.fxRates"),
  M("$.settings.ci.fxRates[]", "finances.fxRates[]"),
  M("$.settings.ci.fxRates[].*", "finances.fxRates[]"),
  M("$.meta", "report.source"),
  M("$.meta.version", "report.source.version"),
  I("$.meta.lastUpdated", "sync timestamp"),

  // Household
  M("$.today", "household + finances"),
  M("$.today.location", "household.location"),
  M("$.today.location.country", "household.location.country", "'OTHER' -> 'XX'"),
  M("$.today.location.*", "household.location", "region / locality when present"),
  I("$.today.schema", "format revision"),
  I("$.today.tab", UI_ITEM),
  I("$.today.lastUpdated", "used only to choose finances.asOf"),
  M("$.today.partnerStatus", "household.planningMode"),
  I("$.today.age", "derived from the birth month"),
  I("$.today.spouseAge", "derived from the birth month"),
  I("$.today.spouseAgeGap", "derived from the birth months"),
  M("$.today.birthYear", "household.people[0].birthMonth"),
  M("$.today.birthMonth", "household.people[0].birthMonth"),
  M("$.today.yourName", "household.people[0].name"),
  M("$.today.yourColor", "household.people[0].appearance.color"),
  M("$.today.yourIcon", "household.people[0].appearance.icon"),
  M("$.today.spouseBirthYear", "household.people[1].birthMonth"),
  M("$.today.spouseBirthMonth", "household.people[1].birthMonth"),
  M("$.today.spouseName", "household.people[1].name"),
  M("$.today.spouseColor", "household.people[1].appearance.color"),
  M("$.today.spouseIcon", "household.people[1].appearance.icon"),

  // Current finances
  M("$.today.savingsAccounts", "finances.accounts"),
  ...accountRules("$.today.savingsAccounts[]", "finances.accounts[]", false),
  M("$.today.investmentAccounts", "finances.accounts"),
  ...accountRules("$.today.investmentAccounts[]", "finances.accounts[]", false),
  M("$.today.assets", "finances.realAssets"),
  ...assetRules("$.today.assets[]", "finances.realAssets[]", false),
  M("$.today.debts", "finances.debts"),
  M("$.today.debts[]", "finances.debts[]"),
  M("$.today.debts[].id", "finances.debts[].id"),
  M("$.today.debts[].name", "finances.debts[].name"),
  M("$.today.debts[].title", "finances.debts[].name", "used when `name` is absent"),
  M("$.today.debts[].icon", "finances.debts[].appearance.icon"),
  M("$.today.debts[].color", "finances.debts[].appearance.color"),
  M("$.today.debts[].type", "finances.debts[].type"),
  M("$.today.debts[].owner", "finances.debts[].owner"),
  ...debtRules("$.today.debts[]", "finances.debts[]", false),

  // Plans
  M("$.plans", "plans"),
  M("$.plans[]", "plans[]"),
  M("$.plans[].id", "plans[].id"),
  M("$.plans[].name", "plans[].name"),
  M("$.plans[].icon", "plans[].appearance.icon"),
  M("$.plans[].active", "plans[].isMain"),
  M(
    "$.plans[].startingConditionsType",
    "plans[].startingConditions",
    "only 'default' (live) is representable",
  ),
  M("$.plans[].startingConditions", "plans[].startingConditions"),
  M("$.plans[].startingConditions.**", "plans[].startingConditions", "reported when non-empty"),
  I("$.plans[].simKey", "cache key of the source engine"),
  I("$.plans[].lastUpdated", "sync timestamp"),
  I("$.plans[].schema", "format revision"),
  I("$.plans[].initialized", "wizard state"),
  I("$.plans[].hasNotes", "flag only; the export carries no note text"),
  I("$.plans[].meta", "cached run state of the source UI"),
  I("$.plans[].meta.**", "cached run state of the source UI"),
  M("$.plans[].accounts", "Plan.accountSettings"),
  M("$.plans[].accounts.events", "Plan.accountSettings"),
  ...accountRules("$.plans[].accounts.events[]", "Plan.accountSettings[]", true),
  M("$.plans[].assets", "Plan.realAssetSettings"),
  M("$.plans[].assets.events", "Plan.realAssetSettings"),
  ...assetRules("$.plans[].assets.events[]", "Plan.realAssetSettings[]", true),
  M("$.plans[].income", "Plan.income"),
  M("$.plans[].income.events", "Plan.income"),
  ...incomeRules(),
  M("$.plans[].expenses", "Plan.expenses"),
  M("$.plans[].expenses.events", "Plan.expenses"),
  ...expenseRules(),
  M("$.plans[].priorities", "Plan.flows"),
  M("$.plans[].priorities.events", "Plan.flows"),
  ...priorityRules(),
  M("$.plans[].milestones", "Plan.milestones"),
  M("$.plans[].computedMilestones", "Plan.milestones"),
  ...milestoneRules(),
  ...withdrawalRules(),
  ...monteCarloRules(),
  ...variablesRules(),

  // Settings
  ...settingsRules(),

  // Progress
  M("$.progress", "progress"),
  M("$.progress.data", "progress"),
  M("$.progress.data[]", "progress[]"),
  M("$.progress.data[].date", "progress[].date"),
  M("$.progress.data[].netWorth", "progress[].netWorth"),
  M(
    "$.progress.data[].assets",
    "progress[].byCategory['real-assets'] (physical assets) + progress[].assets",
  ),
  M("$.progress.data[].debt", "progress[].liabilities + byCategory.debt"),
  M("$.progress.data[].loans", "progress[].liabilities + byCategory.loans"),
  M("$.progress.data[].savings", "progress[].byCategory.cash"),
  M("$.progress.data[].taxable", "progress[].byCategory.taxable"),
  M("$.progress.data[].taxDeferred", "progress[].byCategory['tax-deferred']"),
  M("$.progress.data[].taxFree", "progress[].byCategory['tax-free']"),
  M("$.progress.data[].crypto", "progress[].byCategory.crypto"),
  I("$.progress.lastUpdated", "sync timestamp"),
];

// -------------------------------------------------------------------------------------------
// Matching
// -------------------------------------------------------------------------------------------

interface Compiled {
  rule: Rule;
  re: RegExp;
  specificity: number;
}

function compile(rule: Rule): Compiled {
  let re = "";
  const p = rule.pattern;
  let i = 0;
  while (i < p.length) {
    if (p.startsWith(".**", i)) {
      re += "(?:\\..+)?";
      i += 3;
    } else if (p[i] === "*") {
      re += "[^.\\[\\]]+";
      i += 1;
    } else {
      re += p[i]!.replace(/[.*+?^${}()|[\]\\/%-]/g, "\\$&");
      i += 1;
    }
  }
  // Exact rules beat wildcard rules; more literal characters beat fewer.
  const wildcards = (p.match(/\*/g) ?? []).length;
  return { rule, re: new RegExp(`^${re}$`), specificity: p.length - wildcards * 100 };
}

const COMPILED: Compiled[] = RULES.map(compile).sort((a, b) => b.specificity - a.specificity);
const EXACT = new Map<string, Rule>();
for (const r of RULES)
  if (!r.pattern.includes("*")) if (!EXACT.has(r.pattern)) EXACT.set(r.pattern, r);

/** Find the rule for a normalised path. */
export function classifyPath(path: string): Rule | undefined {
  const exact = EXACT.get(path);
  if (exact) return exact;
  for (const c of COMPILED) if (c.re.test(path)) return c.rule;
  return undefined;
}

export interface KeyPathInfo {
  occurrences: number;
  /** Up to 3 concrete example paths (with indexes), used for issue messages. */
  concrete: string[];
}

const MAX_DEPTH = 64;

/** Enumerate every key path (arrays collapsed to `[]`) in a JSON value. Structure only. */
export function collectKeyPaths(raw: unknown): Map<string, KeyPathInfo> {
  const out = new Map<string, KeyPathInfo>();
  const add = (norm: string, concrete: string): void => {
    let e = out.get(norm);
    if (!e) {
      e = { occurrences: 0, concrete: [] };
      out.set(norm, e);
    }
    e.occurrences += 1;
    if (e.concrete.length < 3) e.concrete.push(concrete);
  };
  const walk = (v: unknown, norm: string, concrete: string, depth: number): void => {
    add(norm, concrete);
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) walk(x, `${norm}[]`, `${concrete}[${i}]`, depth + 1);
    } else if (isObj(v)) {
      for (const k of Object.keys(v)) walk(v[k], `${norm}.${k}`, `${concrete}.${k}`, depth + 1);
    }
  };
  walk(raw, "$", "$", 0);
  // Array elements are counted at `x[]`; the array node itself is `x`. That matches the
  // convention used in the mapping doc.
  return out;
}

export function buildCoverage(paths: Map<string, KeyPathInfo>): ImportCoverage {
  const entries: CoverageEntry[] = [];
  const unaccounted: string[] = [];
  let mapped = 0;
  let ignored = 0;
  let unsupported = 0;
  for (const [path, info] of paths) {
    const rule = classifyPath(path);
    if (!rule) {
      unaccounted.push(path);
      entries.push({ path, status: "unknown", occurrences: info.occurrences });
      continue;
    }
    if (rule.status === "mapped") mapped += 1;
    else if (rule.status === "ignored") ignored += 1;
    else unsupported += 1;
    entries.push({
      path,
      status: rule.status,
      target: rule.target,
      note: rule.note,
      occurrences: info.occurrences,
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  unaccounted.sort();
  return {
    total: paths.size,
    mapped,
    ignored,
    unsupported,
    unknown: unaccounted.length,
    entries,
    unaccountedPaths: unaccounted,
  };
}
