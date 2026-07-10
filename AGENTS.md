# Pi Extensions Development Rules

- Scope all edits and commands to this standalone project directory.
- Package manager: npm. Node.js: >=22.19.0.
- Runtime packages must keep zero `dependencies` unless explicitly approved.
- Pin every direct development dependency exactly and install with lifecycle scripts disabled.
- TypeScript must be strict and erasable; use top-level imports and `.ts` relative imports.
- The doctor may read only trusted package roots and declared entries. It must not import inspected source, spawn processes, use network/credentials, emit telemetry, or write during diagnosis.
- Never expose absolute paths, source snippets, prompts, sessions, credentials, tokens, terminal controls, or raw filesystem errors.
- Do not commit, tag, push, publish, create repositories, or dispatch workflows without explicit approval.
- After code changes run `npm run check` and targeted tests. Do not claim completion without fresh evidence.
