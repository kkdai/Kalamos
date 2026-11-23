# Kalamos guidelines

## Changesets

- **Scope**: Include a `.changeset/<name>.md` file in the same PR for any user-visible app change (new features, bug fixes, or behavior changes; see the [release guide](docs/release.md)). Do not proactively add a changeset for documentation, product page, CI, or internal refactoring changes—the maintainer decides whether to include those in the release notes.
- **External contributors**: A missing changeset on an external-contributor PR does not block review or merge; the maintainer adds it when needed.
- **Bump type**: Use `minor` for new features and `patch` for bug fixes and small improvements. There is currently no need for `major` bumps.
- **Summary language & format**: Write the summary in Traditional Chinese (Taiwan usage), matching `CHANGELOG.md`: `**標題**：說明（#PR）`. Omit `（#PR）` when the PR number is unknown; the maintainer will add it. Put only one change per changeset file (split multiple changes into separate files so `CHANGELOG.md` does not end up with nested lists), and do not create empty or placeholder changesets.
- **Writing files as an agent**: `npm run changeset` is interactive, so write the file directly using a kebab-case filename (e.g., `.changeset/ctrl-wheel-zoom.md`) with `"kalamos"` quoted in the YAML front matter:

```md
---
"kalamos": minor
---

**Ctrl + 滾輪縮放**：按住 Ctrl 滾動滑鼠滾輪即可縮放介面（#112）。
```

## Development checks & conventions

- **Checks**: Run the relevant checks before finishing:
  - `npx biome ci`
  - `npx tsc --noEmit`
  - `npx vitest run`
  - `CI=1 npx playwright test`
- **READMEs**: Keep all four README files in sync (`README.md`, `README.zh-TW.md`, `README.ja.md`, `README.ko.md`) when updating user-facing documentation.
- **Cross-platform**: Kalamos targets both macOS and Windows—account for platform-specific shortcuts, menus, file paths, and native behavior when making changes.
