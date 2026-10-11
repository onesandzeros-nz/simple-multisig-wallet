# Group key rotation

**Status: implemented.** Groups created from this build onwards rotate off the
invite key once the coordinator closes the roster. Groups created before it stay
on epoch 0 for good and behave exactly as they did.

## The problem

A single 32-byte secret carried in the invite link used to be the root of everything:

```
channelId(S)         → the relay tag the group publishes under   (crypto.ts)
encryptionKey(S)     → the XChaCha20-Poly1305 key for every payload
groupAccountIndex(S) → each member's per-group Nostr identity     (identity.ts)
```

That secret is deliberately sent through a third-party channel — WhatsApp, Signal,
email, a photographed QR. Those channels keep copies. Relays keep events forever. So
an invite that leaked in 2029 still decrypted everything the group did in 2026,
including every cosigner's account xpub, which exposes the wallet's whole address
history in both directions.

The invite is now demoted from "the key to everything" to "a key to the handshake".

## The trap this avoids

The obvious implementation — coordinator broadcasts a new secret as a message on the
existing channel — is worthless. That message sits on retaining relays encrypted under
the old key, so anyone who later obtains the invite fetches the channel history,
decrypts the rekey message, and holds the new key too.

**A new epoch secret never travels over a channel the old secret can read.** It is
sealed pairwise to each member's public key instead.

## Design

### Epochs

`S0` is the invite secret; `S1, S2, …` are epoch secrets.

| Derivation | Bound to | Rotates? |
|---|---|---|
| `channelId` | current epoch secret | yes |
| `encryptionKey` | current epoch secret | yes |
| `groupAccountIndex` | **`S0`, permanently** | **no** |

Epoch 0 is the handshake and carries nothing but `join`. Epoch 1 onward carries all
substantive traffic — `key`, `selection`, `wallet`, `psbt`, `broadcast`.

**Identities do not rotate.** `Group.coordinatorPubkey` (`types.ts`) is the only thing
preventing a hostile invite-holder from pushing a malicious wallet, and it is pinned
from the invite. If member identities re-derived from the current epoch secret, every
pubkey would change at rotation and that pin would be void across the boundary.
`nostrSecretForGroup(mnemonic, rootSecretHex)` therefore stays on `S0` for the life of
the group, and `identity.ts` says so at the top — passing "the current secret" is the
natural refactor and it silently breaks the pin.

### Pairwise sealing

In `crypto.ts`, alongside the group-key functions:

```ts
conversationKey(ourSecretHex, theirPubkeyHex)  // ECDH → HKDF-SHA256 → 32 bytes
sealTo(ourSecretHex, theirPubkeyHex, plaintext)
openFrom(ourSecretHex, theirPubkeyHex, content)
```

Nostr pubkeys are x-only, so the sender's parity is unknown; as in NIP-44 we assume
even-Y. That is safe because negating a point leaves its x coordinate unchanged, so
both sides derive the same secret whichever parity each key actually had.

Dropping the parity byte is load-bearing, not tidying: keep the whole compressed point
and only pairs whose points share a parity still agree — a per-pair coin flip that
presents in production as "that member never got their key", with no error anywhere.
A single random pair catches it half the time, so the test pins a mixed-parity pair
deterministically and then sweeps 200 random ones with a floor on how many were
mixed-parity, so the sweep cannot quietly stop covering the case it exists for.

`sealTo`/`openFrom` share the `pad`/`unpad` and `base64(nonce ‖ sealed)` framing of
`encryptPayload`, so a sealed envelope is shaped exactly like a group payload and
inherits the same length-bucket padding.

No new dependencies: `@noble/hashes/hkdf` was already in the tree, and
`@bitcoinerlab/secp256k1` exports `pointMultiply`.

### Messages

```ts
REKEY_EVENT_KIND = 9798

/** Sealed pairwise. Deliberately NOT part of GroupMessage. */
interface RekeyMessage { type: 'rekey'; epoch: number; secret: string; members: string[] }

/** Broadcast under the OLD epoch key — carries no secret. */
interface RekeyNoticeMessage { type: 'rekey-notice'; epoch: number }
```

`RekeyMessage` is kept out of the `GroupMessage` union on purpose: the type system then
refuses to hand it to `GroupSession.send`, which would publish it under the very key it
is meant to replace.

The notice is what makes a missed rotation legible — a member who sees `rekey-notice`
for epoch 1 but cannot open any sealed envelope knows it was left behind, rather than
watching the group apparently fall silent.

### The lobby

Rekey events are tagged with **`channelId(S0)`**, the epoch-0 channel, and every
session subscribes to it forever whatever epoch it is on. Epoch 0 is the group's lobby.

