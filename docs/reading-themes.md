# Reading themes and the theme maker

Tether Light and Tether Dark share Hanken Grotesk headings, Source Serif 4 paragraphs, and DM Mono code. Their warm paper and blue-charcoal palettes take their cue from the proposed silver-and-slate ribbon logo. This is a starting design, not a claim that these are universally optimal reading fonts.

New profiles start with Tether Dark. Existing saved selections remain selected. Frame, Crepe, and Nord remain available in both light and dark variants.

## Using the theme maker

Choose a theme, then click the sliders button beside the theme picker. The selected theme supplies the starting palette and fonts. Headings, Paragraphs, and Code each have a font selector and separate size and weight controls. Paragraph controls also include line spacing, tracking, paragraph gap, and reading width. Colors have a swatch, hex input, and hue, saturation, and lightness sliders.

Changes preview on the open document. **Cancel** or **Escape** restores the selected theme. **Save theme** adds a named theme to the picker. Reopening a saved theme allows updating it, saving a separately named copy, or deleting it with an inline confirmation. Built-in themes cannot be overwritten or deleted. Saves belong to the Tether profile and survive daemon restarts; another open view picks them up on reload. Document text is unaffected.

Legacy themes supply their existing palette and font stacks; custom versions use the theme maker's reading layout and heading hierarchy. Their original font stacks retain the same installed-font fallbacks as before.

The panel sits beside the document on wider windows and overlays it in narrow views. Close it to assess the full reading width. Existing document zoom remains separate from saved typography settings.

## Choosing a paragraph face

**Legibility** concerns distinguishing individual characters; **readability** concerns sustained reading. A beautiful specimen establishes neither comfort over hours nor comprehension. Research found substantial differences between people's fastest and slowest fonts, and preference did not reliably identify the fastest choice. Those results measure reading performance under study conditions, not guaranteed gains or reduced fatigue for this particular font trio. [Wallace et al., 2022](https://research.adobe.com/publication/towards-individuated-reading-experiences-different-fonts-increase-reading-speed-for-different-individuals/)

These are design judgments to test against your own documents:

| Paragraph face | Character                                                  | Useful comparison                                                                       |
| -------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Source Serif 4 | Even, literary, relatively restrained                      | The initial choice for sustained prose; distinct from the crisp sans-serif headings     |
| Source Sans 3  | Open, practical, less bookish                              | Compare on technical documents, dense lists, tables, and frequent short scanning passes |
| Alegreya       | More calligraphic rhythm and expressive italics            | Try when literary character matters; notice whether its movement helps or distracts     |
| Hanken Grotesk | Clean, contemporary, visually consistent with the headings | Compare an entirely sans-serif document against the mixed default                       |

Cabin offers a softer sans-serif heading alternative; Alegreya headings make the document more overtly literary. All three proposed heading choices are bundled. DM Mono provides a quieter geometric counterpoint for code. It has actual weights 300, 400, and 500; the controls respect that range. Static fonts cannot produce every intermediate slider weight.

## What to tune before deciding

Start with size and line length, then line spacing. The defaults are 19px paragraphs, 1.65 line spacing, and a 68ch reading measure. A `ch` is the width of the font's zero, so 68ch is not exactly 68 characters of prose. Equal point sizes also do not imply equal apparent sizes: lowercase height and character width vary by face.

W3C's enhanced visual-presentation guidance recommends mechanisms for user-selected colors, lines no longer than 80 characters, increased spacing, and avoiding full justification. These are useful constraints, not proof that one particular setting is best for everyone. Tether keeps text left-aligned in English and allows independent adjustment of these dimensions. [W3C visual presentation](https://www.w3.org/WAI/WCAG21/Understanding/visual-presentation)

Subtle color should mean restrained saturation, not weak contrast. The default body colors exceed 7:1 against the page; links and inline code exceed 4.5:1 against their respective backgrounds. Links also retain an underline. The maker reports these three ratios and marks values below 4.5:1. This is a local contrast check, not a whole-interface accessibility certification. [W3C contrast minimum](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html)

Try Source Serif 4 and Source Sans 3 on comparable unfamiliar material for 15–20 minutes each. Match their apparent size, keep the other settings stable, and alternate which you try first. Notice lost lines, rereading, comprehension, and willingness to continue—not just how the first screen looks. Use your actual lists, links, italics, tables, and code. Repeating the same passage favors whichever font you test second through familiarity.

## Google Fonts: local files versus linking

The six bundled families are local WOFF2 assets with their open-font licenses, totaling about 1.5 MB on disk. The build embeds the font data in its local stylesheet, so the entire set travels with the editor. Reading with these defaults makes no Google Fonts requests and works offline.

For another family, expand **Import Google Font**, enter its name, specimen link, or a single-family Google Fonts CSS2 URL, choose a slot, and click **Link font**. A name import requests regular, bold, and italic styles when available, with fallbacks for families lacking those styles. For continuous variable weights, paste the CSS2 URL generated by Google Fonts with the desired axes. For example:

```text
https://fonts.googleapis.com/css2?family=Literata:ital,wght@0,200..900;1,200..900&display=swap
line break
code three
this is just a test

```

