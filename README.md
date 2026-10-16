![Tether: harness your attention](docs/assets/tether-banner-dark.webp#gh-dark-mode-only)
![Tether: harness your attention](docs/assets/tether-banner-light.webp#gh-light-mode-only)

# Tether

Tether is a local Markdown editor that works with your coding agent. It's crafted to improve your focus even when agentic work gets complex. Highlight a passage, leave a comment, and get a reply beside the text.

### The perennial focus problem

Your agent hands you a design document. Halfway through, you find a claim that needs more research, followed by a whole section you'd like to rethink. Meanwhile, you're still trying to parse the neuralese.

You might start a list of changes in the chat, losing your flow as you bounce between the draft and the chat window. Or you open the draft in an editor and start making inline edits, losing track of your own words amid the agent's. When the agent rereads the whole doc, your token spend balloons and the agent's attention scatters.

### Threads that don't unravel

**Tether** solves this with a workflow like Google Docs: highlight some text, write a question or todo, and keep going. Your comments collect in the sidebar, easy to find and edit. When you're ready, ask your agent to work through them. Its replies appear in those same threads, where you can keep discussing a point until you're satisfied.

Click **Resolve** on any thread you're done with to hide it. Quit the session and resume later with a different agent; anything unfinished will be there when you come back. A file organizer with custom filters keeps multi-draft projects moving.

**Tether works in macOS with any coding agent** with access to your local files and Tether's CLI. It integrates with [Paseo](https://paseo.sh/), [cmux](https://cmux.com/), and [Wave](https://www.waveterm.dev/), and also works in a separate browser.

The macOS package includes everything Tether needs to run.

[Try Tether](#try-tether) · [Set up your agent](#agent-review-cli) · [CLI reference](docs/reference/cli.md)

## Try Tether

If your agent can install and run programs on your Mac, give it this:

```
Help me install Tether from https://github.com/hartphoenix/tether. Read the README and follow the packaged installation instructions for my Mac. Then open the getting-started guide so we can test drive it.
```

### Prefer the terminal?

Run this in your terminal:

```sh
bash -o pipefail -c 'curl --proto "=https" --proto-redir "=https" -fsSL https://github.com/hartphoenix/tether/releases/latest/download/install.sh | bash'
```

When it finishes, the installer opens the [getting-started guide](docs/getting-started.md) for a practice exchange, followed by the release notes. If it prints a PATH command, run that to make `tether` available in your terminal. Setup uses the supported terminal you're in; `tether setup --host browser` selects a separate browser instead. See [host setup](docs/guide/hosts.md) for requirements and optional integrations.

Resume with `tether`, or use the **Open Tether.command** launcher at the path printed by the installer. To open a particular document:

```sh
tether open /path/to/doc.md
```

If an old tab can't connect, launch Tether again.

## Working in Tether

You and your agent can edit the same Markdown file and discuss individual passages in persistent threads. **Folio**, the document organizer, keeps active work together with project filters and pins. The archive preserves finished conversations in case you need them again.

The reader includes Tether Light, Tether Dark, Light Treason, and Dark Academia, followed by seven Paseo palettes: Light, Dark, Zinc, Midnight, Claude, Ghostty, and Pure Black. You can also make your own themes, set custom colors, and link fonts from Google Fonts.

![Tether Light in Paseo](docs/assets/tether-light-paseo.png)

*Tether Light in Paseo.*

![Tether Dark in Paseo](docs/assets/tether-dark-paseo.png)

*Tether Dark in Paseo.*

### Your files and conversations

Tether includes a WYSIWYG Markdown editor; any change to the document body saves automatically in that file. The app stores comments separately on your machine; opening or commenting on a file doesn't change its Markdown. Sharing the file alone doesn't share its comments. A `.tether` export lets you share the document with its open threads.

## Agent review CLI

The package includes the `tether` command. Agents use it under the same OS account and profile as the reader; `tether --help` lists the commands.

The [Tether review skill](integrations/agents/tether-review/SKILL.md) equips your agent for the review workflow, safe edits, and formatting. During agent-led setup, your agent asks whether you'd like the skill and installs it if you say yes. If you installed Tether yourself, ask your agent to run `tether setup --help` and help you add it.

The skill keeps your agent's Tether instructions in step with the app. Setup installs the version bundled with the package, and updates refresh it when those instructions change. **You're welcome to customize your copy**: during later updates, Tether keeps your edits and offers the new instructions for your review, so stale instructions don't steer future sessions. See [skill updates](docs/guide/agent-setup.md#skill-updates).

The optional [Tetherball skill](integrations/agents/tetherball/SKILL.md) helps you and your agent build a shared understanding in a document that evolves as questions, evidence and feedback reshape the work. Installing it also installs `tether-review`, and updates keep both current. Tether offers Tetherball in the release notes it opens after you install or update; you can also ask your agent to run `tether setup --agent-directory /absolute/path/to/skills --skills tetherball --no-open`.

Agents can also use the [CLI reference](docs/reference/cli.md) directly. It covers reading only the relevant comments and context, replying in threads, making safe edits, and registering finished documents in Folio.

## Help and development

Run `tether doctor` for installation and service diagnostics. [Host setup](docs/guide/hosts.md) covers terminal integration; [installation and recovery](docs/guide/installation.md) covers managed packages, updates, and backups.

Report problems in [GitHub Issues](https://github.com/hartphoenix/tether/issues), including your macOS and host/browser versions, what you tried, and what happened. See the [documentation map](docs/README.md) for guides and references, or [CONTRIBUTING.md](CONTRIBUTING.md) for source setup and checks.

Tether is maintained by [Hart the Phoenix](https://github.com/hartphoenix) and released under the [MIT license](LICENSE).

The Paseo chat annotation adapter adapts selection/Markdown recovery, composer editing and send-capture patterns from [Annotations by neunzig-zehn](https://github.com/neunzig-zehn/paseo-annotations), including inherited [Quote](https://github.com/keefeere/paseo-quote) work; see its [notices](integrations/paseo/chat/NOTICE.md).

Tetherball's writing-style rules adapt a [style guide by Mariven](https://gist.github.com/Mariven/17c2223a1293559a0b6868fbb136fedd).