This differs from the first sketch, which tagged each rekey with the *previous* epoch's
channel. The lobby is better for the case that actually matters: a phone restored from
a backup holds the invite and nothing else, so the only channel it can possibly listen
on is `channelId(S0)`. Tagging by previous epoch would have stranded it.

Tagging by recipient (`['p', pubkey]`) would have handed the relay the group's roster,
so members trial-decrypt every rekey event instead; with at most 20 members that costs
nothing. Publishing sealed envelopes on a channel the invite can find leaks only that a
rotation happened, which the notice says in the open anyway.

A session listens on the current epoch, the one before it (so a member who has not
migrated yet is still heard), and the lobby. Nothing is ever dropped from that filter —
the sketch proposed a 30-day migration window and it was not worth the complexity, since
old secrets have to be kept anyway to read retained history.

### Rotation flow

Coordinator, in `GroupScreen`:

1. Create group → `S0`, invite carrying `k=1`.
2. Members join on the lobby. Roster = pubkeys that sent `join`.
3. Coordinator confirms the roster explicitly — "Close the roster". Not automatic:
   roster size is not `n`, since one member may contribute several keys.
4. `GroupSession.rotate(roster)` generates `S1`, publishes one kind-9798 event per
   member sealed to them, then the notice on the old channel, then adopts.
5. `currentEpoch` and `roster` are written to the group record; the secret goes to the
   keystore.

Member — `handleRekey` refuses unless all four hold:

1. **The group rotates at all.** A group from before rotation stays on epoch 0 for
   good, so a rekey aimed at one is never legitimate. This is not belt and braces:
   those invites predate coordinator pinning too, so there is no author to check
   against and without this gate any invite-holder could move the group.
2. **A coordinator is pinned, and the event author is it.** Required, not merely
   checked when present — every invite advertising rotation carries `c=`, so a
   missing pin means something is wrong and adopting would trust an unauthenticated
   author.
3. **The envelope opens** with `openFrom(myIdentity, coordinatorPubkey, …)`.
4. **The epoch exceeds the current one** — otherwise a replayed epoch-1 envelope
   drags a group at epoch 3 back onto a key an old leak covers.

`rotate` refuses on a non-rotating group for the same reason: it would publish
envelopes nobody accepts and walk that session off the channel alone.

Sealed envelopes persist on relays, so rotation is asynchronous: a member whose phone
is off picks its envelope up whenever it next connects.

### Not stranding older builds

A member on a build that predates rotation cannot follow one, and would simply watch the
group go quiet. Two things prevent that being silent:

- The invite carries `k=1`, and `Group.rekey` is only set when it is present. A new app
  joining an old coordinator's group keeps the old behaviour rather than waiting forever
  to be secured.
- `join` carries `rekey: true` from a build that understands rotation. The coordinator
  lists everyone who has joined before closing the roster and flags those who did not
  signal it.

Rotation still proceeds — the group would otherwise deadlock, unable to rotate and
unable to share keys — and seals to every joined member regardless. An envelope for a
straggler waits on the relays, so updating the app is enough to catch up.

### Ordering

`GroupSession.send` refuses `key`, `selection`, `wallet`, `wallet-reply`, `psbt`,
`psbt-ack` and `broadcast` while `epoch === 0`, for groups where `rotation` is on
(`needsRotation` in `protocol.ts`). `GroupScreen` also holds back its one-shot key
publish and gives `contributeKey` a friendly refusal, so the guard is a backstop rather
than the user-facing error.

The same rule holds on the way in. `handleEvent` trial-decrypts down to epoch 0, and a
message of one of those types that opens under the epoch-0 key is dropped before
`onMessage` ever sees it. No member publishes them there, so one that arrives that way
was written by someone holding only the invite — which, being a bearer credential sent
over chat apps, could be anyone. Without this, the lobby would be a way to put
attacker-chosen keys, wallets and transaction drafts in front of a rotated group. Both
directions go through one predicate, `GroupSession.sealedOnly(type, epoch)`, so what is
refused on send is exactly what is disbelieved on receive. Legacy groups (`rotation`
off) are untouched: everything they have lives on epoch 0. `join` and `chat` are lobby
traffic by design and still arrive.

Rotation happens **before** the keys are exchanged, not after the wallet is built. The
`key` payload carries account xpubs and `wallet` carries the descriptor; those are the
most surveillance-damaging things the group ever publishes and they are inherently
setup-phase. Rotating afterwards would protect the PSBTs and chat while leaving the
xpubs under the leakable key — backwards, since an xpub already reveals the whole wallet.

### Storage

`group.${groupId}` in the keystore holds a JSON array of `{ epoch, secret }`. The parse
and merge logic lives in `src/lib/nostr/epochs.ts` rather than `store.tsx` so it can be
tested directly — the read path has to cope with what earlier builds wrote, and getting
that wrong would lock a member out of their own group.

