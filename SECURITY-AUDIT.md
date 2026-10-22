# Security Audit — Simple Multisig

## Follow-up audit — 2026-10-11

Scope: everything new or changed since 2026-09-18 (all uncommitted work) —
group wallet recovery, key rotation/outbox, wallet answers, hardware-wallet
USB support (Ledger/Trezor/BitBox02), keystore import and signing, key
renaming, and the security-mode decoy app. Method: line-by-line review of
the new `nostr/` files, `hw/` tree, `decoy/` + `securityMode`/`securityPin`,
`wipeAll` in `store.tsx`, all modified screens, plus re-verification of the
established defences at their new call sites. 822 tests passing (1 skipped),
`tsc` clean. **No Critical findings.**

### New findings — fixed

- **H1 (High) — rotation was enforced only on send; the receive side accepted
  epoch-0 traffic on rotated groups.** `session.ts` `handleEvent` trial-
  decrypted inbound events down to epoch 0 and delivered them as ordinary
  group messages; no consumer (`WalletScreen` psbt/broadcast ingest,
  `GroupScreen` contributed-key pool, `useGroup` chat persistence) checked
  `m.epoch`. The send side already refused `key`/`selection`/`wallet`/
  `wallet-reply`/`psbt`/`psbt-ack`/`broadcast` at epoch 0, but any invite
  holder could publish those types under the never-retired epoch-0 key via the
  lobby and have them ingested — attacker-chosen pending drafts, contributed
  keys and wallets on a *rotated* group. **Fixed:** the send guard and the
  receive path now share one predicate, `GroupSession.sealedOnly(type, epoch)`
  (`rotation && epoch === 0 && needsRotation(type)`); `handleEvent` drops any
  message it matches before `onMessage` sees it. Safe by construction for
  legacy groups (`rotation` off, everything stays on epoch 0) and for
  pre-rotation traffic (a real member is refused by the send guard, so nothing
  of these types is ever legitimately on the lobby). `chat` and `join` on the
  lobby are unchanged: they are deliberately lobby traffic. Tests in
  `tests/nostr.test.ts` → "ignores keys and transactions that arrive on the
  invite key once rotated", "... before rotating too", and the legacy test now
  checks a peer's epoch-0 key still arrives.

- **M1 (Medium) — `epochFloor` believed epoch claims from any invite holder.**
  `recovery.ts` took `reportedEpoch` from any lobby `join` without a roster
  gate, so a hostile `epoch: 999999` passed the `< MAX_EPOCH` check and burned
  the group's epoch headroom, permanently degrading recovery. **Fixed:**
  `epochFloor(messages, group, roster)` and `heardFromMembers(messages, roster)`
  believe only the pubkeys the coordinator is about to seal in (the roster it
  passes to `rotate`), and nothing more than `MAX_EPOCH_JUMP` (1,000) above the
  epoch the phone last knew. `MAX_EPOCH` moved to `protocol.ts` and is now
  enforced at every adoption path: `isEpoch` in `decodeMessage` (a join's
  report, a rekey notice) and `decodeRekey`, `handleRekey` drops a sealed
  epoch at or above it, and `rotate` refuses to issue one. Tests:
  `tests/nostr.test.ts` → "believes an epoch only from someone about to be
  sealed in", "believes no jump a real group could make", "never adopts, and
  never issues, an epoch at the ceiling".
