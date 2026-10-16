# Tether documentation

To try your first comment exchange, start with the [getting-started guide](getting-started.md). Tether runs locally on your Mac, so your agent needs access to the same files and the `tether` command.

## Using Tether

- [Host setup](guide/hosts.md): use Tether in Paseo, cmux, Wave or a separate browser.
- [Tether in Paseo](guide/paseo.md): install the Paseo plugin, use Folio and panels, and annotate agent chats.
- [Folio and sharing](guide/folio.md): organize documents, keep conversations and share reviews.
- [Writing and formatting](guide/markdown-support.md): editing tools, supported Markdown, links, images and diagrams.
- [Visual annotations](guide/visual-annotations.md): select regions, reattach threads and retrieve visual evidence.
- [Agent setup](guide/agent-setup.md): install and update the optional agent skills.
- [Installation and updates](guide/installation.md): package locations, updates and uninstalling.
- [Recovery and backups](guide/recovery.md): agent runbook for reconnecting views, login startup and backing up private data.

## Using the CLI

The [CLI reference](reference/cli.md) covers reviewing comments and working with files. [Protocol details](reference/protocol.md) cover pagination, diagnostics, limits and write guarantees. Run `tether <command> --help` for exact arguments.

## Release notes

- [Tether 0.1.4](releases/0.1.4.md)

## Contributing

To run Tether from source and check your changes, start with [CONTRIBUTING.md](../CONTRIBUTING.md). The [architecture and code map](contributing/architecture.md) explains how the code is organized, and [package verification](contributing/packages.md) covers builds and installation checks. Agents working in a checkout should read [AGENTS.md](../AGENTS.md).

[Visual annotation implementation](contributing/visual-annotations.md) covers capture, identity, private evidence and resource limits.
