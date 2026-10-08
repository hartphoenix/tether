# Tether documentation

Try your first comment exchange with the [getting-started guide](getting-started.md). A local profile uses files on your Mac; a shared profile connects browsers and agents to one library across file machines.

## Using Tether

- [Markdown rendering](guide/markdown-support.md): supported syntax and current rendering limitations.
- [Folio and sharing](guide/folio.md): organize documents, preserve conversations, and share reviews.
- [Host setup](guide/hosts.md): choose cmux, Wave, or a separate browser.
- [Agent setup](guide/agent-setup.md): install and maintain the optional review skill.
- [Installation and updates](guide/installation.md): package locations, updates, and uninstall.
- [Recovery and backups](guide/recovery.md): reconnect saved views and restore private data.
- [Shared profiles](guide/shared-profile.md): one library across file machines, authenticated readers, and headless source deployment.
- [Tether Fly setup](guide/fly-setup.md): agent-assisted setup, shared Paseo connections, revocation, and relocation.

## Using the CLI

Use the [CLI reference](reference/cli.md) to review comments and work with files. For pagination, diagnostics, limits, and write guarantees, see [protocol details](reference/protocol.md). Run `tether <command> --help` for exact arguments.

## Contributing

Start with [CONTRIBUTING.md](../CONTRIBUTING.md) to run Tether from source and check your changes. The [architecture and code map](contributing/architecture.md) helps you find your way through the code; [package verification](contributing/packages.md) covers builds and installation checks. Agents working on a checkout should read [AGENTS.md](../AGENTS.md).

The experimental [phone reader](contributing/phone-reader.md) has a separate [CLI operations guide](contributing/phone-reader-operations.md) for supervision and source deployments.

Use [local phone staging](contributing/phone-staging.md) to preview the phone reader in a Paseo browser tab with disposable state.

Use [local Settings staging](contributing/settings-staging.md) for resettable Fly setup simulations and page-specific Agentation feedback.
