# Security policy

Glideworth handles people's financial plans, so security reports are taken seriously. This project is
maintained by one person at present; the targets below are ones that can honestly be kept.

## Supported versions

Security fixes are made for:

| Version                    | Supported                                                                       |
| -------------------------- | ------------------------------------------------------------------------------- |
| The latest release         | Yes                                                                             |
| The previous minor release | Critical and high severity fixes only, for 90 days after the next minor release |
| `main` (development)       | Yes, but it is not a release                                                    |
| Anything older             | No: upgrade                                                                     |

The hosted service always runs the latest release. It is operated by Web Ninja FZCO, a free zone company in
Dubai, United Arab Emirates.

## How to report a vulnerability

**Do not open a public issue, discussion or pull request for a security problem.** Use either of these:

1. **GitHub private vulnerability reporting.** On the repository, open the _Security_ tab and choose
   _Report a vulnerability_. This is preferred, because it keeps the whole thread and the fix in one place.
2. **Email `security@glideworth.com`.** Plain email is acceptable. No PGP key is published. If the details
   are sensitive, send a first message without them and say so, and we will agree a safer way to send them.

### What to include

- what is affected: the self-hosted app, the hosted service, the REST API, the MCP server, the Docker
  image, or a dependency;
- the version or commit, and how you ran it;
- the steps to reproduce, ideally a small proof of concept using synthetic data;
- what an attacker gains (read, write or delete data, run code, take over an account, escape a tenant);
- any suggested fix, and whether you plan to publish and when.

Do not send real financial data, other people's data, or live credentials. If you saw such data by
accident, tell us, stop, and delete it.

## What to expect

| Step                                                                  | Target                                                                                   |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Acknowledge your report                                               | within 3 working days                                                                    |
| First assessment (accepted, not a vulnerability, or need more detail) | within 10 working days                                                                   |
| Fix or mitigation for critical and high severity                      | aim for 30 days from confirmation                                                        |
| Fix for medium and low severity                                       | next regular release                                                                     |
| Public advisory                                                       | after a fix is released, normally within 90 days of the report, and coordinated with you |

These are targets, not guarantees. If the project owner is unavailable for longer than a week, the
acknowledgement may be late; a reminder to the same address is welcome. You will be told if a date will
slip. With your agreement, you are credited in the advisory (or kept anonymous if you prefer). There is
no bug-bounty programme at present, and no payment is promised.

## Scope

In scope:

- **The self-hosted application**: `apps/api`, `apps/web`, `packages/*`, the Docker image and the
  default configuration (authentication, sessions, CSRF, throttling, API keys, share links, webhooks
  including SSRF protection, file import parsing, the backup and restore commands).
- **The hosted service** at glideworth.com and its subdomains: sign-up and sign-in,
  tenant isolation, billing integration, account export and deletion.
- **The REST API** (`/api/v1`) and its OpenAPI document.
- **The MCP server** (`/mcp` and the stdio server), including scope and write-switch enforcement and
  anything that lets a prompt-injected agent exceed the permissions of its key.

Out of scope (report them to the right owner, or they will be closed):

- vulnerabilities in third-party services we use (report to them), unless our configuration makes them
  exploitable;
- denial of service by volume, spam, social engineering, physical attacks;
- missing hardening headers or best-practice settings with no demonstrable impact;
- findings that need a modified or already-compromised host or browser, or the owner's own passphrase;
- an instance that its operator deliberately exposed without the recommended setup token and TLS;
- tax or calculation errors: these are bugs, not vulnerabilities (use the tax-rule correction form).

## Safe harbour

We will not pursue or support legal action against you, and will treat your work as authorised, if you
act in good faith and:

- follow this policy and stay within scope;
- test only against your own instance, or your own account on the hosted service;
- avoid accessing, changing or keeping data that is not yours, and stop as soon as you see it;
- do not degrade the service for others, and do not publish details before a fix or the agreed date;
- give us reasonable time to respond.

This is a statement of intent by the project; it cannot bind third parties (such as a hosting
provider) or change the law that applies to you.

## What not to do

- **Do not test the hosted service against other customers' accounts or data.** Create your own
  account, and, to prove a tenant-isolation flaw, use two accounts that you own. If you cannot prove it
  without touching someone else's data, report what you have and stop.
- Do not run automated scanners at high volume against the hosted service.
- Do not use social engineering, phishing, or physical access against the project, its users or its
  providers.
- Do not attempt to keep, sell or disclose data you reach by mistake.
- Do not extort or threaten disclosure to obtain payment.

## For operators who self-host

Use TLS, set a setup token before exposing a new instance, keep the image up to date, and keep backups
(see [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md)). Watch the repository's security advisories.
