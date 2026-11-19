# IndexNow

IndexNow tells participating search engines that URLs on glideworth.com have changed. The
request is a POST of the sitemap's URLs to `https://api.indexnow.org/indexnow`. This site does
not send it from CI or from a deploy. Run it by hand, after the site that contains the key file
is live. Submitting before that deploy does nothing useful: the engine fetches the key URL and
rejects the request when the file is not there yet.

## Key

The key is `90abf381325f8bcc1f145c06aeb4946e`.

The file `public/90abf381325f8bcc1f145c06aeb4946e.txt` is copied to the site root on build, so the
live URL is:

`https://glideworth.com/90abf381325f8bcc1f145c06aeb4946e.txt`

The file contains the key and nothing else. The script compares the trimmed body.

## Run

From the repository root, or from `apps/site`:

```bash
pnpm indexnow:submit -- --dry-run
pnpm --filter @glideworth/site indexnow:submit -- --dry-run
```

`--dry-run` fetches `https://glideworth.com/sitemap.xml`, follows the child sitemaps (that URL is
a sitemap index, not the URL list), and prints how many URLs would be sent. It does not POST, and
it does not need the key file to be deployed.

A real run, only once the key file is on the live site:

```bash
pnpm indexnow:submit
```

The script refuses any host other than `glideworth.com`, fetches the key file and checks it, then
POSTs. `200` and `202` are success. `INDEXNOW_BASE_URL` overrides the sitemap origin (for a dry
run against another copy of the sitemap). A real submit still refuses a host that is not
glideworth.com.

Do not add this script to a workflow. The production deploy already publishes the site; IndexNow
is a separate, optional ping.
