# Kalamos guidelines

## Changesets

- Include a `.changeset/<name>.md` file in the same PR as any app change that belongs in the release notes (see the [release guide](docs/release.md)); skip it for documentation-only changes and internal changes with no user impact.
- Do not create empty or placeholder changesets: write each file directly with YAML front matter that sets `"kalamos"` to `patch`, `minor`, or `major`, followed by a short, non-empty summary of the user-facing change.
