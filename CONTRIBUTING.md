# Contributing to AgentPatchCheck

Thanks for your interest in contributing to AgentPatchCheck. Contributions are
welcome when they improve controlled, repository-level software repair and its
evaluation evidence.

## Contribution focus

The most useful contributions currently improve one of these areas:

- APC Runtime reliability, policy boundaries, tool execution, and evidence.
- Harness and evaluator integration, including execution and grading validity.
- APC Console read-only artifact and benchmark-result inspection.
- Cross-platform and runtime reliability on macOS, Linux, and Windows.
- Focused regression coverage for the paths above.

## Reporting bugs

Before opening an issue, search the [existing AgentPatchCheck issues](https://github.com/aravelo7/AgentPatchCheck/issues).
Please include the smallest reproducible case, expected and actual behavior,
OS and Node.js versions, relevant command output, and any safe artifact or
trace identifiers. Do not include credentials, private repository contents, or
unredacted sensitive output.

## Before contributing

For non-trivial changes, open an issue first to describe the problem and
proposed scope. Keep pull requests small, preserve frozen benchmark boundaries,
and avoid combining runtime, benchmark, and documentation changes unless they
must move together.

## Development setup

1. Clone the repository:

   ```bash
   git clone https://github.com/aravelo7/AgentPatchCheck.git
   cd AgentPatchCheck
   ```

2. Install the applicable dependencies:

   ```bash
   npm install
   ```

   For the independent local Console:

   ```bash
   cd apc-console
   npm ci
   ```

3. Run focused checks for the area changed. At minimum, use `npm run typecheck`
   and `git diff --check`; use the documented runtime, Console, or benchmark
   verification for the affected path.

## Submitting changes

- Keep changes focused and add regression coverage where appropriate.
- Use production-quality TypeScript and standard top-level imports.
- State what was verified and what was intentionally not run.
- Reference a related issue when applicable.

## License

By submitting a pull request, you agree that your contributions will be
licensed under the project's [Apache 2.0 license](./LICENSE).
