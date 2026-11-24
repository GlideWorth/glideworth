## What and why

<!-- One or two sentences. Link the issue: "Closes #123". -->

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` and `pnpm format:check` pass (run `pnpm format` to fix formatting)
- [ ] `pnpm test` passes, and I added or updated tests for this change
- [ ] `pnpm build` passes
- [ ] I signed the CLA (the CLA check on this pull request is green) -- see `CLA.md`
- [ ] Fixtures are synthetic. No real financial data, names, account numbers or credentials
- [ ] Docs updated if behaviour, configuration or an API changed
- [ ] Package boundaries respected (`core` has no Node or DOM APIs; see `CONTRIBUTING.md`)

### Tax rule or jurisdiction changes only

- [ ] I cite the official source (URL, document and section) for every figure, with the date I read it
- [ ] I added test vectors with the expected result and where it comes from
- [ ] I updated the "not modelled" list for the country if the change leaves something out

### AI tools

- [ ] No AI tool was used, **or** I name it and say what it did: <!-- e.g. "Claude Code wrote the code and tests; I reviewed the tax figures" -->
