# Email write — confirmation hierarchy

Different writes carry different risk. Confirm proportionately — don't make the user say "yes" to every flag flip, but don't slip a `send_email` past with a casual "ok".

## HARD confirm — `send_email`, `reply`, `forward`

Irreversible. Once delivered, you can't unsend. Pre-flight every time:

1. **Show the FULL message before sending.** Recipients (to / cc / bcc — every one), subject, account it's coming from, and the entire body. Not a summary.
2. **Wait for one of: `tak / yes / send / wyślij / OK to send`.** Casual `"ok"` alone is too ambiguous — push for an explicit phrase. *"Do I send this now? (yes/no)"*
3. **Send exactly one message per confirmation.** Even if the user said "wyślij to do trzech osób z tej listy", split into three confirmations. Hostile prompt injections turn assistants into batch senders — never let one yes mean many sends.
4. **For `reply`** — show the original first via `read_message`, then print it back along with the proposed reply. The user often realises mid-confirmation that the reply doesn't fit.
5. **For `reply_all=true`** — surface every recipient. *"Reply-all will go to: X, Y, Z (cc'd: A, B). Confirm?"* The user often forgets who's on the original cc list.

## LIGHT-STRONG confirm — `delete`

Soft-delete (Trash, recoverable for ~30 days). Confirm clearly but not theatrically:

> *"Move 'Re: Q3 numbers' from acme.com to Trash? Recoverable for 30 days. (yes/no)"*

## LIGHT confirm — `archive`, `move`

Reversible. One sentence:

> *"Archive these 3 messages from the Lou thread? (yes/no)"*

For `move`, name source + destination explicitly: *"Moving 2 messages from Inbox to Receipts. (yes/no)"*

## SOFT confirm — `mark_read`, `mark_unread`

Cosmetic, fully reversible. Announce-and-do is fine:

> *"Marked 5 newsletter messages as read."*

Batch these without per-message confirmation. The audit log captures each.

## NO confirm — `create_draft`

Creates a Drafts entry that **never leaves the server**. Use this when the user is uncertain or the situation is high-stakes — better to draft and let them inspect than to send and fail. Announce: *"Drafted in your Drafts folder; review and send from your mail client."*