The imported font is saved with the theme when that slot uses it. Linking is easy and lets Google select browser-appropriate files, but it requires a connection on first load and sends a font request to Google. A cache may help later; offline availability is not guaranteed. Downloading and bundling gives reproducible, offline behavior and avoids those external requests, at the cost of managing files, styles, subsets, updates, and licenses. This version bundles the curated choices and links additional imports; it does not yet download arbitrary imports into the profile. [Google Fonts CSS2 API](https://developers.google.com/fonts/docs/css2), [Google Fonts privacy explanation](https://fonts.googleblog.com/2022/11/your-privacy-and-google-fonts.html)

For maintenance, `bun scripts/bundle-fonts.ts` refreshes the curated assets and licenses from Google. It requires network access. The runtime build uses the checked-in files.
<!-- wave-annotations:v1
{"type":"ledger","documentId":"3be27c27-87e5-49d1-8afa-872a9a100297","baseBodyRevision":"sha256:98913fc443a91fe29069b71125e37e60eaa8c28cb6f8b693d9f3bde634af3df8","createdAt":"2026-09-06T18:33:52.779Z"}
{"type":"comment","id":"a-9cca5ed0-0943-431c-8879-d290e564c34a","seq":1,"actor":"hart","createdAt":"2026-09-06T18:33:52.779Z","anchor":{"exact":"Tether","prefix":"Reading themes and the theme maker\nTether Light and ","suffix":" Dark share Hanken Grotesk headings, Source Serif 4 paragraphs, ","projectionStart":52,"projectionEnd":58,"bodyRevision":"sha256:98913fc443a91fe29069b71125e37e60eaa8c28cb6f8b693d9f3bde634af3df8"},"body":"comment"}
{"type":"reply","id":"a-14f4e5b8-9f44-4794-b6ea-9b269d776c0f","seq":2,"actor":"hart","createdAt":"2026-09-06T18:34:01.920Z","threadId":"a-9cca5ed0-0943-431c-8879-d290e564c34a","body":"reply"}
{"type":"comment","id":"a-ca504ff4-c6bf-4771-a474-461a992fad01","seq":3,"actor":"hart","createdAt":"2026-09-06T18:35:17.882Z","anchor":{"exact":"click","prefix":"t and dark variants.\nUsing the theme maker\nChoose a theme, then ","suffix":" the sliders button beside the theme picker. The selected theme ","projectionStart":532,"projectionEnd":537,"bodyRevision":"sha256:98913fc443a91fe29069b71125e37e60eaa8c28cb6f8b693d9f3bde634af3df8"},"body":"second comment"}
{"type":"comment","id":"a-87707758-e10a-4335-b7fc-2ae31f9a3334","seq":4,"actor":"hart","createdAt":"2026-09-06T18:35:36.652Z","anchor":{"exact":"Headings","prefix":"er. The selected theme supplies the starting palette and fonts. ","suffix":", Paragraphs, and Code each have a font selector and separate si","projectionStart":642,"projectionEnd":650,"bodyRevision":"sha256:98913fc443a91fe29069b71125e37e60eaa8c28cb6f8b693d9f3bde634af3df8"},"body":"third comment"}
{"type":"reply","id":"a-79f4175e-ab8d-4b1b-aef7-732bc5e3e55e","seq":5,"actor":"assistant","createdAt":"2026-09-06T18:37:26.740Z","threadId":"a-9cca5ed0-0943-431c-8879-d290e564c34a","body":"Here is a reply from **assistant** after your two messages.\nThis second line should remain on its own line.\n"}
{"type":"reply","id":"a-de4dafc8-a444-4a3c-9c41-82cb98e94458","seq":6,"actor":"assistant","createdAt":"2026-09-06T18:37:30.611Z","threadId":"a-ca504ff4-c6bf-4771-a474-461a992fad01","body":"A second author joins this thread.\n\n- Compare the author and timestamp.\n- Check the spacing between messages.\n"}
{"type":"reply","id":"a-ee27b136-0e9d-4ace-98dc-b6c92ab81ada","seq":7,"actor":"assistant","createdAt":"2026-09-06T18:37:35.133Z","threadId":"a-87707758-e10a-4335-b7fc-2ae31f9a3334","body":"The heading face gives the conversation its structure; the paragraph face carries the reply.\n\nHere are *italics* and `inline code` for comparison.\n"}
{"type":"ack","id":"a-0c9ace89-f321-487a-bdf6-7ad3ad482465","seq":8,"actor":"assistant","throughSeq":4,"bodyRevision":"sha256:98913fc443a91fe29069b71125e37e60eaa8c28cb6f8b693d9f3bde634af3df8","createdAt":"2026-09-06T18:37:40.771Z"}
{"type":"resolve","id":"a-c4dbeed5-a3d2-4332-aeec-2e92af88f01c","seq":9,"actor":"hart","createdAt":"2026-09-06T18:47:11.541Z","threadId":"a-ca504ff4-c6bf-4771-a474-461a992fad01"}
{"type":"resolve","id":"a-826b8d64-7edf-4a84-9839-b21af418daae","seq":10,"actor":"hart","createdAt":"2026-09-06T18:47:14.917Z","threadId":"a-9cca5ed0-0943-431c-8879-d290e564c34a"}
-->