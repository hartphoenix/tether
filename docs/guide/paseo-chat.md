# Chat annotations in Paseo

## Current review

Submitted annotations now appear as speaker-labelled quotes followed by feedback, alongside the turn’s ordinary prose and attachments. See the submitted-message behavior below; desktop appearance awaits review.

Available in the desktop adapter for Paseo 0.11.2. Use the updated Tether plugin and Tether service together; disable other chat annotation plugins and the delivery prototype first.

Select a chat passage and choose the Comment icon. Write feedback, or leave it empty, then choose Comment, click away, or press Escape to save. Cancel discards current edits; an already saved annotation remains unchanged. The Copy icon copies the passage without creating an annotation. Drag the card by its empty border or surface; its input remains selectable. The card stays still while the transcript scrolls.

Saved passages have numbered badges in creation order. Click a badge, its highlighted passage, or a row in the annotation pill’s list to edit it. Delete is available beside each annotation in the list. Missing or virtualized source passages remain accessible from the list.

The “N annotations” pill above the composer opens the compact numbered collection. Click a row to edit, use its trash button to remove it, or choose Clear all. Recovery controls appear here when a batch needs attention.

Send through Paseo’s ordinary composer. Annotations join that chat’s message in creation order, alongside its prose and attachments. To send only annotations, press Enter in the empty composer. Native queue, steer and interrupt choices continue to apply. Each chat keeps its own saved work.

Submitted messages show each quote with its source speaker, followed by its feedback. Empty feedback leaves just the quote; code quotes use a monospace font. The display preserves creation order and works on older messages too. Select any displayed prose, quote or feedback to copy it or annotate it again; a new annotation belongs to the user turn containing that text.

Paseo’s attachment, copy and rewind controls remain in place. Whole-message copy and rewind retain the original structured text sent to the agent; passage selection uses the readable text. Unknown or malformed annotation blocks remain in their original form. Disabling Tether restores the native text display.

Delivered annotations disappear after confirmed acceptance. An annotation batch awaiting delivery is immutable; newer annotations remain saved separately. Finish or recover that batch before sending another annotation batch in the same chat.

If acceptance is uncertain, use **Check acceptance**. Tether checks the durable receipt and canonical timeline without resending. Matching text or a cleared composer alone cannot confirm delivery. If no proof is available, the batch stays saved.

After restarting, **Restore queued batch** returns never-dispatched work to Paseo’s native queue. If the agent is already idle, use the native queue’s send arrow. Use the native queue’s edit control to return a prepared batch to editing; clear any newer composer text first. Native file/image attachments may be unavailable after restart, but saved quotes and feedback remain.

Unsent annotations have no age-based expiry. Archiving preserves them; explicit annotation deletion or an observed successful permanent chat deletion removes them. Saved annotations use the Tether profile selected in Paseo’s plugin settings. After changing that profile or command, reload Paseo before editing annotations.

The adapter uses private desktop DOM, composer and receipt structures. This build is pinned to Paseo 0.11.2; a different release requires validation. Keep the plugin active while annotation-bearing native queue rows remain.
