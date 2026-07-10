# Pi Extensions

A standalone npm-workspaces project for small, auditable Pi extensions.

The first package is **pi-extension-doctor**, a command-triggered, read-only diagnostic for extension conflicts and stale Pi APIs. It has no runtime dependencies and does not import or execute inspected extension source.

Implementation and release follow the evidence gates in [`specs/001-popular-pi-extension-suite/tasks.md`](specs/001-popular-pi-extension-suite/tasks.md). The process is coordinated with [OMK](https://github.com/dmae97/omk); published extensions remain standalone Pi packages with no OMK runtime dependency.
