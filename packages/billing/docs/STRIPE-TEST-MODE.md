# Stripe test mode: manual end-to-end procedure

This is the procedure to run once Stripe **test-mode** keys exist. Unit tests (`pnpm --filter @glideworth/billing
test`) cover the package against `FakeStripeGateway`; this procedure checks the parts that only real Stripe can
confirm (see "What only this procedure verifies" at the end). Never run it with live keys.

Written 2026-11-16 against Stripe API version `2026-10-28.endive` (the version pinned by `stripe` 23.1.0).

## 0. Prerequisites (once)

1. A Stripe **sandbox** (test mode) for Glideworth. Use a dedicated sandbox for these tests, not the one CI uses.
2. A test secret key `sk_test_…`, or better a restricted key `rk_test_…` with write access to Products, Prices,
   Customers, Checkout Sessions, Customer portal, Subscriptions, Refunds, Webhook Endpoints, and read access to
   Events. Keep it in your shell only:
   ```sh
   export GLIDEWORTH_STRIPE_SECRET_KEY=rk_test_...   # never commit, never paste into logs or tickets
   ```
3. The Stripe CLI, logged in to that sandbox: `stripe login` (the pairing code flow; the CLI key is valid 90 days).
4. Dashboard settings in the sandbox (these are not set by the setup script):
   - **Tax** (Settings > Tax): origin address, default tax code for the product (software as a service), default
     tax behaviour, and at least one registration (for example the UK) so tax is actually calculated in test.
   - **Customer emails** (Settings > Billing > Subscriptions and emails / Customer emails): enable emails for
     successful payments and refunds; trial reminder 3 days before the end.
   - **Failed payments** (Settings > Billing > Revenue recovery): Smart Retries on; after the final retry choose
     either "cancel the subscription" or "mark the subscription as unpaid" (both are handled; note which one you
     chose, it decides the status you will observe in step 6).
   - **Subscription status resolution**: leave "most recent invoice" (the default).
   - **Radar**: leave on.
5. The app running in cloud mode with the billing integration from design section 9 (routes
   `POST /api/v1/billing/checkout`, `POST /api/v1/billing/portal`, `GET /api/v1/billing`, `POST /stripe/webhook`).
   Until that lands, use the stand-alone harness in the appendix instead of the app.

Environment for the app (design section 1):

```sh
export GLIDEWORTH_MODE=cloud
export GLIDEWORTH_BILLING=stripe
export GLIDEWORTH_PRICING_FILE=$PWD/packages/billing/pricing.example.json
export GLIDEWORTH_PUBLIC_URL=http://localhost:5173        # the web origin users see
# GLIDEWORTH_STRIPE_PORTAL_CONFIGURATION and GLIDEWORTH_STRIPE_WEBHOOK_SECRET are set in steps 1 and 2
```

## 1. Products, prices, portal configuration (setup script)

From the repository root:

```sh
# Offline plan: no key used, nothing sent to Stripe.
pnpm --filter @glideworth/billing stripe:setup --dry-run

# Read-only check against the sandbox: lists what would be created, writes nothing.
pnpm --filter @glideworth/billing stripe:setup --no-webhook

# Apply. Prints the portal configuration id.
pnpm --filter @glideworth/billing stripe:setup --apply --no-webhook
export GLIDEWORTH_STRIPE_PORTAL_CONFIGURATION=bpc_...      # from the output

# Run it again: every line must say "unchanged" and the exit code must be 0.
pnpm --filter @glideworth/billing stripe:setup --apply --no-webhook; echo "exit $?"
```

Observe in the Dashboard: product `gw_cloud` "Glideworth Cloud"; prices `cloud_monthly_v1` (USD 9.00/month,
exclusive) and `cloud_yearly_v1` (USD 90.00/year, exclusive), each with GBP and EUR currency options (inclusive);
one portal configuration with payment method update, invoice history, cancel at period end, switching between the
two prices, and address/name/tax ID updates. Running twice must not add a second price or portal configuration.

