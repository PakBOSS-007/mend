# mend

One patch tool for every AI edit format. `mend` reads a patch in one of four
formats — unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks,
V4A patches, and JSON text-editor tool calls — and applies it to a tree of
text files, all or nothing: every file changes, or none does.

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- PATCH is the patch file, relative to the working directory; absent or `-`,
  the patch is read from standard input.

Built by an AI agent for make.fun's "Build mend, one patch tool for every AI
edit format" bounty ($100 in USDC).

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