- **M2 (Medium) — relay-driven memory/CPU DoS: no inbound caps.** `client.ts`
  grew `seen`/`published` forever, `JSON.parse`d unbounded frames, had no
  per-connection throttle, and every delivered event was trial-decrypted
  against every epoch key. **Fixed:** a frame over `MAX_FRAME_CHARS`
  (1,200,000 — the largest honest `psbt` event is a little over 1,050,000, and
  the test proves it fits) is dropped unparsed; events are shape-checked and
  matched against the subscription filter *before* signature verification;
  each relay has an inbound budget (`DEFAULT_INBOUND_BUDGET`: 1,000 events a
  minute, duplicates not charged) beyond which events are dropped; `seen` and
  `published` are FIFO-capped (`MAX_SEEN` 5,000 / `MAX_PUBLISHED` 1,000);
  `RelayPool.stats` counts what was turned away. In `session.ts`, an event is
  decrypted only under the epoch its `t` tag names (`epochFor`), never trial-
  decrypted across every key. Tests in `tests/client.test.ts`. Still open: one
  pool per mounted screen (the list's syncer plus the open screen) rather than
  one per group — a constant factor, not growth.
- **M3 (Medium) — `decodeMessage` validated only 3 of 9 message types.**
  **Fixed:** `validateMessage` in `protocol.ts` checks every type field by
  field and returns a copy holding only known fields. Bounds: `MAX_NAME_CHARS`
  128 (inputs cap at 48), `MAX_CHAT_CHARS` 2,000, `MAX_MEMO_CHARS` 280, `MAX_KEY_EXPRESSION_CHARS`
  256, `MAX_DESCRIPTOR_CHARS` 8,192, `MAX_PSBT_CHARS` 750,000 (now the single
  source of `wallet.ts`'s `MAX_INCOMING_PSBT_CHARS`), `selection.xpubs` ≤
  `MAX_COSIGNERS`, `broadcast.txid` 64-hex, `join.epoch`/`rekey-notice.epoch`
  in `[1, MAX_EPOCH)`. The same function runs in `GroupSession`'s send guard,
  so a phone refuses with a reason what the others would drop in silence; the
  chat and display-name inputs cap at the same numbers. Tests:
  `tests/nostr.test.ts` → "bounds every field, and keeps only the fields it
  knows", "refuses to send what nobody would accept".
- **M4 (Medium) — the duress wipe did not erase the per-group outboxes.**
  Surviving `outbox.*` items held plaintext pending messages — unsigned PSBTs
  with memos, chat, xpubs. **Fixed:** `GroupOutbox.clear()` empties an outbox
  on disk and in memory; the live-outbox registry moved from `useGroup` to
  `outboxStore.ts` so `wipeAll` can reach it; `deleteAllOutboxes()` empties
  every live outbox (or it would write itself back), then removes every
  `outbox.*` key on disk, orphans included; `deleteOutbox(id)` (used by
  `removeGroup`) now also forgets the live one. A failure is collected and
  rethrown like the keystore deletes, not swallowed. Tests in
  `tests/outbox.test.ts` → "outbox: wiping".
- **L4 (Low) — the wipe left `hw.*` keystore memory**, including the BitBox02
  Noise pairing key (a genuine secret) and the Ledgers' wallet approvals. The
  keystore cannot list its own entries (expo-secure-store has no enumeration),
  so nothing could find them. **Fixed:** device memory now keeps a list of
  every name it writes (`sms.hwMemory.v1` in app storage — names only, never
  values) *before* writing the entry, and `clearDeviceMemory(wallets)` erases
  every listed name plus the names the drivers would have used for the
  wallets on the phone (the two fixed BitBox02 names; a Ledger approval per
  cosigner per wallet, `ledgerMemoryKeys`), so entries written by builds
  before the list are reached too, and a read of such an entry lists it. A
  name that cannot be deleted stays on the list for the next wipe and the
  failure is rethrown with the other keystore deletes. `hw/memoryStore.ts`
  holds the rules; `hw/memory.ts` binds them to the keystore. Tests in
  `tests/hwMemory.test.ts`; the Ledger and BitBox02 driver tests check that
  what they write is a name the wipe knows.
- **L1 (Low) — the persisted outbox was trusted on resume.** `outboxStore.load()`
  accepted any `kind:'message'` item, so a tampered app-storage backup could
  queue arbitrary messages published *as this user*, unbounded in count.
  **Fixed:** `resumable()` / `validateOutboxItem()` in `outbox.ts`: every item
  read back passes `validateMessage` (the same validation as a relay message),
  typed flags, a hex id, an epoch in range, the lobby only for a `join`; the
  signed copy is kept only if it verifies and is the event the item names,
  otherwise the item is signed afresh through the guards on its next publish;
  at most `MAX_RESUMED_ITEMS` (100, the newest) are resumed and a store over
  `MAX_RESUMED_CHARS` (4× the PSBT cap) is not parsed at all — an oversized or
  corrupt store is removed. `OutboxStorage.load()` now returns raw data and the
  `GroupOutbox` constructor is the one chokepoint for every storage. Tests in
  `tests/outbox.test.ts` → "outbox: resuming from disk".
- **L2 (Low) — knock→reseal amplification.** **Fixed:** `knocksToReseal(...,
  now)` answers a member at most once per `RESEAL_GRACE_MS` by the
  coordinator's own clock, recorded in the new `Group.resealedAt`; a re-dated
  or future-dated knock is no exception, and the grace is per member.
  `useGroup` re-runs when a grace ends so a knock inside it is answered then.
  Test: "answers a member at most once per grace, however many knocks they
  publish".
- **L3 (Low) — `outbox.tick()` conflated transient failures with guard
  refusals.** **Fixed:** `Refusal` (`protocol.ts`) is what validation and the
  session's guards throw; `tick()` drops an item only on a `Refusal`, and
  anything else (a socket caught mid-close) is a failed attempt, tried again.
  Test: "drops a retry only when a rule refuses it; any other failure costs an
  attempt".
- **L5 (Low) — "Yours" by fingerprint alone on the Manage screen.** **Fixed:**
  `WalletMenuScreen` `held` matches by `keyId` or exact xpub only, as
  GroupScreen's display check does.
- **L6 (Low) — unvalidated fingerprint in JSON key import.** **Fixed:**
  `isFingerprint()` (`slip132.ts`) is the one rule; `keyImport.ts` drops any
  `xfp` / `fingerprint` / `root_fingerprint` that is not 8 hex (a damaged
  Coldcard master xfp no longer falls back to the section's), and
  `ImportKeyScreen` persists only a real fingerprint, else derives one from
  the xpub node as it already did for keys without one (not the master
  fingerprint — the existing comment says so). Tests in `tests/keys.test.ts`
  → "keeps a fingerprint only when it is one, under any of its names",
  "judges a fingerprint by one rule".
- **L7 (Low) — `MAX_PENDING_DRAFTS` not enforced on manual import.**
  **Fixed:** `atDraftLimit()` / `assertDraftRoom()` in `wallet.ts`;
  `importPsbtText` refuses a *new* draft at the cap with a readable reason
  (merging into an existing draft adds none and is still allowed) and the
  relay loop uses the same predicate. Test in `tests/psbt.test.ts` → "caps
  unfinished drafts by one rule, whoever brings them".
- **L8 (Low) — the right PIN could be persisted as chat while the PIN record
  was unreadable.** **Fixed:** `classifyMessage` returns `withheld` for a
  PIN-shaped message when there is no record (not read yet, or unreadable):
  the decoy neither sends, stores nor counts it — the text stays in the box.
  The decoy inbox (`sms.inbox.v1`) is cleared whenever security mode is
  turned off, by the user or by the App-level effect that finds no record.
  Test in `tests/securityPin.test.ts` → "withholds a PIN-shaped message when
  there is no record to check it against".
- **M9 (Medium, carried from 2026-08) — secrets revealed with no auth and no
  screenshot protection.** **Fixed:** `expo-local-authentication` and
  `expo-screen-capture` installed at the SDK 57 versions. `confirmOwner()`
  (`src/lib/ownerCheck.ts`) asks for biometrics, or the device passcode when
  there are none, before "Show recovery phrase" (`KeyDetailScreen`) and
  before the group invite is shared or shown as a QR (`GroupScreen`); a phone
  with no passcode set has nothing to confirm with and is shown the secret as
  before; any error in the prompt is a no. Screen capture is blocked
  (FLAG_SECURE; iOS recording and screenshot prevention, blank app switcher)
  on `KeyDetailScreen`, `CreateKeyScreen` (a new or typed-in phrase),
  `VerifyBackupScreen` (a pasted backup carries the invite),
  `SecurityModeScreen` (PIN entry) and in `QrModal` while a `sensitive` code
  is up. The Face ID reason is set through the config plugin. Native modules,
  so not covered by the node tests.
- **M4 (Medium, carried from 2026-08) — iOS AsyncStorage rode along in iCloud
  backups.** iOS has no `allowBackup` switch; exclusion is a per-item file
  attribute. **Fixed (iOS, unverified here):** a local Expo module,
  `modules/ios-backup-exclusion`, registers an `ExpoAppDelegateSubscriber`
  that at every launch — before any JavaScript — creates if needed and marks
  `Application Support/<bundle id>` (where AsyncStorage keeps
  `RCTAsyncLocalStorage_V1`) and the legacy `Documents/RCTAsyncLocalStorage_V1`
  with `isExcludedFromBackup`; a marked directory excludes everything created
  inside it. Swift only, autolinked from `modules/`, no JS API. There is no
  iOS toolchain on this machine, so it compiles and runs unverified: on the
  first iOS build, check the attribute on the simulator's container
  (`xattr -p com.apple.MobileBackup` on the directory, or
  `ls -lO@`) after a launch. Android was already covered by `allowBackup=false`.
- **Info items — fixed.** A wipe that cannot erase everything writes the
  names down (`settings.wipeLeftovers`, which outlives the wipe), tries again
  on the next launch (`eraseLeftovers`) and the Home screen says so with an
  "Erase them now" button until the list is empty — the decoy still shows
  nothing. `saveAttempts` writes with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. The
  relay probe lands in the 32 KiB bucket (a transaction with a few dozen
  inputs), not the full 750k allowance, which would turn away relays that
  serve a group perfectly well — the trade-off is in `probe.ts`. User-added
  relays are capped at `MAX_RELAYS` (20, the same cap an invite has).
  `RECORD_AUDIO` and `SYSTEM_ALERT_WINDOW` are removed from the manifest via
  `android.blockedPermissions` (`expo config --type introspect` shows
  `tools:node="remove"`). 2026-10-16: Google Play's review of 0.1.1 flagged
  `READ_MEDIA_IMAGES`, which `expo-screen-capture` declares for its
  screenshot *listener* on Android 13; the app only uses its FLAG_SECURE side,
  so that permission and `READ_MEDIA_VIDEO` are now blocked the same way (the
  merged release manifest was checked with
  `./gradlew :app:processReleaseMainManifest`). The fingerprint-only `local`
  field is no longer set on a contributed key candidate.
### New findings — open

Nothing from this round remains open. The "one `RelayPool` per group rather
than per mounted screen" improvement noted under M2 is a nice-to-have, not a
finding.

### Verified sound (new code)

- **Decoy/lock design:** splash held until the lock decision (no frame of
  the wallet first); fail-closed on keystore read failure; relock after
  30 s background, fresh start always locked; PIN-shaped guesses only, wipe
  after 3 with the streak carrying across ordinary messages and persisted;
  the right PIN is never stored; salted SHA-256 record in the keystore
  (hash is hygiene — the wipe is the real defence, as documented); wipe
  ordering keystore-first with independent deletes; the wiped phone stays in
  the decoy so the wipe is not observable; the decoy inbox holds nothing
  secret by design.
- **Recovery/rotation:** every event schnorr-verified before delivery;
  rekey adoption requires rotation-flag + pinned coordinator + author match
  and refuses unpinned legacy groups outright; epochs monotonic; envelopes
  never persisted, retried byte-identical, never republished under an old
  epoch; roster gating is cryptographic (per-group NIP-06 identities derived
  from each member's seed, pinned to S0 so the coordinator pin survives
  rotation); unknown `currentEpochAt` disables rather than enables; reseals
  hand a roster member only a secret they were already sealed.
- **Receipts/wallet answers:** roster-filtered, coordinator-pinned,
  descriptor/txid-bound, names only from roster joins; informational-only.
- **Probe:** throwaway random identity/channel/secret tied to nothing;
  read-back matched by exact id and independently re-verified; deadline
  closes the pool on every path.
- **Hardware wallets** (notably strong): BitBox02 — manufacturer attestation
  with 111 roots + challenge signing, Noise_XX secure channel with strict
  nonce accounting, both-sides pairing verification, anti-klepto
  sign-to-commit nonce verification, per-input `ecc.verify` before any
  signature leaves, strict firmware window, budgets against hostile
  devices; Ledger — SIGHASH_ALL enforced, wallet registration verified by
  policy id *and* first-address agreement, interpreter round cap; Trezor —
  firmware minimums at the segwit-amount-check releases, everything shown
  to the device rebuilt from the wallet's own keys, change hidden only on
  exact script re-derivation, per-input `ecc.verify`. All three locate a
  cosigner by fingerprint but then require the device to return the exact
  cosigner xpub at the path — xpub proof, not fingerprint trust. Driver
  memory in SecureStore; USB needs the runtime permission dialog; PINs as
  keypad positions only; NFKD-normalized ≤50-byte passphrases.
- **Established defences held at every new call site:** xpub-proof linking
  (never fingerprint alone) in `buildWallet`/`acceptWallet`/`linkCosigners`
  and all hw drivers; self-inclusion check on accept; coordinator pinning
  for wallet/selection/answers/rekey; `parseIncomingPsbt` 750k/100/100 at
  every ingest (relay, manual, merge, NFC/file); `MAX_PENDING_DRAFTS` with
  the in-pass working-copy fix; fee clamps and the fee alarm; hw wallets
  verify amounts against fetched prevouts (hash-checked to the txid);
  `keyCheckCode` shown and voice-verified; plaintext-relay and
  unpinned-coordinator warnings; no deep links into the app (invites must go
  through the validating parsers); no `dangerouslySetInnerHTML`/`eval`;
  explorer URLs take only 64-hex txids; PDF export escaped; backups carry
  public data only, and only the epoch-0 invite ever enters one.

### Still open from previous rounds

H4 (Electrum TLS hostname verification — options below, (4) done), Android
app-wide `usesCleartextTraffic`, the unrevocable bearer invite, no forward
secrecy, unencrypted local metadata, default public chain backend. M4 and M9
are fixed (above).

**H4 — what would actually work for a released app.** The facts, from
`react-native-tcp-socket` 6.4.2 (6.4.3 changes nothing here) as used by
`src/lib/electrum/rnSocket.ts`: on iOS the default path sets
`kCFStreamSSLPeerName`, so the system verifies the hostname already, and
with a `ca` it compares the leaf certificate byte for byte (that *is*
pinning). On Android it uses `SSLSocketFactory.getDefault()` (or a custom
trust store when `ca` is given) on a bare `SSLSocket`: the chain is
validated, the hostname never is — no `setEndpointIdentificationAlgorithm`,
and `connect()` dials the resolved IP, so the socket does not even carry the
host name. So the gap is Android-only. Routes, in the order worth taking:

1. **Pin in JS with what the library already exposes.** After `connectTLS`
   resolves, `socket.getPeerCertificate()` returns the peer's `pubkey`
   (SPKI, base64) on both platforms (`fingerprint256` only on Android).
   Store the pubkey with the user's own server — shown on first connection
   for them to confirm against the server, or pasted from it — and destroy
   the socket on mismatch before the first request. Pure JS, no rebuild
   risk, and the right model for a self-hosted node, whose cert is usually
   self-signed anyway (`ca` would then also be set, which on iOS already
   pins). Does nothing for a public server the user has never seen; combine
   with (2).
2. **Patch the Android side with `patch-package`** (Expo CNG runs
   `postinstall`; EAS builds apply `patches/`): in `TcpSocketClient.connect`
   open a plain socket, connect, then wrap it with
   `ssf.createSocket(socket, address, port, true)` so the host name is
   attached, and before `startHandshake()` set
   `SSLParameters.setEndpointIdentificationAlgorithm("HTTPS")` plus SNI
   (`setServerNames`); the same two lines in `startTLS`. About ten lines,
   and it belongs upstream — open the PR and drop the patch when it lands.
3. **A local Expo module for a TLS line socket** — the project already ships
   one in Kotlin (`modules/usb-host`). Network.framework on iOS and
   `SSLSocket` with endpoint identification on Android, pinning as an
   option. The robust long-term answer, but real work on two platforms.
4. **Steer public-server users to the HTTPS Esplora backend**, which goes
   through `fetch` and is verified properly today; keep Electrum-over-TLS
   for self-hosted nodes, where (1) applies.

Recommended: (1) now, (2) alongside and upstreamed, (3) when the Electrum
path is next reworked. None of these needs a change to the Electrum protocol
code itself.

**(4) is done (2026-10-11).** `PUBLIC_SERVERS` is HTTPS-only — the two public
Electrum picks are gone and a setting still naming one falls back to the
default; the Electrum settings explain the limit and, when a TLS host does not
look private (`looksPrivateHost`: loopback, RFC 1918, CGNAT/Tailscale,
link-local, bare names, `.local`/`.lan`/`.home.arpa`/`.ts.net`/`.onion`),
warn and point at the HTTPS option. Tests in `tests/chain.test.ts`. The
Android hostname gap itself remains for self-hosted Electrum over TLS, where
(1)–(3) still apply.

### Suggested fix order

1. ~~H1 — the receive-side mirror of the send guard.~~ Done (`sealedOnly`).
2. ~~M4~~ Done (`deleteAllOutboxes`). ~~L4~~ Done (`clearDeviceMemory`).
3. ~~M1 — epoch bounds/clamps everywhere an epoch is adopted.~~ Done.
4. ~~M3 — per-type validation in `decodeMessage`.~~ Done (`validateMessage`).
5. ~~M2 — inbound caps in the relay client.~~ Done; one pool per group remains a nice-to-have.
6. ~~L1–L3, L5–L8, then the Info hygiene items.~~ Done, M4 and M9 with them. Left: H4 options (1)–(3) for self-hosted Electrum over TLS, and `usesCleartextTraffic` — native work that needs a rebuild to verify.

---

## Follow-up audit — 2026-09-18

Scope: full re-audit (key storage, PSBT/signing, Nostr coordination, NFC card
protocols, chain backends, QR/file/paste import paths, Expo config,
dependencies). Method: line-by-line review of `src/lib` and all
security-relevant screens; 401 tests passing, `tsc --noEmit` clean,
`npm run selftest` / `npm run smoke` clean.

### Previous findings

All Critical/High findings from 2026-08-13 were verified fixed in code with
test coverage (hostile-PSBT defences, coordinator pinning, xpub-bound check
codes, self-inclusion on accept, fee bounds, TAPSIGNER certificate chain, fee
clamps, response limits, invite bounds). Still open from that round:
**H4** (Electrum TLS hostname verification — needs a native socket change),
**M4** (iOS AsyncStorage in iCloud backup — needs a config plugin),
**M9** (biometric gate + FLAG_SECURE — needs new packages), and Android's
app-wide `usesCleartextTraffic: true` (iOS is local-networking-only now).

### New findings — all patched

- **F1 (Medium) — members could not verify the cosigner set before accepting a
  group wallet.** The accept screen showed only raw descriptor text, so a
  compromised coordinator could hand a member "your key + 2 attacker keys" at
  the agreed m-of-n and drain deposits. The "Wallet received" card now renders
  every cosigner with its `keyCheckCode`, flags any key that was never shared
  as a contribution on the channel, and tells the member to confirm every code
  with its owner out of band before adding the wallet.
- **F2 (Low) — fingerprint-only key linking.** `GroupScreen.buildWallet` and
  `linkCosigners` matched local keys by master fingerprint alone — attacker-
  chosen text in contributed keys and imported wallets, letting a substituted
  xpub borrow a real key's identity ("Yours", offered for signing; signatures
  would not finalize, but funds could be stranded). Both now link only on xpub
  proof: exact stored xpub, or the account xpub re-derived from the local seed
  (`localXpubFor` resolver in `store.tsx`). Tests updated in
  `tests/linking.test.ts`.
- **F3 (Low) — unbounded inbound PSBTs and draft spam.** Any invite holder
  could push oversized PSBTs (every input/output is re-derived at display time)
  and fill the pending list without confirmation. New `parseIncomingPsbt`
  bounds text length (750k chars), inputs and outputs (100 each) at every
  foreign ingest path (group relay, QR/NFC/file import, signature merge), and
  group-originated drafts are capped at 10 per wallet
  (`MAX_PENDING_DRAFTS`). Tests in `tests/psbt.test.ts` → "inbound PSBT bounds".
- **F4 (Low) — signed transaction hex was written to device logs on broadcast
  failure** (`esplora.ts`). Removed; the log keeps only the server's reply.
- **F5 (Low) — plaintext `ws://` relays in invites.** Kept deliberately for
  LAN relays (group payloads are end-to-end encrypted regardless), but the
  join screen now warns when an invite carries one, and also warns when an
  invite lacks a pinned coordinator (legacy format → falls back to
  any-author trust). Behaviour locked in `tests/nostr.test.ts`.
- **F6 (Low) — server-supplied txids interpolated into explorer URLs
  unvalidated.** `txExplorerUrl` now only appends a 64-hex txid and otherwise
  degrades to the explorer root. Test in `tests/chain.test.ts` → "explorer
  links".
- **Info — store startup** now catches corrupted AsyncStorage JSON and starts
  with defaults instead of an unhandled rejection on a blank screen.
- **Info — gap-limit scanning** (GAP_LIMIT 20, 200 addresses/branch) is now
  documented in README's known weaknesses.

### Verification pass — 2026-09-18 (same day)

Independent re-check of every fix above against the committed code: all
present, tests assert the stated property, 401 tests / `tsc` / selftest /
smoke clean. Two follow-ups applied:

- **F3 cap was not enforced within one message batch.** The relay ingest loop
  in `WalletScreen` counted drafts from the React snapshot taken before the
  pass, and `savePendingTx` in the store filtered the same stale state, so a
  backlog delivered in one render bypassed the per-iteration cap and each save
  overwrote the last (dropping legitimate drafts and merged signatures until
  the next message). The store now mirrors pending drafts in a ref that every
  mutator reads, and the ingest loop tracks the drafts it adds, merges and
  removes during a pass.
- **Dead unvalidated `txExplorerUrl` in `esplora.ts`** removed; the only
  helper left is the validated one in `chain.ts`. Its test now exercises the
  custom-server path. Added the missing `MAX_PSBT_OUTPUTS` test.

### Dependencies

`npm audit fix` applied: 24 → 16 advisories, clearing `@xmldom/xmldom`,
`brace-expansion`, `js-yaml`, `nanoid` and `query-string`/`decode-uri-component`.
The remainder are build-time only (metro/`image-size`, `@expo/*` prebuild
toolchain, `uuid` via `xcode`) and need a breaking Expo SDK bump — nothing in
the runtime crypto path (`bip32`, `bip39`, `bitcoinjs-lib`, `bip174`,
`@noble/*`, `@bitcoinerlab/secp256k1`, `bs58check`, `@ngraveio/bc-ur`,
`expo-secure-store`) has an open advisory.

### Remaining known gaps (unchanged posture)

H4 above (M4 and M9 fixed 2026-10-11); the invite remains an unrevocable bearer capability; no
forward secrecy; signatures auto-publish to group relays; relay metadata is
not hidden; local storage beyond the keystore is unencrypted; the default
public backend sees the wallet's addresses. All documented in the README's
security section.

---

## Original audit — 2026-08-13

Scope: full app (key storage, PSBT/signing, Nostr coordination,
network transport, untrusted-input parsing). Method: four parallel domain audits,
findings verified against source by hand.

## Remediation status (2026-08-13)

**Fixed in code** (all changes covered by the test suite — 255 passing):
- **C1/C2** — `summarisePsbt` now re-derives every output and input against the
  wallet's own keys; "change" is verified, not trusted from PSBT metadata. New
  `amountLeaving`/`allInputsOurs` fields; `PsbtScreen` warns on foreign inputs.
  Tests in `tests/psbt.test.ts` → "hostile PSBT defences".
- **C3** — coordinator pubkey is pinned in the `Group` record and the invite
  (`c=`); only that author's `wallet`/`selection` messages are trusted. Legacy
  coordinator groups self-heal from their session pubkey.
- **C4** — added `keyCheckCode` (a hash of the xpub) shown in the key list; the
  build instruction now tells the coordinator to verify *that* code, which
  actually commits to the key. `acceptWallet` links keys only on proven
  ownership (seed re-derivation or exact xpub), never fingerprint alone.
- **H1** — `acceptWallet` refuses a wallet that contains no key held on this phone.
- **H2** — `PsbtScreen` flags an abnormally high fee (>20% of spend, >10k sats).
- **H3** — dropped iOS `NSAllowsArbitraryLoads` (kept local networking); Electrum
  defaults to TLS on port 50002; plaintext now warns.
- **H4 (partial)** — `rejectUnauthorized: true` set explicitly; TLS caveat warned
  in-app. Full hostname verification needs a native change (see below).
- **M1** — TAPSIGNER authenticity is now verified at import: the card must sign a
  fresh nonce with the key it presents (`check`), and that key's certificate chain
  (`certs`) must recover up to Coinkite's production factory root. The emulator's
  "TESTING ONLY" root is deliberately excluded. `verifyCardCertificate` in
  `tapsigner.ts`; tests in `tests/tapsigner.test.ts` → "card certificate verification".
- **M2** — server fee rates clamped (`clampFeeRate`, ≤2000 sat/vB) in both backends.
- **M3** — HTTP fetch timeout + response-size guard; Electrum read-buffer cap.
- **M5/M6** — invites reject non-`ws(s)` relays, cap relay count and cosigner `n`
  at 20. Tests in `tests/nostr.test.ts` → "invites".
- **M7** — mitigated by C3 (coordinator pinning).
- **L1** — silent group-secret migration failure now logs a warning.

**Requires a native change / new dependency** (not done — would need a rebuild I
can't verify here; each is called out inline below):
- **H4 (full)** — Electrum-over-TLS hostname verification: `react-native-tcp-socket`
  6.4.2 exposes no option for it. Needs a library patch/upgrade or certificate
  pinning via its `ca` option (paste the node's cert). Interim posture: TLS on a
  trusted network, as the app now advises.
- ~~**M4** — exclude the iOS AsyncStorage DB from iCloud backup (config plugin setting
  `NSURLIsExcludedFromBackupKey`).~~ Done 2026-10-11 as a local Expo module
  (`modules/ios-backup-exclusion`); see the follow-up audit above.
- ~~**M9** — biometric gate before revealing secrets (`expo-local-authentication`) and
  screenshot blocking (`expo-screen-capture`); neither package is installed.~~ Done
  2026-10-11 (`confirmOwner`, `usePreventScreenCapture`; see the follow-up audit above).
- **M8, L2–L7** — inherent design tradeoffs / minor hardening; see notes inline.

## Overall posture

The **cryptographic core is sound** — CSPRNG-backed mnemonics, mnemonics kept only
in the device keystore, XChaCha20-Poly1305 AEAD for group messages, hardened
per-group NIP-06 identities, correct BIP67/`sortedmulti`, verified TAPSIGNER
*signatures*, no secret logging. The real risk is **trust/validation gaps**: the app
signs transactions and accepts wallets from semi-trusted sources (other cosigners,
QR, files, relays) without independently verifying them against its own descriptor.

The two critical findings **compound**: an unauthenticated coordination layer that
lets any participant inject a transaction, plus a signer that trusts the PSBT's own
metadata about what is "change". Together they let one malicious member of a group
wallet drain it.

---

## CRITICAL

### C1 — Signer trusts attacker-supplied `bip32Derivation` to classify "change"
`src/lib/wallet.ts:411`, consumed in `src/screens/PsbtScreen.tsx`

`summarisePsbt` marks an output as change purely because it carries a
`bip32Derivation` field:
```
const isChange = (psbt.data.outputs[i]?.bip32Derivation?.length ?? 0) > 0;
```
That field is attacker-controlled PSBT metadata. It is never re-derived against the
wallet's cosigner xpubs, and the output script is never compared to a wallet-owned
address. `PsbtScreen` then filters change out of the prominent "Sending" list and
paints it with a green "Change" tag.

**Attack:** a malicious cosigner sends a PSBT spending your real UTXOs to *their*
address, with a bogus `bip32Derivation` attached to that output. Your screen shows
little or nothing leaving the wallet. You sign; funds go to the attacker.

**Fix:** re-derive change. For every output flagged as internal, recompute the
wallet's address for the claimed branch/index (you already have `deriveAddress`) and
require it to equal the output script; otherwise render it as a normal external
send. Do not rely on the presence of derivation metadata.

### C2 — No verification that a signed PSBT's outputs pay back to the wallet
`src/lib/wallet.ts:483` (`signPsbtWithMnemonic`), draft ingestion in
`src/screens/WalletScreen.tsx`

`signInputHD` is called on every signable input with no check that the transaction's
destinations are wallet-controlled or that the amount returned as change is sane. The
first message defining a given `unsignedTxId` sets the outputs and is trusted (merges
are correctly guarded to the same txid — `wallet.ts:624` — so the exposure is the
initial draft, which is what an attacker controls).

**Fix:** before signing, compute independently from the wallet descriptor how much
leaves vs returns, and surface a clear "X leaving to N external addresses"
confirmation derived from verified data, not from the PSBT's self-description.

### C3 — Coordinator is never authenticated; any invite-holder can push a wallet
`src/screens/GroupScreen.tsx:86` (`walletMessage` = latest `wallet` from *any*
author), `:227` (`acceptWallet` checks only network/m/n), `types.ts` (Group stores no
coordinator pubkey)

Any holder of the invite secret — including whoever the link was forwarded through —
can publish a `wallet` message whose descriptor is the right m-of-n but composed of
attacker xpubs. `acceptWallet` does not require the accepting member's own key to
appear in it.

**Fix:** pin the coordinator's Nostr pubkey in the `Group` record at
create/join time and only accept `wallet`/`selection` messages authored by it. Add
H1's self-inclusion check as a second gate.

### C4 — Received key fingerprint is not bound to its xpub (cosigner substitution)
`src/lib/slip132.ts:44` (`parseKeyExpression`), `src/screens/GroupScreen.tsx:195`
(`buildWallet` uses `c.fingerprint`/`c.xpub` verbatim)

The `[fingerprint/path]xpub` fingerprint is attacker-chosen text, never checked
against the xpub. The coordinator UI tells the user to verify a contributor's key by
reading the fingerprint aloud — but that check can't detect a swapped xpub because
the fingerprint isn't derived from it. (`acceptWallet` does cross-check xpub↔
fingerprint, but only for *local* keys, and `buildWallet` does not.)

**Fix:** when ingesting a key expression, recompute the fingerprint from the xpub's
parent/key data and reject the message on mismatch, so the voice-verified fingerprint
actually commits to the key.

---

## HIGH

### H1 — Members accept a coordinator wallet without confirming their own key is in it
`src/screens/GroupScreen.tsx:227` — `acceptWallet` never requires a local key among
the cosigners. A member can end up watching a balance they can never sign for. Fix:
require at least one `parsed.cosigners[*]` to match a local key with xpub
confirmation before adding the wallet.

### H2 — No fee sanity bound on externally supplied PSBTs (fee-burn)
`src/lib/wallet.ts:436` — fee is computed and displayed but never bounded. A hostile
draft can route the remainder to miners. Fix: hard-warn/refuse when
fee exceeds a fraction of the spend or an absolute sat/vB ceiling.

### H3 — Cleartext HTTP allowed app-wide; plaintext is the Electrum default
`app.config.ts` (`NSAllowsLocalNetworking:true`, `usesCleartextTraffic:true`) +
`AndroidManifest.xml:17` (`usesCleartextTraffic:true`), `src/lib/chain.ts:29`
(default port 50001, `tls:false`), esplora accepts `http://`.

A custom backend over plain HTTP / TCP is fully MITM-exposed: forged balances,
hidden UTXOs, fake confirmations, swapped broadcast txid, inflated fee rates. Fix:
drop the global cleartext flags; require TLS (or an explicit, scary opt-in reserved
for LAN/Tor/VPN); default the Electrum TLS toggle on.

### H4 — TLS Electrum connections are not hostname-verified
`src/lib/electrum/rnSocket.ts:23` calls `connectTLS({host,port,tls:true})` with no
options. `react-native-tcp-socket`'s Android layer uses a raw `SSLSocket` from
`SSLSocketFactory.getDefault()` with no `HostnameVerifier` /
`setEndpointIdentificationAlgorithm("HTTPS")`. The chain is validated but **any
CA-signed cert for any domain is accepted**, so "TLS On" still MITMs. Fix: enforce
hostname verification (verify against `target.host` at the JS layer, or patch/replace
the socket lib); this is the load-bearing transport risk.

---

## MEDIUM

- **M1 — TAPSIGNER authenticity not verified at import.** `src/lib/tapsigner.ts:290`
  reads the xpub from card responses without validating the Coinkite factory
  certificate chain (`certs`/`check`). A counterfeit/emulated card can inject an
  attacker xpub as a cosigner. (Signing is mitigated — signatures are
  `ecc.verify`'d against the expected pubkey.) Fix: request and validate the card
  certificate chain during `tapsignerFetchKey`.
- **M2 — Server can forge fees causing overpayment.** `adapter.ts:185`,
  `esplora.ts:76`, no ceiling in `protocol.ts:75` / `wallet.ts:254`. Cap server fee
  rates. (Same root as H2, backend side.)
- **M3 — Unbounded read buffer / no response size or HTTP timeout.**
  `electrum/client.ts:72` accumulates until a newline; `esplora.ts:29` `res.json()`
  has no size cap or fetch timeout. A hostile server/MITM can OOM the app. Fix:
  cap buffered bytes, add a fetch timeout, validate response shape before indexing.
- **M4 — iOS AsyncStorage is in iCloud/iTunes backups.** `app.config.ts` sets Android
  `allowBackup:false` (good) but has no iOS exclusion — wallet metadata (every xpub,
  descriptor, chat history, pending PSBTs) lands in iCloud. Mnemonics are safe
  (`WHEN_UNLOCKED_THIS_DEVICE_ONLY` keychain items are excluded). Fix: exclude the
  AsyncStorage DB from iOS backup.
- **M5 — Invite relay list injected unvalidated.** `protocol.ts:151` accepts any
  `r=` value (no `wss://` enforcement, no count cap) → plaintext relay downgrade /
  connection fan-out. Enforce `wss://` and cap the count.
- **M6 — Invite policy `n` has no upper bound → render DoS.** `protocol.ts:149`;
  `GroupScreen.tsx:430` does `Array.from({length: slotsLeft})`. An invite with
  `t=100000000` hangs/OOMs the joiner. Cap `n` (e.g. ≤ 20).
- **M7 — Stale-event replay/reorder.** `session.ts:55` subscribes with no `since`;
  "current" selection/wallet is chosen by receive order with attacker-set
  `created_at`. A relay can resurface a superseded event. Mitigated by pinning the
  coordinator (C3) + monotonic sequencing.
- **M8 — Privacy: default public server clusters the whole wallet.**
  `esplora.ts:3` (`mempool.space`) queried per-address. Standard light-client
  tradeoff; the private-server toggle you just added is the mitigation — worth
  nudging privacy-conscious users toward it.
- **M9 — Secrets reveal with no auth + no screenshot protection.** SecureStore items
  lack `requireAuthentication` and there's no app lock, so "Show recovery phrase"
  and the invite QR are one tap from an unlocked phone; no `expo-screen-capture`
  FLAG_SECURE on the phrase/invite screens. Fix: biometric gate before revealing
  secrets; FLAG_SECURE on those screens.

---

## LOW / INFO

- **L1 — Silent group-secret migration failure** leaves the secret in plaintext
  AsyncStorage (`store.tsx:163`); overwrite doesn't scrub SQLite WAL/free pages.
- **L2 — Secrets reach the clipboard** (selectable phrase; tap-to-copy invite) →
  cloud-syncing keyboards exfiltrate.
- **L3 — Invite grants permanent history decryption, no rotation/forward secrecy**
  (`nostr/crypto.ts:80`). Inherent to the design; consider rotating after wallet
  creation.
- **L4 — AEAD binds no associated data** (channel tag unauthenticated,
  `crypto.ts:121`) — defense-in-depth only; wrong-key ciphertext already fails open.
- **L5 — SPV-less: server trusted for balances/confirmations/censorship.** Bounded on
  spends (BIP143 commits to input value). Inherent to a light client.
- **L6 — Dev-only insecure RNG fallback** in `react-native-get-random-values`
  (`__DEV__` + Chrome debug only) — not reachable in release.
- **L7 — `seen` set / chat memory grow unbounded** — minor.

---

## Verified sound

Mnemonic entropy (noble `randomBytes` → native CSPRNG, fails closed); dice entropy
(≥50 rolls, SHA-256); SecureStore usage; no secret logging; exports carry public
data only; XChaCha20-Poly1305 nonce handling and key derivation; length-hiding
padding; NIP-01 event signature verification; hardened per-group NIP-06 identities;
PSBT merge safety (same-txid guard); `removeSignature`/over-signed handling; receive
address derivation; BIP67/`sortedmulti`/descriptor + checksum; TAPSIGNER signing-path
verification and CVC masking; CBOR/`qrParts`/`slip132`/`cryptoOutput` bounds
checking; `bip21`/scan address validation; `backupPdfHtml` escaping; Android
`allowBackup:false`. No malicious/typosquatted dependencies observed.

## Suggested fix order

1. C1 + C2 (change re-derivation + verified send summary) — stops fund theft via PSBT.
2. C3 + C4 + H1 (pin coordinator, bind fingerprint↔xpub, self-inclusion check).
3. H3 + H4 (transport TLS + hostname verification).
4. H2/M2 (fee bounds), M3 (response limits), M6/M5 (invite bounds).
5. M1 (card cert), M4 (iOS backup), M9 (secret reveal gating), remaining lows.
