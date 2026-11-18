-- The free trial is a no-card local trial again: it starts when the workspace is created and ends 14 days later.
-- Workspaces created under the card trial that never went through Checkout (and were still owed a trial) get
-- their 14 days from now. Workspaces that already had a Stripe trial or subscription are left to Stripe.
UPDATE `subscriptions`
SET `trial_ends_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+14 days'),
    `version` = `version` + 1
WHERE `status` = 'trialing_local'
  AND `stripe_subscription_id` IS NULL
  AND `trial_ends_at` IS NULL
  AND `trial_available` = 1;
