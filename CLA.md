# Glideworth Individual Contributor Licence Agreement

> **Version 1, 2026-11-16.** This agreement is a licence, not a transfer of ownership: you keep the copyright
> in your contributions. It is written in plain language and has not been reviewed by a lawyer. If you want
> advice before you sign, get your own.

**Basis.** This agreement follows the structure and most of the operative ideas of the Apache Software
Foundation's Individual Contributor License Agreement, version 2.2
(<https://www.apache.org/licenses/icla.pdf>), which is widely used and widely reviewed. It is
re-written in original wording, not copied, and differs from the Apache text in these ways:

1. the receiving party is the Glideworth project owner, not a foundation;
2. section 2 adds an explicit right to relicense (including under other terms), which is the reason this
   project asks for a CLA at all (see [`LICENSING.md`](LICENSING.md)), together with a written promise that
   your contribution will always also stay available under an open-source licence;
3. section 4 keeps an agreement not to assert moral rights, to the extent the law allows, and an
   inbound-equals-outbound promise for the parts of the repository that are MIT-licensed;
4. signing happens electronically, by a pull-request comment, with the record stored in this repository.

Project Harmony's CLA templates (<https://www.oss-cla.org/>, CC BY 3.0) were consulted for the relicensing
wording.

---

**Definitions.**

- **"Project Owner"**: Web Ninja FZCO, a free zone company in Dubai, United Arab Emirates, registered address
  Unit 001-46348, Building A1, Dubai Digital Park, Dubai Silicon Oasis, Dubai, United Arab Emirates, which
  owns and runs the Glideworth project, and its successors and assigns.
- **"You"**: the individual, aged 18 or over, who signs this agreement (or, if the individual is employed,
  the individual together with the employer whose permission is covered in section 6).
- **"Contribution"**: any original work of authorship, including any modification or addition to an
  existing work, that You intentionally submit to the Project Owner for inclusion in the Glideworth
  repository (the public repository linked from <https://glideworth.com/open-source/>, and any successor) or in any
  other work the Project Owner maintains. "Submit" means any form of electronic, verbal or written
  communication sent to the Project Owner or its representatives, including pull requests, patches,
  issues and mailing lists, but excluding communication that You conspicuously mark "Not a
  Contribution".
- **"Project"**: the Glideworth software and its documentation, and any other work the Project Owner
  maintains that accepts Your Contribution.

## 1. Copyright licence

You grant the Project Owner, and everyone who receives software from the Project Owner, a perpetual,
worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright licence to reproduce, prepare
derivative works of, publicly display, publicly perform, **sublicense** and distribute Your Contributions
and any derivative works of them, in source or object form.

## 2. Right to relicense

Without limiting section 1, You agree that the Project Owner may license Your Contributions, as part of
the Project or separately, under the licence the Project currently uses (AGPL-3.0-only, or MIT for the
parts so marked), **and under any other licence terms the Project Owner chooses**, including later
versions of the same licence, other open-source licences, and proprietary or commercial licences. You
keep the copyright in Your Contributions and may use them for any other purpose.

**Our promise to you.** The Project Owner promises that Your Contributions will always also remain available
under an open-source licence approved by the Open Source Initiative. In particular, the version of the Project
that was current when You made Your Contribution will remain available under such a licence. Licensing the
Project under other terms as well, as this section allows, does not withdraw that licence.

## 3. Patent licence

You grant the Project Owner, and everyone who receives software from the Project Owner, a perpetual,
worldwide, non-exclusive, no-charge, royalty-free, irrevocable (except as stated in this section) patent
licence to make, have made, use, offer to sell, sell, import and otherwise transfer the Project and Your
Contributions, where that licence applies only to those patent claims that You can license and that are
necessarily infringed by Your Contribution alone or by combining Your Contribution with the Project to
which it was submitted. If anyone starts patent litigation (including a cross-claim or counterclaim)
alleging that Your Contribution or the Project infringes a patent, every patent licence granted to that
person under this agreement for that Contribution or Project ends on the date the litigation starts.

## 4. Moral rights and inbound terms

To the extent the law allows, You agree not to assert moral rights in Your Contributions against the Project
Owner and its licensees. Where the law does not allow that, You keep those rights and the Project Owner will
use Your Contribution in a way that respects them. For files in the parts of the repository that are licensed
under MIT (currently `packages/importers`), Your Contribution is also available to everyone under those
MIT terms.

## 5. Your representations

You confirm that:

1. each Contribution is Your original creation, or You have the right to submit it under this agreement
   (see section 7 for third-party work);
2. You are legally entitled to grant the licences above. If Your employer, school or anyone else has
   rights in Your Contributions (for example through an employment contract), You have permission from
   them, or they have waived those rights, to make the Contribution under this agreement (section 6);
3. Your Contribution does not, to Your knowledge, violate any third party's rights;
4. no Contribution contains personal data, credentials, or real financial data of You or anyone else.
   The project accepts synthetic fixtures only;
5. where machine-generated code or text is part of a Contribution, You have reviewed it, are entitled
   to submit it, and have disclosed its use as the contribution guide requires.

You are not required to provide support for Your Contributions. Unless You say otherwise in writing or in
the pull request, Your Contributions are provided "as is", without warranties or conditions of any kind,
express or implied, including title, non-infringement, merchantability and fitness for a particular
purpose.

## 6. Employers

If Your employer or another party may claim rights in Your Contributions, get their written permission
before You sign, and give the Project Owner their details if asked. The project does not offer a separate
corporate agreement at present. If You cannot get that permission, do not contribute.

## 7. Work that is not Yours

If You want to submit work that is not Your own creation, submit it separately from any Contribution,
identify clearly the source, the licence and the author, and mark it "Submitted on behalf of a third
party: (name)". The Project Owner will decide whether it can accept it.

## 8. Notices and changes

You agree to tell the Project Owner if any statement in this agreement becomes inaccurate. The Project
Owner may publish a new version of this agreement. A new version applies only to Contributions You make
after You accept it; it does not reduce rights already granted for Contributions made earlier.

## 9. General

This agreement is governed by the laws applicable in the Emirate of Dubai and the federal laws of the United
Arab Emirates, and the courts of Dubai have jurisdiction. That jurisdiction is not exclusive for You: You
may also bring a claim in the courts of the country where You live, and You keep the protection of the
mandatory laws of that country. If any part is unenforceable, the rest stays in force. This is the entire agreement
between You and the Project Owner about Your Contributions.

---

# How to sign

You sign once, in the first pull request you open. The signature covers every Contribution You make
afterwards, until the agreement text changes (see section 8).

## Automatic process (default)

1. Open a pull request. The CLA workflow ([`.github/workflows/cla.yml`](.github/workflows/cla.yml)) runs
   the [contributor-assistant](https://github.com/contributor-assistant/github-action) action and
   comments on the pull request if You have not signed.
2. Read this document.
3. Post exactly this comment on the pull request:

   ```
   I have read the CLA Document and I hereby sign the CLA
   ```

4. The bot records Your GitHub username, numeric user id, the pull request and the time in
   `signatures/version1/cla.json` on the `cla-signatures` branch of this repository, and the CLA check
   turns green. Comment `recheck` to run the check again.
5. If You are contributing on behalf of Your employer, say so in the same comment thread and do not sign
   until the employer has given permission (section 6).

Signatures are public, because the repository is. The record holds Your GitHub login and id, not Your
email address or legal name. The Project Owner is the controller of that record and keeps it for as long as
the Contribution is distributed, so that it can show that You agreed. The manual process below is available if
You prefer to sign with Your name.

The project owner and bot accounts such as Dependabot are on the workflow's allow-list and do not need
to sign.

## Manual fallback

Use this if the bot is unavailable, You cannot use GitHub comments, or You prefer to sign with Your name.

1. Print the text above or save it as a PDF.
2. Send an email to `cla@glideworth.com` with the subject "Glideworth CLA" containing:
   Your full legal name, GitHub username, postal country, the sentence "I have read and agree to the
   Glideworth Individual Contributor Licence Agreement, version 1, 2026-11-16", and
   Your electronic signature (typed name is acceptable, or an attached signed PDF).
3. A maintainer replies to confirm, and adds Your GitHub username to the `allowlist` input in
   `.github/workflows/cla.yml` in a pull request of their own (and records the email in the project
   owner's private contributor register, kept for as long as the Contribution is distributed).
4. Your pull request can then be merged.

## For maintainers

- Never merge a pull request with a failing or missing CLA check, unless the author is on the allow-list.
- If the agreement text changes, bump the `path-to-signatures` version in the workflow
  (`signatures/version2/cla.json`), so every contributor signs the new text.
- The `cla-signatures` branch must exist and must not be protected, because the action writes to it. Do
  not give it any other content.
- A signature can be withdrawn only for Contributions not yet merged. Merged contributions stay licensed
  (section 1 is irrevocable).
