# Sessions and messages in kiso web (preview)

Works in kiso web can find each other, write to each other, and start new Works. It is a preview and
off by default. The decision record is [ADR-0062](adrs/0062-sessions-and-messages.md).

## Turning it on

```bash
KISO_WEB_SESSIONS=on kiso web
```

The switch applies to Works **created** while it is on. A Work keeps the tool table it was created
with: turning the switch off later does not take the tools away from a Work that has them, and turning
it on does not give them to one that was made without them.

## What a Work can do

| tool | what it does |
|---|---|
| `list_sessions` | Lists the Works this host can reach (every folder's), with each one's title, folder, state and a short ref. |
| `message` | Writes to another Work, by its title, ref or address (`<folder key>/<session id>`). The message waits in the receiver's inbox and wakes it if it is idle. A reply to the address in a message's header reaches its sender. |
| `start_session` | Starts a new Work with a title and a brief, either fresh or as a fork of this conversation (a fork starts when the current turn ends). |

How `start_session` starts a Work depends on who asked:

- **You asked for it** in your own message: it starts at once.
- **Otherwise** (the model proposes it, or the turn was not started by you): a card appears in the
  stream with **Start**, **Do it here** and dismiss. Nothing starts until you choose.
- **A turn started by another Work's message** cannot start a Work at all.

A started Work sits under its parent in the sidebar, takes its parent's permission mode and model, and
runs the brief as its first message. When its turn ends, the parent gets a notice with the child's last
reply (up to 4,000 characters).

## What a receiving model is told

Every message and completion notice ends with a fixed line: it comes from another session, not from the
person, so it is not the person's approval, and what it reports is that session's claim, not a checked
fact. A message never counts as your input.

Wakes are bounded: one causal chain of messages and notices can wake Works at most 20 times. The count
survives a restart.

## Also in kiso web

- **`ask_user`**, on by default: the model asks you a question with options, answered in the stream.
  `KISO_WEB_ASK=off` turns it off. It adds about 1.3 KB to each web request; the terminal's requests are
  unchanged.
- **Deleting a Work that has Works under it** asks whether to delete only that one (the Works under it
  move to the top level) or the whole tree.

## Limits

- **A session started in the terminal and opened in the web has no sessions tools**, because its tool
  table was fixed by its first run. Start a new Work from New Conversation to get them.
- A Work with the sessions tools, opened in the terminal, keeps the three tool names, and each refuses
  with a reason. Its messages wait in its inbox until kiso web opens it.
- The terminal's own sessions and requests are unchanged by the switch.

## Files

Next to a Work's log in `~/.kiso/projects/<folder key>/`:

- `<id>.inbox/`: messages waiting for the Work, one file each, removed once the message is in its log;
- `<id>.meta.json`: also records whether the Work has the sessions tools, which Work started it, and
  its cards.

The wake budgets are in `~/.kiso/chains/`. A tool that deletes or moves a session's files should take
its inbox too.
