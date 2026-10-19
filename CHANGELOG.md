# Changelog

All notable changes to **Flashback Diff** are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-19

### Added

- **Compare with Branch Origin** command in the Explorer, editor, tab context menus and editor title bar.
- Automatic origin detection using the git reflog (`checkout -b`, `switch -c`, `branch <name> <start>`).
- Fallback detection based on the closest merge-base, with configurable preferred branches.
- **Choose Branch Origin…** command, which remembers the choice per repository and branch.
- **Reset Branch Origin Detection** command.
- Settings: `flashbackDiff.baseBranch`, `flashbackDiff.preferredBranches`, `flashbackDiff.showTitleButton`.
- Support for files added on the branch, which are compared against an empty file.
- **Flashback Diff** log output channel.
