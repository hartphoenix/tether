![1.00](assets/tether-banner-dark.webp#gh-dark-mode-only)

![1.00](assets/tether-banner-light.webp#gh-light-mode-only)

# getting started with **tether**

Tether turns Markdown files into a conversation surface, keeping your attention clear and focused in long AI-driven projects. Here's how to use it:

1. **Leave a comment.** Highlight any sentence of this document, choose **Comment** (the rightmost button in the tooltip menu), and ask your agent a question or give an instruction.

   * You can leave dozens of comments on the same doc before the next turn. Your agent gets them all, each with context, using Tether's CLI tool.
   * Each comment starts a **thread**, helping you keep track of the many subtasks a single doc can produce.
   * The **Threads drawer**, opened with the top-right button in this window, shows all the open threads on a doc.

2. **Prompt your agent.** Tether collects your comments without activating an agent turn on every one. Once you want your agent to respond, say something like:

   > see comments

   If the agent hasn't seen the doc yet, give it the path:

   > review tether comments on `{{DOCUMENT_PATH}}`

   To copy a doc's path, open the Threads drawer and click **Copy file path**.

3. **Continue the thread(s).** Your agent decides where each answer belongs:
   * It replies to a single comment in that comment's thread, and a notification badge appears on the threads button.
   * When a comment asks for a revision, it edits the document text. If the highlighted text changes, the comment becomes "orphaned," but you can still find it in the threads drawer.
   * It answers broader questions in the chat.

Your Markdown stays in its original file. Comments are kept separate as private local data, so they aren't included when you share the file. Use **Export with annotations** to include open threads in a `.tether` package, and **Import annotations** (found in the folio) to add a `.tether` package from elsewhere.

# using the **folio**

Tether comes with an organizer called the **folio**. It keeps your active work in view and your projects separate, and it **opens a document in the current workspace with a click**. To open the folio:

* in **cmux**, use `⌘-⌥-B` to hide/show the folio. The first time, you may need to enable the **dock** in **settings > beta features > dock**, then choose **dock > Tether Folio**. If the folio tab closes or quits, type `tether folio` in a cmux terminal to reopen it.
* in **Paseo**, launch the folio into any workspace using the Tether logo button at the top right, then use `⌘-E` to show/hide it.
* in **Wave Terminal**, click the **Tether Folio** sidebar widget that installation added. The folio opens in the current workspace; press `⌘-W` while it's focused to close it.

The folio has these tools:

1. **Active** & **Archive** views

   * The top left button is the **Active** selector, which shows the number of active docs.
   * To its right is the **Archive**. To archive a doc, right-click it and choose **Archive**.
2. **Filters** & **Sorting**

   * The **Filter** (funnel) button saves custom searches. Type a word and press return to save it, then click its pill button to toggle it on or off. Filters match **file paths**, **file names**, and the **first H1 heading in each doc**.
   * The **Sorting** button changes how docs are ordered and grouped.
3. **Folio Menu** & **Right-Click Context Menu**

   * The top-right button in the folio has batch selection, importing, and app settings.
   * Right-click any document title in the folio for actions on that document.

# pro tips

To get even more out of Tether:

1. **Install Tether's bundled skills**

   Copy this prompt and paste it to your agent:

   ```
   Install Tether’s bundled skills. Run `tether setup --help`, find your skills directory, then run `tether setup --agent-directory <skills-directory> --skills tetherball --no-open` under the same OS account and Tether profile as this guide. This installs both tether-review and Tetherball and registers them for package updates. If existing instructions differ, preserve them and help me review the differences before replacing them.
   ```

   **tether-review** works in the background to help your agent handle documents and comments. Ask for **/tetherball** when you want to work through research, learning, or planning together in a shared document.

2. **Resolve finished threads & Archive old docs**

   To keep your attention focused:

   * use the **Resolve** button to hide finished comment threads.
   * once you're done with a document, right-click it in the folio and choose **Archive**.

3. Add a **filter** for each project:

   Click the **Filter** (funnel) button in the folio, type the project folder's name, and press return to save it as a filter. Add subdirectories or specific titles to narrow it further.

4. Use **hotkeys** to work faster:

   in **Paseo**:

   * `⌘-B` to hide/show **left** sidebar (workspaces)
   * `⌘-E` to hide/show **right** sidebar (dock/folio)
   * `⌘-1`, `⌘-2`, etc. to choose a workspace
   * `⌘-⇧-F` to make the current pane full-width
   * `⌘-,` **> Shortcuts** to customize Paseo hotkeys

   in **cmux**:

   * `⌘-B` to hide/show **left** sidebar (workspaces)
   * `⌘-⌥-B` to hide/show **right** sidebar (dock/folio)
   * `⌘-1`, `⌘-2`, etc. to choose a workspace
   * `⌘-⇧-↵` to make the current pane full-width
   * [More cmux hotkeys](https://cmux.com/docs/keyboard-shortcuts)