Conflict check: edit `unitAmount` of `cloud_monthly_v1` in a copy of the pricing file and run the check mode with
`--pricing <copy>`: it must print `CONFLICT: price:cloud_monthly_v1 … add a new _vN lookup key` and exit 1.

`--no-webhook` is used here because locally the Stripe CLI forwards events (step 2). For a deployed staging URL,
run without `--no-webhook`: the script creates the endpoint `<GLIDEWORTH_PUBLIC_URL>/stripe/webhook` with the
handled events and API version `2026-10-28.endive`; it never prints the signing secret. Reveal it in the
Dashboard (Workbench > Webhooks > the endpoint > Reveal secret) and set `GLIDEWORTH_STRIPE_WEBHOOK_SECRET`.

## 2. Forward webhooks

```sh
stripe listen --forward-to localhost:8790/stripe/webhook
```

This guide uses port 8790 for the API running locally. Use whatever port your API listens on
(`GLIDEWORTH_API_PORT`) instead, here and in the `curl` examples below.

Copy the `whsec_…` it prints into `GLIDEWORTH_STRIPE_WEBHOOK_SECRET` and restart the API. Check `stripe listen
--help` for the option that selects the event API version and use `2026-10-28.endive` (or later) if your account
default is older: the handler reads `invoice.parent.subscription_details.subscription` (API 2025-03-31 and later)
and falls back to `invoice.subscription`.

Leave this terminal open; each delivery prints `[200] POST …` (or 400/500).

## 3. Sign up and the local trial

Sign up and verify the email (design 3.1). Observe:

- `GET /api/v1/billing`: `status: trialing_local`, `access.level: full`, `access.reason: trial`, trial end = now +
  14 days. No customer exists in the Stripe Dashboard (the trial is local, no card).

## 4. Checkout scenarios

Each scenario uses a fresh workspace unless stated. Card details: any future expiry, any CVC, any postcode.

| #   | Action                                                                                | Card                | Expected                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4.1 | Subscribe monthly mid-trial (more than 48 h left)                                     | 4242 4242 4242 4242 | Checkout shows the trial until the local trial end, total today 0. Events `customer.subscription.created`, `invoice.paid` (0), `checkout.session.completed`: all 200. Billing: `status: trialing`, `trialEndsAt` = local trial end, access full. One `subscription-activated` notice, no `payment-succeeded` (0 amount). |
| 4.2 | Subscribe yearly with no trial left (trial expired, or signed up with a used address) | 4242 4242 4242 4242 | Charged USD 90 + tax now. `status: active`, access full, `payment-succeeded` once with the invoice URL, Stripe receipt email sent.                                                                                                                                                                                       |
| 4.3 | Subscribe with a declined card                                                        | 4000 0000 0000 0002 | Checkout shows the decline; no subscription; billing state unchanged; the page can be retried.                                                                                                                                                                                                                           |
| 4.4 | 3-D Secure, complete the challenge                                                    | 4000 0027 6000 3184 | Challenge shown; after "Complete", same as 4.2.                                                                                                                                                                                                                                                                          |
| 4.5 | 3-D Secure, fail the challenge                                                        | 4000 0027 6000 3184 | Checkout reports failure; no active subscription; access unchanged.                                                                                                                                                                                                                                                      |
| 4.6 | Click "Subscribe" twice quickly                                                       | —                   | Same Checkout URL both times (one session).                                                                                                                                                                                                                                                                              |
| 4.7 | Subscribe again while subscribed                                                      | —                   | `409 ALREADY_SUBSCRIBED` (use the portal).                                                                                                                                                                                                                                                                               |
| 4.8 | Six checkout attempts within an hour on one workspace                                 | —                   | Sixth answers `CHECKOUT_RATE_LIMITED`.                                                                                                                                                                                                                                                                                   |
| 4.9 | UK billing address in Checkout; then a business tax ID `GB123456789`                  | 4242…               | GBP or USD as presented; VAT shown inclusive for GBP; tax ID saved on the customer (Dashboard > Customer > Tax IDs). Sandbox magic tax IDs: `000000000` verifies, `111111111` fails verification.                                                                                                                        |

