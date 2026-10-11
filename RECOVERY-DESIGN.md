# Group recovery

**Status: implemented.** Group wallet backups carry the group, a wallet restored from one can
rejoin its group, and a group heals itself when the relays have dropped a returning phone's copy
of the key.

## The problem

After a lost phone a group wallet has two things to recover, and only one of them used to be
backed up.

- **The wallet.** Recovery phrases plus the Sparrow file or printed PDF. Always covered; the group
  plays no part in spending.
- **The group.** The channel the members coordinate on: chat, PSBTs, and letting a returning
  member back in. Not covered: no backup carried the invite secret, and `GroupScreen` stopped
  showing the invite once the wallet was built, so a member who lost their phone had to dig out
  whatever message the invite was originally sent in.

Most of what restoring the group needs already exists, because of how REKEY-DESIGN.md pinned
identities:

- A member's group identity is `nostrSecretForGroup(seed, S0)` — deterministic. The same seed and
  the same invite give the same pubkey on a new phone, so the coordinator still recognises it.
- Every rotation seals the new epoch secret to each roster member, **the coordinator included**,
  and tags it with the lobby channel. A restored phone listening on the lobby picks its envelope up
  again and adopts the current epoch without anyone doing anything — as long as the relays still
  hold it.

What was missing: getting `S0` and the choice of identity key into the backup, letting a restored
coordinator come back *as coordinator*, and not depending on relays keeping envelopes forever —
and, underneath all of it, any way to put a phone key's recovery phrase back into the app.

## Scope

**In scope:** any member, coordinator included, who loses their phone but keeps their recovery
phrase and a backup, rejoining **the same group** while everyone else carries on.

**Out of scope: a coordinator gone for good** — seed lost, or the person has left. Only the pinned
coordinator can hand out keys, and this does not add a way round that. Co-coordinators or
member-initiated rotation would weaken the pin, and would let two people rotate at once and split
the group. The group is a convenience layer, so in that situation the remaining members:

- keep coordinating on the current epoch, which they all still hold. Chat and PSBTs work without
  the coordinator; what is lost is rotation and re-admitting members;
- create a new wallet and sweep the funds into it, signing with `m` of the old keys.

## Design

### 0. Restoring a phone key

Every group identity is derived from a phone key, so rejoining starts with getting that key back.
The app could create phone keys but had no way to re-enter one's recovery phrase. Create a key now
offers **Restore from a recovery phrase**: type the words, and the same key comes back — any
BIP39 length. `addKey` links it to the wallets that include it, as for any new key. A phrase whose
key is already on the phone is refused, since two records of one seed would put a duplicate
cosigner in a wallet.

### 1. The invite goes into the wallet backup

For a group wallet both backup formats gain a group section.

**Backup file** — two comment lines after the existing `# Descriptor:` line:

```
# The group invite below opens only the group's handshake. Rejoining also needs the
# recovery phrase of the identity key named after it.
# Group invite: multisig:join?v=1&s=…&n=…&m=2&t=3&c=…&k=1&r=…
# Group identity: 0b04e44b
```

- The invite is `encodeInvite` over exactly what the coordinator's invite carries: `S0`, the
  group's relays, name, policy, network, coordinator pubkey and `k=1`.
- The identity line is the master fingerprint of the phone key whose seed derives this device's
  group identity (`Group.identityKeyId`), so a restore can choose the same key.
- `parseWalletConfigFile` already skips `#` lines, as do Sparrow, Coldcard and Specter, so the file
  stays a valid wallet file everywhere.

**PDF** — a "Rejoin the group" section after the cosigners: the invite as a QR code, and a line
naming the identity key. The wallet QR stays a plain descriptor so Sparrow can still scan it.

**Epoch secrets are never written to a backup.** After rotation `S0` opens only the handshake —
joins, display names, per-group npubs and rekey notices — which is exactly what REKEY-DESIGN.md
demoted it to. Adding `S1…` would make every backup a key to all later chat and PSBTs, undoing
rotation, and they are recoverable anyway (below).

So a leaked backup exposes only a little more than it already does. It already carried every
xpub, which reveals the wallet's whole history. Now it also lets the holder read the lobby and
knock on it, where the coordinator sees a latecomer and has to let them in deliberately — the same
as a leaked invite.

**Legacy groups get no invite line.** A group from before rotation (`rekey` unset) never leaves
epoch 0, so its invite is still the key to everything it ever sent. The backup screen says the
group is not included, and why.

