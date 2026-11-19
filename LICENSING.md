# Licensing

This page explains which licence applies to which part of Glideworth. It is a summary for people;
the licence texts themselves are what bind. It is not legal advice.

## At a glance

| Part                                                          | Licence                                                       | Where the text is                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| Everything in this repository, except the rows below          | GNU Affero General Public License v3.0 only (`AGPL-3.0-only`) | [`LICENSE`](LICENSE)                                       |
| `packages/importers`                                          | MIT                                                           | [`packages/importers/LICENSE`](packages/importers/LICENSE) |
| Bundled data (market-history series, tax tables, sample data) | Each source has its own terms                                 | [`DATA-LICENSES.md`](DATA-LICENSES.md)                     |
| Third-party dependencies                                      | Their own licences                                            | [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)         |
| The Glideworth name and logo                                  | Not licensed under any of the above                           | [`TRADEMARKS.md`](TRADEMARKS.md)                           |

Copyright in the code is held by Web Ninja FZCO, a free zone company in Dubai, United Arab Emirates, and by each
contributor for their own contributions (contributors license their work to the project; they do not assign it:
see [`CLA.md`](CLA.md)).

## The application: AGPL-3.0-only

The planner (`packages/core`, `apps/api`, `apps/web` and the supporting scripts, documentation and
configuration) is licensed under `AGPL-3.0-only`. In practice:

- You may use, study, change and share it, for any purpose, including commercially.
- If you distribute a copy, you must pass on the same licence and the source.
- If you change it and let other people interact with your modified version over a network (for
  example by running it as a hosted service), you must offer those users the source of your modified
  version. This is the part of the AGPL that differs from the ordinary GPL.
- Running an unmodified copy for yourself, your family or your company needs nothing further.

"Only" means version 3 and no later version unless the project's licence is deliberately changed by
its copyright holders (see [`CLA.md`](CLA.md) for how contributions allow that).

## The importers package: MIT

`packages/importers` (ProjectionLab and CSV import and the JSON / CSV / report exporters, and
any future client SDK) is MIT-licensed so that other software can read and write these formats, or call
the API, without taking on the AGPL's network clause. The package depends on `packages/core`, which is
AGPL-3.0-only. Check with your own lawyer how that dependency affects what you build on it; the MIT
file covers only the code in the importers package itself.

## Bundled data has its own terms

Some files in this repository are data, not code: historical return and inflation series, tax tables,
exchange-rate defaults and synthetic samples. They come from public sources with their own conditions
(attribution, share-alike, non-commercial and so on). Those terms are recorded in
[`DATA-LICENSES.md`](DATA-LICENSES.md). The AGPL does not replace them. If you redistribute or host the
software, follow the terms listed there.

## Self-hosted builds are complete

The build you get from this repository is the whole product. There is no separate paid edition, no
feature that is switched off unless you pay, no licence key and no usage reporting (telemetry). The
hosted Glideworth service sells convenience (we run it, back it up and keep it updated), not code. Any
code that exists only for the hosted service, such as billing and multi-customer accounts, is in this
repository under the same licence and stays out of the way of a self-hosted install.

If that rule is ever changed for a future feature, the change will be announced in advance and recorded
here.

## Contributing

By contributing you agree to the terms in [`CLA.md`](CLA.md). Your contribution is licensed to the
project under the licence of the part of the repository it goes into (AGPL-3.0-only, or MIT in
`packages/importers`), and the CLA lets the project owner relicense it in the future, with a written promise that contributions stay
available under an open-source licence.

## Using Glideworth in your own product

- **Self-hosting for yourself or your organisation:** allowed, no obligations beyond keeping the licence
  notices.
- **Hosting a modified version for others:** allowed; publish your modified source to those users.
- **Hosting an unmodified version for others:** allowed; keep the notices and link to the source.
  You may not present it under the Glideworth name (see [`TRADEMARKS.md`](TRADEMARKS.md)).
- **Embedding it in closed-source software:** not possible under the AGPL. Ask about a commercial
  licence: `licensing@glideworth.com`.
- **Reading or writing the supported file formats from your own software:** use `packages/importers`
  (MIT).