A stored value matching `/^[0-9a-f]{64}$/` is read back as epoch 0, which is exactly
what the invite carried. The rewrite to JSON happens on the next save, so there is no
migration pass. `loadGroupSecret` still returns the epoch-0 secret — the identity root,
and what the invite QR shows — while `loadGroupEpochs` returns the list.
`addGroupEpoch` is idempotent, because a group can have two live sessions (a list
syncing in the background while its screen is open) and both will adopt the same epoch.

### Re-admission

Raising the epoch key above the invite appears to cost recoverability — the invite link
alone no longer restores a member. It does not, because identity derivation is
deterministic and pinned to `S0`:

> A reinstalled member derives **the same pubkey** from seed + `S0`. It is still on the
> coordinator's roster.

`ReceivedMessage` carries the epoch that opened it, so the coordinator can see which
roster members have not been heard on the current epoch and `reseal` to them. The
returning phone announces itself on the lobby, the coordinator recognises a pubkey it
already sealed to, and seals again — no new trust decision, no manual re-admit.

Safe precisely because it is restricted to *known roster* pubkeys: an attacker holding a
leaked invite can `join` with any pubkey they like, but cannot produce one already on
the roster without that member's seed.

Funds are never at risk either way — group coordination is a convenience layer and
QR/file transfer always works.

## What this fixes and what it does not

**Fixed.** An invite leaking after the roster closes yields only the epoch-0 transcript:
that a group formed, roughly when, member display names and npubs, and a rekey notice.
No xpubs, no descriptor, no transactions, no chat. There is a test that asserts exactly
this, by taking the epoch-0 secret and the complete relay transcript and checking that
the only message types it can open are `join` and `rekey-notice`.

**Not fixed — a leak during setup is still total.** Holding the invite remains the only
membership check, so an attacker present during epoch 0 joins, is sealed `S1` like
everyone else, and follows the group indefinitely. Rotation shrinks the exposure window
from the wallet's entire life to the setup window — hours or days instead of years — but
it is not a fix for the bearer-capability problem. Only out-of-band fingerprint
verification addresses that.

**Not fixed — retained history.** The epoch-0 transcript stays on the relays.
`requestDeletion` is best-effort and covers only our own events.

**Not fixed — this is one rotation, not a ratchet.** Compromise of the current epoch
secret, by keystore extraction on a rooted phone, still exposes everything from that
epoch onward.

## Delivery and retry

Relays are fire-and-forget by default, and a dropped socket or a quietly refusing relay loses
the event with nothing said. `src/lib/nostr/outbox.ts` keeps every published message until a
relay answers `OK` and retries it with backoff — in memory for the session, and from disk on
the next launch (`outboxStore.ts`). Retry must not undo anything above, so it keeps these rules:

- **Plaintext, re-encrypted under the current epoch.** A ciphertext from an earlier epoch is
  never replayed once the epoch has moved: after a re-secure it would be readable by whoever the
  old epoch was sealed to and the new one deliberately is not. An item is republished as the
  identical event only while the session is still on the epoch it was encrypted under.
- **Back through the guards, every time.** Each retry — identical republish included — runs
  the session's `send` rules again, so nothing in `AFTER_ROTATION` can go out under the invite
  key and nothing but a `join` ever goes on the lobby. An item a guard refuses (a `Refusal`) is
  dropped; any other failure — a socket caught mid-close — costs an attempt and is tried again.
- **Not believed as read back.** App storage can come back altered (a restored backup), and
  what is resumed is published as this user, so every item read from `outbox.*` passes the same
  validation as a message from a relay (`resumable`): a bounded, well-typed message, a hex id,
  an epoch in range, the lobby only for a `join`. Its signed copy is kept only if it verifies
  and is the event the item names; otherwise the item is signed afresh through the guards. At
  most `MAX_RESUMED_ITEMS` (100, the newest) are resumed, and a store over `MAX_RESUMED_CHARS`
  is not parsed at all.
- **Original timestamp, newest wins.** Re-signing keeps the original `created_at`, so a stale
  retry can never overtake a newer `selection`, `wallet`, `wallet-reply` or `join`; queued
  messages of those types are coalesced so only the newest is retried at all.
- **Wiped with everything else.** What waits in an outbox is plaintext — unsigned transactions,
  memos, chat — so the duress wipe empties every live outbox and removes every `outbox.*` key
  (`deleteAllOutboxes`), and leaving a group does the same for its own.
- **Envelopes are replay-safe and never persisted.** A rekey envelope is sealed to one roster
  pubkey and refused by anyone already at or above its epoch, so it is retried as it is — but
  only in memory. A lost envelope is recovered instead by resealing (below), from the keystore.
