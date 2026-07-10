# pi-extension-doctor

Local, command-triggered diagnostics for Pi extension conflicts and stale APIs.

## Install

```bash
pi install npm:pi-extension-doctor
```

Or try it without installing:

```bash
pi -e npm:pi-extension-doctor
```

## Use

Run `/extension-doctor` in Pi. Use `/extension-doctor --json` for deterministic JSON output.

The report distinguishes:

- `confirmed`: conflict visible through Pi's public runtime inventory;
- `inferred`: pattern found by bounded static inspection;
- `unknown`: a path, encoding, deadline, or resource boundary prevented a safe conclusion.

## Safety boundary

The doctor performs bounded reads of package roots already reported by Pi and extension files explicitly declared in each package's `pi.extensions` manifest. It does not recursively search your home directory or `node_modules`.

The doctor does not import or execute inspected source, access credentials, use the network, start subprocesses, upload telemetry, modify files, install packages, or repair extensions. Pi may already have loaded active extensions before the command runs; this package does not claim to prevent host execution.

Output omits source snippets, stack traces, and absolute paths. Untrusted identifiers and paths are length-bounded and terminal-control escaped.

## Compatibility

The supported host contract is `@earendil-works/pi-coding-agent@0.80.6` on Node.js 22.19 or newer. Older Pi releases and OMK are not claimed as compatible.

## Built and verified with OMK

The release process for this package is coordinated and evidence-gated with [OMK](https://github.com/dmae97/omk). `pi-extension-doctor` remains a standalone Pi extension: OMK is not a runtime dependency.

## License

MIT