`S0` never changes, so a backup exported once stays valid for the life of the group. A group
wallet whose last backup predates this has `exportedAt` but not the new
`MultisigWallet.backupIncludesGroup`; `describeBackupState` reports it as "Backup doesn't include
the group", so the existing backup nag covers it.

All four places that export a backup go through `exportBackup` (`exportActions.ts`), which reads
`S0` from the keystore and builds the section with `groupBackupFor` (`groupBackup.ts`).
`recordExport` records `backupIncludesGroup` only when it says something, so a private wallet's
record is unchanged.

**Check a backup** learns the invite QR. Scanned on its own it is reported as this wallet's group
code (its secret matches the group's `S0`) or another group's, never as a wallet backup, so it does
not set `backupVerifiedAt`. A backup file is checked for the wallet as now and, when present, the
invite too.

### 2. Restoring is rejoining, from the wallet

The wallet is the anchor: it is restored first, and the group is rejoined from it.

- **Import existing wallet** ends by offering "Rejoin the group" when the text carried a
  `# Group invite:` line whose policy matches the wallet. `groupFromBackupText(text)` pulls out the
  invite and the identity fingerprint.
- **Manage → Join this wallet's group** is offered on any wallet no group points at. This is the
  PDF path: scan the group QR there.

Both open `JoinGroupScreen` in a new `restore` mode carrying the `walletId`:

- The invite's `m`, `n` and `network` must equal the wallet's, or it refuses.
- The identity key is pre-selected by fingerprint. If that key is not on the phone, it says so —
  restore that recovery phrase first. Continuing with another key is allowed, but the coordinator
  will see a stranger and has to let them in.
- The group record is created with `walletId` already set and `contributedKeyIds` from the
  wallet's linked cosigners, and the wallet's `kind` becomes `'group'`. Nothing waits for a
  `wallet` message, which the relays may since have dropped.

**Coordinator detection.** If `getPublicKey(nostrSecretForGroup(seed, S0))` equals the invite's
`c=` (`isCoordinatorSeed` in `identity.ts`), the record is created with `coordinator: true`. Only
the coordinator's seed produces that pubkey, so this makes no new trust decision and leaves the pin
exactly where it was. It applies to an ordinary join as well: before this, a coordinator who
scanned their own invite on a new phone silently became a member. Joining also refuses an invite whose secret a group on this phone already holds,
rather than run two records of one group side by side.

From there the session does what it already does. The restored phone is at epoch 0, listens on
the lobby, and opens the envelope sealed to it at the last rotation — the coordinator's own copy
included, since `rotate` seals to itself. `onRekey` saves the epoch, and the roster from the
envelope's `members`.

### 3. When the relays have forgotten

Public relays promise nothing about keeping events. Two cases have to work without the envelope.

#### A member's envelope is gone

The member sits at epoch 0 and its `join` goes to the lobby, so the coordinator should reseal to
it. Today that comes from `GroupScreen`'s `behind` list, which has two problems:

- it runs only while the coordinator has that screen open;
- it reseals to every roster member not yet heard on the current epoch, including — straight after
  a rotation — members who simply have not opened the app yet. That is the extra kind-9798 event
  per member that follows every rotation on the relays.

Instead, reseal **on a knock**: a `join` that opened with `S0`, from a pubkey on the roster,
created after the current epoch began.

- Record when that was, as `Group.currentEpochAt`: the envelope's `created_at` for a member, the
  rotation time for the coordinator. Groups that rotated before this existed get it backfilled with
  the time a session first starts; a knock older than that is missed, but the knocking phone asks
  again the next time its group screen opens.
- Move the reseal into `useGroup`, so the `GroupSyncer` sessions behind the Home screen do it
  whenever the coordinator's app is open.
- Answer each knock once. `Group.resealed` remembers the newest knock answered per pubkey, so a
  knock still on the relays is not answered again on every launch, while a second restore later
  knocks anew and is answered. Several sessions of one group run at once (the Home list, the group
  screen, its chat), so a module-level set in `useGroup` stops them answering the same knock before
  the record's write lands.
- And at most once per `RESEAL_GRACE_MS` per member, by the coordinator's own clock
  (`Group.resealedAt`). A knock's time is the knocker's to choose, so a re-dated knock would
  otherwise be a fresh one, and every answer is an envelope published under the coordinator's
  identity and retried until a relay keeps it. `useGroup` re-runs when a grace ends, so a knock
  that arrived inside it is answered then.

The rules are pure functions in `src/lib/nostr/recovery.ts` — `knocksToReseal`, `coordinatorKnock`,
`epochFloor`, `heardFromMembers` — tested without a relay; `useGroup` acts on them.

#### The coordinator's own envelope is gone

This is the case that needs new protocol. A restored coordinator at epoch 0 cannot read the group,
and cannot simply rotate: `rotate()` numbers from its own epoch, so it would issue epoch 1, and
members on epoch `N ≥ 1` ignore anything not higher. That replay guard stays. It also no longer
knows the roster.

**Members answer a lost coordinator.** A member at epoch `N ≥ 1` that sees a `join` from the pinned
coordinator, opened with `S0` and created after its `currentEpochAt`, knows the coordinator has
lost the key: a coordinator holding `N` would have announced on `N`. It answers once with a `join`
of its own on the lobby, carrying `epoch: N`, and remembers it in `Group.answeredCoordinatorAt`.

- This needs `GroupSession.announce(join)`, which publishes on the lobby whatever the current
  epoch. It accepts only `join`, so nothing else can ever be sent under `S0`.
- The timestamp check matters. The coordinator's original pre-rotation join is always on the
  lobby, and answering it would post on every session start.

**The coordinator re-secures.** A coordinator's group screen at epoch 0 with a wallet shows
"Re-secure the group", listing who has answered. Closing it calls `rotate(roster, above)`, where
`above` is the highest epoch seen — from members' answers, and from the coordinator's own
`rekey-notice`s on the lobby (only notices authored by the pinned coordinator count). `rotate`
issues `max(this.epoch, above) + 1`, which every member accepts. The button stays disabled until at
least one member has answered, since without that the new epoch might not be above theirs.

Reported epochs are unauthenticated — anyone holding the invite can answer on the lobby — so
`epochFloor(messages, group, roster)` believes only the pubkeys the coordinator is about to seal in:
the roster it is handing the key to, whose count costs nothing more to trust. `heardFromMembers` is
gated the same way, so a stranger's answer cannot enable the button. A report is also disbelieved
further than `MAX_EPOCH_JUMP` (a thousand) above the epoch the phone last knew, which no real group
reaches, and anything at or above `MAX_EPOCH` (a million) is ignored everywhere an epoch is
adopted: `decodeMessage` (a join's report, a rekey notice), `decodeRekey` and `handleRekey` (a
sealed envelope), and `rotate`, which refuses both such a floor and such a result. Otherwise a
hostile invite-holder could push the numbering towards where integers stop being exact and
"higher than yours" stops holding — and once there, the group could never be re-secured again.

This roster is a fresh trust decision. The coordinator lost the list of pubkeys it sealed to, and
anyone holding the invite — or now a backup — can answer. It is the same decision as first closing
the roster, with the same advice: check with people before re-securing. Carrying the roster in the
coordinator's backup would make it automatic, but that list goes stale as latecomers are admitted,
and this case needs a lost phone *and* pruned relays together.

A relay the group controls keeps the first path working and makes this one rarer. The invite
already carries whatever relays the coordinator has configured.

### 4. Keep the invite on the group screen

The invite stays on the group screen after the wallet is built, as "Group invite", so a member with
an older backup can get the code from anyone still in the group. Used that way it is still a knock
the coordinator answers.

A restored member waiting for its copy of the key sees "Rejoining the group"; the wallet works in
the meantime, and only chat and sharing transactions wait.

### 5. Writes to group records

Background sessions now write to group records — an adopted epoch, its start, a knock answered —
while screens write too. `saveGroup` used to rebuild the list from the `groups` its closure
captured, and screens saved `{ ...group, change }` from the copy they rendered, so either could
quietly undo the other. The store now mirrors groups in a ref, like wallets, and has
`updateGroup(id, patch | (group) => patch)`, which resolves against the record as it is when the
write happens. Every screen that changed one field of a group record uses it.

## What this fixes and what it does not

**Fixed.** Anyone who keeps their recovery phrase and a backup can rebuild their place in the
group: the same identity, the current key, the roster and, for the coordinator, the coordinator
role. It works from the relays alone while they hold the envelopes, and from the rest of the group
when they do not.

**Not fixed — a coordinator gone for good.** Out of scope; see above.

**Not fixed — history under an epoch you could not recover.** A coordinator that re-secures starts
on `N+1` and cannot read epoch `N`, so chat and PSBTs in flight then are lost to it. Drafts live per
wallet on each phone (`PendingTx`), so other members can share them again. A restored member who
finds two envelopes adopts the higher one; the replay guard ignores the lower, and history under it
stays unreadable.

**Not fixed — losing the identity key.** Without the recovery phrase of the key that derived your
group identity you come back as a stranger, and have to be let in.

## Tests

In `tests/wallets.test.ts`, `group backups`:

- a group wallet's backup file carries the invite and identity lines, and still parses as the same
  wallet through `parseWalletConfigFile` and `parseWalletImportText`;
- a private wallet and a legacy group get no group lines;
- `groupFromBackupText` reads them back and reads a bare invite, and finds nothing in a plain
  descriptor or a damaged invite;
- the PDF prints the group code separately from the wallet QR;
- `backupMissesGroup` and `restoreMismatch`.

In `tests/tutorial.test.ts`: `recordExport` records `backupIncludesGroup` only when it says
something, and `describeBackupState` asks for a new backup when the group is missing.

In `tests/backupVerify.test.ts`, `the group`: the invite QR on its own is recognised as this
group's code or another's, never as the wallet backup; a backup file's group is reported as
matching, differing, missing or rejoinable.

In `tests/nostr.test.ts` — the fake relay gains an opt-in `retain` mode that replays stored events
to each subscription and can `prune` them, and the recovery tests move `Date.now` forward, since
knocks are told apart from old joins by the second they were sent:

- `who to answer`: the pure rules — a roster knock after the epoch began is resealed once, a
  stranger's is not, nor an answer, nor anything when the start is unknown; a member is answered
  at most once per grace however its knocks are dated; a member answers its
  coordinator's knock once and never its pre-rotation join; the floor believes only sensible
  numbers, only from the roster, no further than `MAX_EPOCH_JUMP` away, and only the
  coordinator's notices; an epoch at `MAX_EPOCH` is neither adopted nor issued;
- `over a relay`: coordinator detection by seed; a restored coordinator and member recover the
  current epoch and roster from their own sealed copies; with a member's envelope pruned, its knock
  is resealed and a stranger's is not; with the coordinator's pruned, the member answers its knock
  and follows its re-secure from epoch 2 onto 3; `announce` goes only to the lobby and only as a
  `join`; `rotate(roster, above)` issues `above + 1` and refuses an absurd floor.

## Files

| File | Change |
|---|---|
| `src/lib/groupBackup.ts` | new — `groupBackupFor`, the file lines, `groupFromBackupText`, `backupMissesGroup`, `restoreMismatch` |
| `src/lib/walletExport.ts` | group lines in the backup file; "Rejoin the group" section in the PDF |
| `src/lib/exportActions.ts` | `loadGroupBackup`, `exportBackup` |
| `src/lib/backupVerify.ts` | recognise and check the group invite |
| `src/lib/tutorial.ts` | `recordExport` records the group; `describeBackupState` reports it missing |
| `src/lib/types.ts` | `Group.currentEpochAt`, `.resealed`, `.resealedAt`, `.answeredCoordinatorAt`; `MultisigWallet.backupIncludesGroup` |
| `src/lib/store.tsx` | `groupsRef`, `updateGroup` |
| `src/lib/nostr/protocol.ts` | `JoinMessage.epoch`, `MAX_EPOCH`, `isEpoch` |
| `src/lib/nostr/session.ts` | `announce`, `rotate(members, above)`, `MAX_EPOCH`, envelope time on `AdoptedEpoch` |
| `src/lib/nostr/recovery.ts` | new — who to reseal, when to answer, the floor to re-secure above |
| `src/lib/nostr/identity.ts` | `isCoordinatorSeed` |
| `src/lib/nostr/useGroup.ts` | reseal on a knock; answer a lost coordinator; `currentEpochAt`, backfilled |
| `src/navigation.ts`, `src/screens/ScanQRScreen.tsx` | `JoinGroup` restore params, kept across a scan |
| `src/screens/CreateKeyScreen.tsx` | restore a phone key from its recovery phrase |
| `src/screens/JoinGroupScreen.tsx` | `restore` mode; coordinator detection and duplicate guard on every join |
| `src/screens/GroupScreen.tsx` | "Re-secure the group", "Rejoining the group"; invite kept after the wallet; `behind` removed; `updateGroup` |
| `src/screens/ImportWalletScreen.tsx` | offer to rejoin after import |
| `src/screens/WalletMenuScreen.tsx` | "Join this wallet's group"; backup nag and state cover the group |
| `src/screens/WalletScreen.tsx`, `VerifyBackupScreen.tsx`, `tutorial/BackupStep.tsx` | export with the group; verify against it |
| `src/screens/GroupChatScreen.tsx` | `updateGroup` |
| `tests/wallets.test.ts`, `tests/tutorial.test.ts`, `tests/backupVerify.test.ts`, `tests/nostr.test.ts` | the cases above |