- **A relay's `OK` means stored, not delivered.** Only an encrypted receipt from a roster member
  on the current epoch counts as delivery: `wallet-reply` for a built wallet, `psbt-ack` for a
  shared transaction (keyed on the unsigned txid, so it survives re-sharing with more
  signatures), and a member's first message on the new epoch for a rotation.
- **Rotation retry goes only to the roster.** Once a grace period has passed, the coordinator
  reseals the current epoch to any roster member not yet heard on it (`silentOnEpoch`), and a
  member who saw a `rekey-notice` but never received its envelope knocks on the lobby
  (`missingEpoch`). Both at most once per launch per case. Admitting anyone outside the roster
  remains a human decision.
- **Relays are tried before they are trusted.** Creating a group probes each relay by storing
  a realistic-sized throwaway event and reading it back on a fresh connection (`probe.ts`).

## Tests

In `tests/outbox.test.ts`: relay `OK` clears the outbox; a silent relay is retried up to the
budget as the identical event; a refusal is recorded; a dropped socket is reopened, resubscribed
and its unsent messages resent; a waiting message is re-encrypted under the new epoch with its
original time while the notice stays pinned to the old channel; envelopes are retried unchanged
and never written to storage; a retry a guard refuses is dropped; latest-wins types coalesce;
unconfirmed messages persist and resume as the same event. `tests/rotationRetry.test.ts` covers
`silentOnEpoch` and `missingEpoch`; `tests/probe.test.ts` the relay check; `tests/receipts.test.ts`
transaction receipts.

In `tests/nostr.test.ts`:

- `epoch storage` — the bare-hex migration, sorting, junk tolerance, idempotent adds.
- `pairwise sealing` — ECDH agreement from either side, agreement across point
  parities (see above), rekey round trip, one epoch sealed to three members with none
  opening another's copy, malformed rekeys rejected.
- `group key rotation` —
  - moves the group onto a key the invite cannot read (the load-bearing one above),
  - identities stay pinned across a rotation,
  - a rotation from anyone but the pinned coordinator is ignored,
  - a replayed earlier epoch is ignored,
  - the lobby is still heard after rotating, and a returning member is sealed back in,
  - `send` refuses keys and transactions on the invite key,
  - keys and transactions that *arrive* on the invite key are ignored, after rotating and
    before, while a lobby `join` still comes through,
  - groups from before rotation keep working, and still receive keys on epoch 0,
  - a group from before rotation cannot be moved off epoch 0 by a hostile rekey, and
    refuses to rotate itself,
  - a rotation is refused outright when no coordinator is pinned to check it against,
  - a session without its epoch-0 secret refuses to start.

## Files

| File | Change |
|---|---|
| `src/lib/nostr/crypto.ts` | `conversationKey`, `sealTo`, `openFrom`; `seal`/`open` factored out of `encryptPayload`/`decryptPayload` |
| `src/lib/nostr/protocol.ts` | `RekeyMessage`, `RekeyNoticeMessage`, `REKEY_EVENT_KIND`, `needsRotation`, `validateMessage` and the `MAX_*` field bounds, invite `k=1` |
| `src/lib/nostr/session.ts` | epoch list, lobby subscription, trial decrypt, `rotate`, `reseal`, epoch-0 send and receive guard (`sealedOnly`), rekey author/rotation gates, `ReceivedMessage.epoch` |
| `src/lib/nostr/epochs.ts` | new — keystore format, migration, idempotent merge |
| `src/lib/nostr/identity.ts` | derivation pinned to the epoch-0 secret, and why |
| `src/lib/nostr/useGroup.ts` | loads the epoch list, persists an adopted epoch |
| `src/lib/store.tsx` | epoch-aware keystore: `loadGroupEpochs`, `addGroupEpoch` |
| `src/lib/types.ts` | `GroupEpoch`; `Group.rekey`, `.currentEpoch`, `.roster` |
| `src/screens/JoinGroupScreen.tsx` | new groups rotate; joined groups follow the invite's flag |
| `src/screens/GroupScreen.tsx` | join announcement, "Close the roster", waiting state, auto-reseal |
| `tests/nostr.test.ts` | the cases above |
| `src/lib/nostr/client.ts` | reconnect with backoff, resubscribe and flush on reopen, `OK` reported per event |
| `src/lib/nostr/outbox.ts`, `outboxStore.ts` | the outbox and its on-disk form; one per group, shared by its live sessions |
| `src/lib/nostr/recovery.ts` | `silentOnEpoch`, `missingEpoch` |
| `src/lib/nostr/receipts.ts`, `walletAnswers.ts` | who has a shared transaction; who added or declined the built wallet |
| `src/lib/nostr/probe.ts` | the relay check run when a group is created |