After each: Dashboard customer has metadata `account_id`; the subscription has metadata `account_id` equal to the
workspace id; `stripe_events` rows are `processed`; no card number, email or body appears in the API logs.

## 5. Customer portal

Open "Manage billing" (`POST /api/v1/billing/portal`). Observe the portal shows: payment method update, invoice
history with PDFs, cancel, switch monthly/yearly, address/name/tax ID.

- Switch monthly -> yearly: charged the prorated difference now (`always_invoice`); `priceLookupKey` becomes
  `cloud_yearly_v1` after `customer.subscription.updated`.
- Switch yearly -> monthly: scheduled for the end of the paid year (no immediate change).

## 6. Failed renewal, grace and lapse (test clock simulation)

1. Subscribe a fresh workspace with 4242 (4.2).
2. In the portal, replace the card with **4000 0000 0000 0341** (attaches, every charge fails).
3. In the Dashboard open the subscription and use **Run simulation** (test clocks; it advances at most two
   intervals at a time). Advance past the period end.
4. Observe `invoice.payment_failed` and `customer.subscription.updated` (200). Billing: `status: past_due`,
   `access.reason: past_due_grace`, `changesAt` = processing time + 14 days. One `payment-problem` notice per
   failed invoice (Smart Retries of the same invoice do not send more).
5. Advance through the retry schedule. After the final retry the status becomes `unpaid` or `canceled` (your
   Dashboard choice): access `read_only`, reason `unpaid` or `canceled`. All workspace data is still there and
   readable; writes answer `402 ACCOUNT_READ_ONLY`.
6. Grace is measured on the server clock, not the test clock. To see `past_due` -> read-only without waiting 14
   days, repeat with `"pastDueGraceDays": 0` in a copy of the pricing file.
7. Recovery: replace the card with 4242 in the portal and pay the open invoice (Dashboard > Invoice > Pay, or
   wait for the next retry): `invoice.paid`, `status: active`, `pastDueSince: null`, access full.

3-D Secure on renewal: repeat with **4000 0027 6000 3184** as the saved card; at renewal expect
`invoice.payment_action_required` -> `past_due`, a `payment-problem` notice, and recovery after authenticating via
the hosted invoice link.

## 7. Cancellation

1. Portal > Cancel. Expect `customer.subscription.updated` with cancellation scheduled; billing:
   `cancelAtPeriodEnd: true`, access full until `currentPeriodEnd`; one `subscription-canceled` notice with
   `accessUntil` = period end. Record whether Stripe set `cancel_at_period_end` or `cancel_at` (both are handled).
2. Run simulation past the period end: `customer.subscription.deleted`, `status: canceled`, access `read_only`
   (`canceled`). No second cancellation email. Data intact.
3. Resubscribe the same workspace: allowed (no `ALREADY_SUBSCRIBED`), a new subscription id is stored, and late
   events for the old subscription do not overwrite it.
4. Workspace deletion path (`cancelNow`): subscription canceled immediately without proration or final invoice;
   no `subscription-canceled` email.

## 8. Refund, dispute, fraud warning, customer deletion

| #   | Action                                                                         | Expected                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 8.1 | Operator refund (console, or `BillingService.refund`) of a yearly charge, full | One refund in the Dashboard even if clicked twice (idempotency key `refund:<charge>:full`); `charge.refunded` 200 `processed`; access unchanged until the operator also cancels; Stripe refund email.                                                                    |
| 8.2 | Partial refund of 1000                                                         | Refund of 10.00; a second identical partial within 24 h returns the same refund.                                                                                                                                                                                         |
| 8.3 | Pay with **4000 0000 0000 0259** (dispute)                                     | `charge.dispute.created` -> operator `dispute` notice with the dispute id.                                                                                                                                                                                               |
| 8.4 | Pay with **4000 0000 0000 5423** (early fraud warning)                         | `radar.early_fraud_warning.created` -> operator notice.                                                                                                                                                                                                                  |
| 8.5 | Delete the customer in the Dashboard                                           | Subscription canceled (`customer.subscription.deleted`), `customer.deleted` processed, access read-only. A new checkout within 24 h of the deletion may fail (the customer idempotency key `customer:<account>` still maps to the deleted customer): note the behaviour. |

## 9. Webhook forgery and ordering

```sh
# Unsigned and wrongly signed requests: 400, nothing stored.
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8790/stripe/webhook -d '{}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8790/stripe/webhook \
  -H 'Stripe-Signature: t=1,v1=0000000000000000000000000000000000000000000000000000000000000000' -d '{}'

# Redelivery of a processed event: 200, recorded as a duplicate, no state change.
stripe events resend evt_...           # an event already processed

# Order independence: resend an older customer.subscription.updated after a newer one.
# Billing state must not change (state is re-fetched, not read from the event).
stripe events resend evt_older_update
```

Also replay a captured signed request (from `stripe listen --print-json` or the API's debug proxy) more than five
minutes later: 400.

## 10. What to check after every step

- `GET /api/v1/billing` (status, interval, trial end, period end, `cancelAtPeriodEnd`, access level and reason).
- Control plane `subscriptions` row equals the Dashboard subscription (status, price lookup key, period end).
- `stripe_events`: every event `processed` (or `ignored`/`orphaned` where expected), none stuck in `failed`.
- `billing_notices`: each lifecycle email exactly once.
- API logs: only ids, codes and counts; no emails, card data, amounts, bodies or secrets.

## What only this procedure verifies (unverified until test keys exist)

- The SDK adapter (`src/gateway/stripe.ts`) against the real API: parameter names and types for products,
  prices (`currency_options` expansion on list, `tax_behavior`), Checkout (`automatic_tax`, `customer_update`,
  `tax_id_collection`, `subscription_data.trial_end`), portal configuration create/update, webhook endpoint
  create/update, refunds, cancel.
- That the portal sets `cancel_at_period_end` or `cancel_at` on cancel, and the exact events Stripe sends for
  portal cancel and interval switch under API `2026-10-28.endive`.
- Stripe Tax results per country and the tax-inclusive GBP/EUR presentation; Adaptive Pricing interplay.
- The `invoice.parent.subscription_details.subscription` path on real invoices.
- Whether declines inside Checkout emit any event the circuit breaker could count (design 4.6 assumes
  `invoice.payment_failed`).
- Real signature headers from `stripe listen` and a Dashboard endpoint (including a secret roll with a delayed
  expiry: both `v1` signatures present).
- Behaviour of the customer idempotency key after a customer is deleted (8.5).

## Appendix: before the API integration lands

The package can be exercised without the app. Write a throw-away script outside the repository (it needs the
built package or `tsx --conditions=@glideworth/source`) that:

1. creates `stripeGateway(await createStripeClient(process.env.GLIDEWORTH_STRIPE_SECRET_KEY))`;
2. builds a `BillingService` with a `MemoryBillingStore` (call `store.addAccount('tacct000000000001', { email, name })`),
   `memoryLimiter()`, the pricing file, `publicUrl: 'http://localhost:5173'`, the `whsec_` from `stripe listen`, the
   portal configuration id, and `notify: async (n) => console.log(n.kind, n.accountId)`;
3. serves `POST /stripe/webhook` with `node:http` on a free local port, passing the raw body string and the
   `stripe-signature` header to `service.handleWebhook`, answering with the returned status;
4. calls `service.startTrial(...)`, `service.createCheckout(...)` and prints the URL to open in a browser.

Point `stripe listen --forward-to` at that port and run sections 4 to 9, reading state with `service.status(id)`.

## Stripe documentation checked (2026-11-16)

| Page                                                              | Confirmed                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| https://docs.stripe.com/webhooks (manual verification section)    | `Stripe-Signature` entries `t`, `v1` (HMAC-SHA256 of `t.body`), `v0` sandbox-only and to be ignored, unsigned debug entries `secret`/`destination`/`payload`; accept unknown entries, any order; several `v1` while a secret is rolled (old secret kept up to 7 days, one signature per secret); constant-time compare; library default tolerance 5 minutes; never tolerance 0; new timestamp and signature on every retry; no ordering guarantee; `created` is in seconds and can tie |
| https://docs.stripe.com/events/manage-webhook-endpoints           | Roll secret with delayed expiry up to 7 days; duplicate handling by event id; verify before dedupe; respond 2xx quickly                                                                                                                                                                                                                                                                                                                                                                |
| https://docs.stripe.com/events/set-up-events                      | Snapshot events need `constructEvent`; fetch the latest object before critical actions                                                                                                                                                                                                                                                                                                                                                                                                 |
| https://docs.stripe.com/api/checkout/sessions/create              | API version `2026-10-28.endive`; `subscription_data.trial_end` "Has to be at least 48 hours in the future"; `customer_update` only with `customer`; `billing_address_collection` `auto`/`required`; `expires_at` 30 min to 24 h; `client_reference_id` max 200                                                                                                                                                                                                                         |
| https://docs.stripe.com/tax/checkout/tax-ids                      | With an existing customer, `tax_id_collection` needs `customer_update[name]=auto`; address from `customer_update[address]=auto`                                                                                                                                                                                                                                                                                                                                                        |
| https://docs.stripe.com/api/customer_portal/configurations/create | `features.customer_update.allowed_updates` includes `tax_id`; `subscription_cancel.mode` `at_period_end`; `subscription_update.products[]` (max 10), `proration_behavior`, `schedule_at_period_end.conditions` (`shortening_interval`), `trial_update_behavior`; `metadata`                                                                                                                                                                                                            |
| https://docs.stripe.com/api/customer_portal/sessions/create       | `customer`, `configuration`, `return_url`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| https://docs.stripe.com/api/prices/create and /api/prices/list    | `lookup_key` max 200; `transfer_lookup_key`; `tax_behavior` cannot change once set; `currency_options.<cur>.{unit_amount,tax_behavior}`; list returns active prices only unless `active=false`; `lookup_keys` up to 10 per call                                                                                                                                                                                                                                                        |
| https://docs.stripe.com/api/products/create                       | `id` may be set and must be unique                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| https://docs.stripe.com/billing/subscriptions/overview            | Status meanings (`incomplete` 23 h, `incomplete_expired` terminal, `past_due`, `unpaid` revoke access, `canceled` terminal, `paused`); failed payment settings decide `unpaid`/`canceled`                                                                                                                                                                                                                                                                                              |
| https://docs.stripe.com/api/subscriptions/object                  | Period end on `items.data[].current_period_end`; `cancel_at`, `cancel_at_period_end`, `canceled_at` semantics; `pause_collection` does not change status                                                                                                                                                                                                                                                                                                                               |
| https://docs.stripe.com/api/subscriptions/cancel                  | `prorate`, `invoice_now` default false; DELETE (no idempotency key)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| https://docs.stripe.com/api/webhook_endpoints/create              | `url`, `enabled_events`, `description`, `api_version` (includes `2026-10-28.endive`); `secret` returned only on create; event descriptions for every handled type (`trial_will_end` 3 days before, `paused`/`resumed` only for `status=paused`)                                                                                                                                                                                                                                        |
| https://docs.stripe.com/api/refunds/create                        | `charge` or `payment_intent`; `amount`; `reason` enum `duplicate`/`fraudulent`/`requested_by_customer`                                                                                                                                                                                                                                                                                                                                                                                 |
| https://docs.stripe.com/api/idempotent_requests                   | All v1 POSTs accept keys; keys up to 255 chars, pruned after at least 24 h; reuse with different parameters errors; no keys on GET/DELETE                                                                                                                                                                                                                                                                                                                                              |
| https://docs.stripe.com/testing                                   | Test cards used above                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| https://docs.stripe.com/billing/testing (test clocks)             | Dashboard "Run simulation", up to two intervals per advance; failed-renewal test with 4000 0000 0000 0341; 3DS with 4000 0027 6000 3184; magic tax IDs                                                                                                                                                                                                                                                                                                                                 |
