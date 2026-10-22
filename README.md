# Simple Multisig

A mobile multisig bitcoin wallet for iOS and Android, built with Expo and React Native.

Multisig is normally the preserve of desktop coordinators and hardware wallets. This app aims at
the people who need it most and get it least: a household, a small business, a group of friends
holding funds together. One decision per screen, standards underneath, and no invented formats
that would strand you in this app.

Wallets are **2-of-3**, **3-of-5**, or whatever M-of-N you choose. Keys can live on the phone, on a
hardware wallet, or with other members of your group. Coordination happens over QR codes and files,
or — optionally — over Nostr relays.

> **Status: hobby-grade.** The wallet engine is well covered by tests and every format it produces
> is standard, but this has not been audited or run against meaningful funds. Read
> [Security and privacy](#security-and-privacy) before trusting it with anything you cannot lose.

---

## What it does

**Keys**
- Create keys on the phone: BIP39 12-word mnemonics, stored only in the iOS Keychain or Android
  Keystore, device-only, never in a cloud backup.
- **Your name**, asked for once, the first time a key is made. The people you share a wallet
  with see it next to your key in the wallet and on your messages in a group; nobody else does.
  Phone keys are named after it ("Rob's phone"), and it can be changed in Settings.
- **Dice entry**, the recommended way to make a key — roll a physical die, tap the numbers, and
  the seed comes from your entropy rather than the phone's. Fewer than 50 rolls is refused. The
  phone's secure generator remains available as the quick option.
- **Restore a phone key** from its recovery phrase (Create key → *Restore from a recovery
  phrase*): the same key comes back and is linked to the wallets that include it. A phrase whose
  key is already on the phone is refused.
- Import public keys from Coldcard, TAPSIGNER, SeedSigner, Jade, Trezor, Ledger and BitBox02:
  paste, file, QR (including animated), NFC, or a USB cable. All SLIP-132 flavours
  (`xpub`/`Zpub`/`tpub`/`Vpub`…) are accepted and normalised; extended *private* keys are refused.
- **Ledger, Trezor and BitBox02 over USB** (Android) — plug the device into the phone to read its
  multisig key, and again to sign: the transaction goes to the device, which shows it for checking
  and signs. See [Hardware wallets over USB](#hardware-wallets-over-usb).
- **Health checks** — every key asks to be proven again a year after it was added (the
  interval is per key: off, 3 or 6 months, 1 or 2 years). A phone key passes by typing the
  words from its written backup; a hardware key by reading its public key from the device
  again and matching the xpub. Until then the key and the Keys tab carry a badge.
- Keys can be renamed from their detail screen, and the cosigner name in every wallet that uses
  the key follows. Showing a recovery phrase asks for your fingerprint, face or passcode first.

**Wallets**
- **Private wallets** — everything stays on the phone. You gather the keys and move transactions
  by QR, file, or your own messaging apps. Nothing touches a relay.
- **Group wallets** — members coordinate over Nostr, through the built-in public relays or relays
  you add in Settings (each is tested before a group depends on it, and the Settings list shows
  which ones answer). Keys, the finished wallet, transactions and a group chat move between phones
  automatically, with unread badges on the Wallets tab, and each key in the wallet is named after
  the member who shared it. Once everyone has arrived the coordinator
  closes the roster, which moves the group onto a key the invite link cannot read, so a link that
  surfaces later opens nothing but the handshake. A member who loses their phone restores the
  wallet from its backup and is let straight back in — see [RECOVERY-DESIGN.md](RECOVERY-DESIGN.md).
- Native segwit **P2WSH**, **BIP48** derivation, **BIP67** sorted keys, so addresses match Sparrow,
  Coldcard, Specter and Nunchuk exactly.
- Import an existing wallet from an output descriptor, a Coldcard/Sparrow config file, or a JSON
  export — by paste, file, or QR.

**Spending**
- Balance, coins and history from your own server, cached and refreshed incrementally.
- **Receive** shows a fresh address with its QR code, and a new one on request.
- A stepped send flow: recipient, amount on a keypad with a sats/BTC toggle, confirmation speed,
  then a review screen showing the real fee from the built transaction. The recipient can be
  scanned — a bare address or a BIP21 payment link, amount included.
- **Coin control** — pick exactly which coins a transaction spends.
- Custom fee rates, including sub-1 sat/vB, with an honest warning about relay policy.
- The signatures screen says how to get each missing signature from where its key lives: sign
  here, tap the card, plug the device in, or send the transaction to the person and merge the
  signed copy they send back. A transaction pasted with a message around it is still read.
- PSBTs shared by animated QR (`ur:crypto-psbt`), file, messaging app, or Nostr, or signed
  directly by a TAPSIGNER (NFC) or a Ledger, Trezor or BitBox02 (USB). Signatures merge
  automatically, and merging refuses a copy of a different transaction.
- RBF enabled by default.

**Backups**
- A wallet is not recoverable from your seed alone — you need every cosigner's public key too. The
  app nags until you have exported either a Sparrow-compatible config file or a printable PDF of
  QR codes, and records when you last did. Sending the wallet to a Coldcard over NFC does not
  count — that copy lives on a signer, not away from it.
- A group wallet's backup carries the group too — the invite, and which key your group identity
  comes from — so a lost phone can rejoin: restore the key from its phrase, the wallet from its
  backup, and the coordinator seals the current group key back to a pubkey already on the roster.
  If it was the coordinator's phone, the members tell it which key the group is on and it
  re-secures above that. Only the invite goes in a backup; the rotated keys never do.
- **Verify a backup** (Manage → Verify a backup): scan the printed QR, open the saved file or paste
  its text, and the app checks that it describes this wallet — policy, network, every cosigner and,
  for a group wallet, the group — without importing anything. A match records `backupVerifiedAt`; a backup exported after that is
  flagged as unchecked until you verify it again.
- **Guided setup** (the first thing a new install offers, and Wallets → + → *Set up a private
  wallet step by step*): answers three questions to recommend 2-of-3 or 3-of-5, plans where each
  key should live, walks through creating or importing them (with a ready-made message to send
  anyone who will hold a key on their own phone), requires a backup, and then has you verify it. Progress is saved at every step;
  a checklist of recommended extras (recovery phrases stored apart, address cross-check, loading
  the hardware signer, a test transaction) stays reachable from Manage → Setup checklist for any
  wallet.

---

## Hardware wallets over USB

On Android, a Ledger, Trezor or BitBox02 plugs straight into the phone — a USB-C cable, or the
device's own cable with an adapter. iOS gives apps no access to USB devices, so there the buttons
are not shown and keys arrive by QR, file or paste as before.

| Device | Works with | Notes |
|---|---|---|
| **Ledger** Nano S, S Plus, X, Stax, Flex | Bitcoin app 2.1.0 or later | Open the Bitcoin app first (*Bitcoin Test* for testnet). The first signature for a wallet shows the wallet on the device for approval; that approval is remembered. |
| **Trezor** Model One, Model T, Safe 3, Safe 5 | firmware 1.9.1 / 2.3.4 or later | A Model One's PIN is tapped on a blank keypad on the phone, read against the device. Passphrase wallets are supported, typed on the phone or the device. The **Safe 7** only speaks Trezor's newer encrypted protocol and is recognised but not supported. |
| **BitBox02** Multi, Bitcoin-only, Nova | firmware 9.4.0 or later | The first connection shows a pairing code on both screens to compare. The first signature for a wallet stores the wallet on the device. The device must pass BitBox's attestation check. |

**Importing a key** (Keys → Import key → *Connect by USB*) reads the account key at the BIP48
P2WSH path. Nothing on the device changes. The same button, from a key's health check, reads the
key again and compares it.

**Signing** (on a transaction: *USB* next to a key that came from a device, or *Sign with a USB
device* for any key in the wallet) sends the transaction to the device, which shows every payment
and the fee for approval on its own screen.

What the app checks, whichever device it is (`src/lib/hw/sign.ts`):

- **The device holds the key, not just its fingerprint.** The account key is read from the device
  and must equal the one in the wallet. A device opened with a different passphrase fails here,
  with a message saying so, before it is shown anything.
- **Every coin being spent is the wallet's own**, re-derived from the wallet's keys. A draft that
  spends anything else is not sent to a device at all.
- **Amounts are checked against the chain.** Each device wants the whole transaction every input
  spends from. They are fetched from your server, and each must hash to the txid the input names
  and carry the amount and address the draft claims — a server cannot substitute one. They are
  shown to the device only; the stored draft stays as small as it was.
- **Change is what the wallet derives, never what a draft says.** A payment dressed up as change is
  shown on the device as a payment.
- **Every signature is verified** against the sighash this app computed, and against the key the
  wallet expects, before it is attached.

What is remembered between connections lives in the device keystore: a Ledger's approval of each
wallet, and the key this phone pairs with a BitBox02 under.

> **Not yet tried on physical devices.** Each driver passes against the manufacturer's own firmware
> running in its emulator — Ledger's Bitcoin app under Speculos, Trezor's firmware emulators for
> the Model One, Model T, Safe 3 and Safe 5, and the BitBox02 simulator — which exercises the
> protocols end to end. The Android USB layer underneath them has only been compiled and loaded,
> never run against a real device. Try a new device with a testnet wallet or a small amount first.

---

## Installing it

The recommended way, in two steps.

**1. Get your clanker to check the code.** Point whatever AI you use at this repository and ask
it to look for security holes and for malicious intent: key material leaving the device, entropy
weaker than it claims to be, network calls that are not in [Security and privacy](#security-and-privacy),
anything in the dependency tree that does not belong. [SECURITY-AUDIT.md](SECURITY-AUDIT.md)
records the review rounds so far and is a fair place to start it. Then read what it finds. That is
still not an audit, but a wallet you have had read is better than one you have not.

**2. Compile it yourself and drop it onto your favourite mobile device.** With the phone plugged in
and developer mode on:

```bash
npm install
npx expo run:android --variant release --device     # pick the phone from the list
npx expo run:ios --configuration Release --device   # macOS and an Apple ID; a free one re-signs weekly
```

That builds the native app from the source you just had read and installs it. Nothing arrives from
a store or a build server, and no signing key but your own is involved. [Running it](#running-it)
covers the emulator and the details.

**Other ways in**, each trading some of that assurance for convenience:

- **Obtainium** (Android). Add `https://github.com/onesandzeros-nz/simple-multisig-wallet` as an
  app source and [Obtainium](https://github.com/ImranR98/Obtainium) installs the APK attached to
  each [GitHub release](https://github.com/onesandzeros-nz/simple-multisig-wallet/releases) and
  tells you when a new one lands. Each release note carries the APK's SHA-256; check it. You are
  trusting the GitHub release and the signing key of Ones and Zeros Technology Limited.
- **Zapstore** (Android). The app is published to [Zapstore](https://zapstore.dev), the app store
  built on Nostr — `zapstore.yaml` in the repository root is its config. Zapstore checks the APK's
  hash against what the developer's Nostr key signed, and shows who in your web of trust vouches
  for it. Same trust as Obtainium, with the developer's identity verified by Nostr rather than by
  GitHub.
- **Dangerously, from your app store.** It is on
  [Google Play](https://play.google.com/store/apps/details?id=nz.onesandzeros.simplemultisig) now,
  and on the App Store once it is through Apple's review, as *SMS: Simple MultiSig Wallet*. What
  you get was built on EAS's machines and signed with keys the stores hold, not the developer, and
  nothing on your phone lets you compare it with the source you read. It is also the only way onto
  an iPhone without a Mac, so on iOS this is the realistic option for most people. Treat it
  accordingly.

---

## Running it

```bash
npm install
npx expo run:android      # native modules mean a build, not just Expo Go
npx expo run:ios          # requires macOS
```

Camera, NFC, USB, file access, TCP and the keystore all need a development build.

### On an Android emulator

A real phone is the better target — see the caveats at the end of this section — but an emulator
covers most of the app, and it happily coexists with a device plugged into the same machine.

Create one once from the command line (`$ANDROID_HOME` is usually `~/Android/Sdk`, and the
binaries live in its `cmdline-tools/latest/bin`):

```bash
sdkmanager "emulator" "system-images;android-36;google_apis;x86_64"
avdmanager create avd -n multisig -k "system-images;android-36;google_apis;x86_64" -d pixel_7
```

The defaults `avdmanager` writes are too small for a React Native debug build — the 800M data
partition in particular fills before the app is installed. Edit
`~/.android/avd/multisig.avd/config.ini`:

```ini
hw.ramSize=3072M               # was 1536M
vm.heapSize=512M               # was 228M
disk.dataPartition.size=8G     # was 800M
hw.gpu.enabled=yes             # render on the host GPU rather than in software
hw.gpu.mode=host
hw.keyboard=yes                # type with the real keyboard instead of the on-screen one
```

Then boot it and build. On Linux the emulator needs access to `/dev/kvm` to run at native speed;
without it the image is emulated instruction by instruction and is too slow to be useful.

```bash
$ANDROID_HOME/emulator/emulator -avd multisig &
npx expo run:android --device multisig
```

**Alongside a connected device.** `adb` addresses a USB device and an emulator separately, so two
apps can run on the two targets at once. Only two things collide. Pass `--device` so an install
cannot land on the wrong target, and `--port` if another project already holds Metro's default
8081:

```bash
npx expo run:android --device multisig --port 8083
```

A cold Gradle build wants several GB of RAM on top of whatever the emulator is holding, so it is
worth letting another project's build finish before starting this one.

**What an emulator cannot do.** `expo-camera` sees a synthetic scene rather than a real camera, so
importing a key by QR and scanning a PSBT need a device. NFC is not emulated at all, which puts the
TAPSIGNER path out of reach, and a hardware wallet needs the phone's own USB port. Everything else — guided setup, wallet creation and import, PSBT
build, sign and merge, the Esplora and Electrum backends, backups, verification and health
checks — behaves normally.

## Releasing

Store builds go through [EAS](https://docs.expo.dev/build/introduction/), which holds the signing
keys, builds iOS on its own Macs, and uploads to both stores. `eas.json` has the profiles:
`production` (an Android app bundle and an App Store build), `preview` (an installable APK) and
`development`.

One-time setup:

```bash
npm install -g eas-cli
eas login                      # the Expo account the project belongs to
eas init                       # prints a project id — put it in app.config.ts under extra.eas.projectId
```

Google Play needs an app created in the Play Console first, and its **first upload made by hand**
there (an `.aab` from `npm run build:android`). After that, a Google service account key with
release access, saved as `secrets/play-service-account.json` (gitignored), lets `npm run
submit:android` upload to the internal track as a draft. Play App Signing keeps the real signing
key; EAS keeps the upload key.

The App Store needs the app created in App Store Connect first. `npm run build:ios` then `npm run
submit:ios` asks for your Apple ID the first time (or set an App Store Connect API key in
`eas.json`), uploads to TestFlight, and the release itself is submitted from App Store Connect.
Apple only accepts cryptocurrency wallets from developers enrolled as an organisation.

Bump the version in `package.json` and run `npm run prebuild-version` before a store build: the
build number is a timestamp, so it only ever grows, and `changelog.json` gets its entry.

A GitHub release is a tag plus the APK from `npm run build:apk`:

```bash
git tag -a 0.1.0 -m "0.1.0" && git push origin 0.1.0
gh release create 0.1.0 simple-multisig-0.1.0.apk --title 0.1.0 --notes-file notes.md
```

## Tests

```bash
npm test           # full suite (node:test)
npm run selftest   # end-to-end sanity check of the wallet engine
npm run smoke      # runs the engine under Hermes-like globals to catch
                   # device-only failures before a build
```

The hardware wallet drivers have a second set of tests that run against the manufacturers' own
emulators. They are skipped unless told where one is running:

```bash
# Ledger: the Bitcoin app under Speculos (github.com/LedgerHQ/speculos), seeded with the
# first mnemonic in tests/helpers.ts — APDU port, then the automation API
LEDGER_SPECULOS=127.0.0.1:9999,http://127.0.0.1:5000 \
LEDGER_SPECULOS_TESTNET=127.0.0.1:9998,http://127.0.0.1:5001 \
  node --import tsx --test tests/hwLedger.test.ts

# Trezor: a firmware emulator from data.trezor.io/dev/firmware/releases/emulators-new/
TREZOR_EMULATOR=127.0.0.1:21324 node --import tsx --test tests/hwTrezorEmulator.test.ts

# BitBox02: the simulator from the firmware's GitHub releases; the test starts it itself
BITBOX02_SIMULATOR=/path/to/bitbox02-multi-v9.27.1-simulator1.0.0-linux-amd64 \
  node --import tsx --test tests/hwBitbox02Simulator.test.ts
```

The suite covers BIP39/BIP48/BIP67 derivation against known vectors, the Bitcoin Core descriptor
checksum vector, all ten SLIP-132 key flavours, descriptor and config-file round trips, multi-party
PSBT signing at several thresholds, fee-estimate safety (the real transaction is never larger than
the estimate it paid for), incremental chain sync, the Electrum protocol, BC-UR QR assembly, the
CKTap card protocol, the Nostr group layer — its relay client's inbound limits, the outbox and what
it will resume from disk, key rotation, recovery after a lost phone, the receipts members send —
security mode's PIN rules and decoy inbox, what the duress wipe reaches, and the Ledger, Trezor and
BitBox02 protocols — each against a stand-in for the device that checks what it is sent, with
encodings compared against the manufacturers' own libraries.

`npm run smoke` exists because Hermes differs from Node in ways that only bite on device — missing
`Buffer`, absent `process.version`, and `TypedArray.subarray` ignoring `@@species`. It emulates all
three, and runs the hardware wallet drivers through a signature under them.

---

## Architecture

```
src/
  lib/
    bitcoin.ts        key generation, BIP48/BIP67 derivation, descriptors, fee estimation
    wallet.ts         incremental chain sync, coin selection, PSBT build/sign/merge/finalize,
                      bounds on incoming PSBTs and the cap on unfinished drafts
    walletCache.ts    persistent per-wallet cache of balance, coins and history
    settled.ts        transactions already broadcast or seen, so a re-shared PSBT is not a draft again
    chain.ts          backend router: Esplora/mempool HTTP or Electrum, public server list,
                      whether a host looks private
    esplora.ts        Esplora / mempool.space-compatible HTTP client
    electrum/         Electrum protocol client, adapter and script-hash mapping
    slip132.ts        Zpub/Vpub/… normalisation, descriptor key expressions, the fingerprint rule
    descriptor.ts     Bitcoin Core descriptor checksum
    cryptoOutput.ts   BC-UR crypto-output (descriptor QR codes) back into a text descriptor
    walletImport.ts   descriptor, config-file and JSON wallet parsing
    walletExport.ts   Sparrow-compatible backup file and printable QR backup
    walletMatch.ts    when two wallet records describe the same on-chain wallet
    backupVerify.ts   compares a scanned/opened backup with a wallet without importing it
    groupBackup.ts    the group section of a wallet backup: enough to rejoin after a lost phone
    exportActions.ts  rendering and sharing the backup file and PDF
    buildWallet.ts    builds a private wallet record from chosen keys
    linkCosigners.ts  points each cosigner at the key on this phone that backs it — by xpub proof only
    keyImport.ts      key files from Coldcard, Sparrow and others; a fingerprint kept only when it is one
    keyShare.ts       descriptor key expression for a key held on this phone
    keyHealth.ts      the periodic nudge to prove a key still works
    keyCandidates.ts  members' keys and ours, kept apart on the Configure keys screen
    naming.ts         the one name a person gives the app, and what is derived from it
    tutorialPolicy.ts guided setup: policy recommendation, key plan, trade-off copy
    tutorial.ts       guided setup: draft and checklist transitions, backup/verify status
    bip21.ts          scanned payment targets: a bare address or a BIP21 link
    qrParts.ts        multi-part QR assembly (BC-UR, Specter, plain)
    qrExport.ts       animated ur:crypto-psbt export
    psbtFromBytes.ts  a PSBT out of whatever a hardware wallet wrote to an NFC tag
    tapsigner.ts      Coinkite CKTap card protocol
    nfc.ts            the NFC library, loaded only where it exists; nfcErrors.ts puts its errors into words
    cbor.ts           CBOR codec for CKTap and BC-UR registry types
    hw/               hardware wallets over USB: one driver per device, the checks they share
      ledger/         Ledger Bitcoin app: APDUs, wallet policies, merkleised PSBTs
      trezor/         Trezor wire protocol and its streamed transaction signing
      bitbox02/       BitBox02: Noise-encrypted channel, pairing, attestation
      devices.ts      which USB device is a wallet this app can talk to
      sign.ts         what is checked before a device is asked, and after it answers
      memory.ts       what a driver remembers between connections, in the keystore;
                      memoryStore.ts keeps the list of names so the wipe can erase it
      protobuf.ts     protobuf wire format for Trezor and BitBox02 messages
      usb.ts          packets to and from the phone's USB port; packetQueue.ts queues them,
                      usbErrors.ts puts the failures into words
    nostr/            group coordination
      crypto.ts       event signing, payload encryption and padding, sealing a key to one member
      protocol.ts     message types, their validation and bounds, invites
      client.ts       multi-relay client: reconnects, and limits on everything a relay sends
      session.ts      a group's live session: epochs, the guards both ways, rotation, reseal
      outbox.ts       store-and-forward until a relay confirms; outboxStore.ts persists it per
                      group, and nothing read back is believed unchecked
      recovery.ts     who to answer on the lobby after a lost phone
      epochs.ts       how epoch secrets are written into the keystore
      identity.ts     per-group Nostr identity from a phone key's seed
      receipts.ts     who has a shared transaction; walletAnswers.ts who added the wallet
      probe.ts        tests a relay before a group depends on it
      unread.ts       what is new since you last looked
      useGroup.ts     the hook behind every group screen; useRelayStatus.ts which relays answer
    securityPin.ts    security mode's PIN rules; securityMode.ts its record in the keystore
    decoy/            the messaging app the wallet hides behind: contacts, scripts, inbox storage
    ownerCheck.ts     fingerprint, face or passcode before a secret is shown
    errors.ts         one way to show an error and log it with its stack
    types.ts          the records everything above shares
    store.tsx         app state; secrets in the keystore, the rest in app storage
                      (a guided setup in progress lives under `sms.setup.v1`); the wipe
  components/         shared UI and the modals: QR and animated QR, NFC, USB, coin control,
                      configure keys, wallet answers
  screens/            one screen per flow; tutorial/ the guided setup steps, decoy/ the messaging app
modules/
  usb-host/           local Expo module (Kotlin): lists USB devices, asks Android for
                      permission, moves raw packets — nothing protocol-specific
  ios-backup-exclusion/
                      local Expo module (Swift): at launch, marks the directories app
                      storage uses as excluded from iCloud and iTunes backups
```

**Chain backends.** The wallet talks to one server: a public one chosen in Settings
(blockstream.info by default; mempool.space and mempool.emzy.de are also offered — all over HTTPS,
whose hostnames the app verifies), or the user's own. That can be any Esplora or
mempool.space-compatible instance, or an Electrum server (electrs, Fulcrum, ElectrumX) over TCP or
TLS — meant for a server you run on a network you control, since the app cannot verify an Electrum
server's hostname (see Known weaknesses). Links to transactions open on mempool.space, or on
your own server when one is connected, whichever server does the scanning. The Electrum adapter
reconstructs what Esplora would have returned — history is only txids and heights there, and
transactions arrive as raw hex, so previous outputs are fetched and decoded to work out spends and
fees, with immutable results cached.

**Incremental sync.** Address stats are cheap, so they are always checked; the expensive per-address
UTXO and history fetches only run for addresses whose transaction count changed, or that had
unconfirmed money last time (a confirmation does not change the count, so counting alone would miss
it). Reopening a settled wallet makes no heavy calls at all.

---

## Security and privacy

This section is deliberately complete, including the parts that are weak.

### Threat model

The app is built so that **losing the coordination layer never loses the money**. Recovery phrases
never leave the device keystore, and nothing published to a relay or printed in a backup can spend.
What the coordination layer can leak is *information*: which keys form a wallet, what it holds, and
who is transacting with whom.

### What is protected

- **Recovery phrases** live only in the iOS Keychain / Android Keystore, marked device-only, and
  are never written to app storage or included in a backup.
- **Group invite secrets** are held in the same keystore, because whoever has one can decrypt
  everything that group ever published.
- **Showing a secret asks for you first.** Showing a recovery phrase, or sharing or showing a
  group invite, asks for your fingerprint, face or device passcode (a phone with no passcode set
  is asked nothing — it is open to whoever holds it anyway). The screens that show or take a
  phrase, the PIN, a backup or an invite QR block screenshots and screen recording, and show
  nothing in the app switcher.
- **Android cloud backup is disabled** (`allowBackup=false`), so app storage — group records, chat
  history, wallet descriptors, xpubs — cannot ride along into a Google backup.
- **iOS backups leave app storage behind.** iOS has no such switch, so a local module
  (`modules/ios-backup-exclusion`) marks the directories AsyncStorage uses as excluded from iCloud
  and iTunes backups at every launch, before anything is written.
- **Group messages** are encrypted with XChaCha20-Poly1305 under a key derived from the invite
  secret. The channel identifier is a separate hash of that secret, so it reveals nothing about the
  key. A test asserts that no xpub or chat text ever appears in published events.
- **Messages are padded** to fixed size buckets, so a relay cannot tell a chat line from a key from
  a signed transaction by length alone.
- **Each group gets its own Nostr identity**, derived from your seed at a group-specific account
  index that deliberately avoids NIP-06 account 0. Two groups cannot be linked to one person, and
  none of them link to a public Nostr account you may use with the same seed.
- **Addresses are not sent to Electrum servers.** Electrum indexes by script hash, so the server
  sees opaque hashes rather than your addresses.
- **The wallet policy is verified on receipt.** A member's app refuses a wallet whose M-of-N does
  not match what the group agreed.
- **Once a group has rotated, the invite key carries nothing that matters, in either direction.**
  Keys, wallet descriptors and transactions are refused on send and ignored on receipt under the
  invite key; only a join and chat still travel on it. What a lobby join claims about the group is
  believed only from a pubkey already on the roster, and never past a sane bound.
- **Everything a relay sends is bounded before it is believed.** An oversized frame is dropped
  unparsed, an event is checked for shape and against the subscription before its signature is
  verified, each relay has a budget of events per minute, and every message type is validated field
  by field with a cap on each text — the same rule on send, so a phone refuses with a reason what
  others would drop in silence. What the outbox resumes from disk passes the same checks.
- **Security mode** (Settings → Security) disguises the app. The launcher shows it as "SMS", and
  while locked it opens as a working text-messaging app: fictional contacts, conversations that
  answer back, an inbox that keeps receiving messages. Sending the 6-digit PIN in any chat unlocks
  the wallet; the message is never stored. Three wrong PINs in a row erase every key, wallet, group
  and chat — keystore entries, hardware-wallet pairing memory and unsent messages included — with
  no warning, and the app carries on as a messenger. If
  a keystore entry will not erase, its name is kept, erased again on the next launch, and the
  Home screen says so after unlocking until it is gone. The
  PIN is salted and hashed in the keystore (`src/lib/securityPin.ts`, `src/lib/securityMode.ts`);
  the inbox lives in `src/lib/decoy/`. The app relocks after 30 seconds in the background.

### Known weaknesses

**The invite is a bearer capability, and a leak during setup is unrecoverable.** Holding the invite
link is the only membership check there is, and there is no revocation. Closing the roster bounds
the damage — a link that leaks *afterwards* opens only the handshake — but an attacker who has it
*before* that point simply joins, is sealed the new key along with everyone else, and follows the
group indefinitely. So verify cosigner fingerprints with their owners out of band before building a
wallet, and treat a link that may have leaked before the roster closed as a reason to start again.
Whatever channel you sent it through keeps a copy. Groups created before rotation existed stay on
the invite key for good. See [REKEY-DESIGN.md](REKEY-DESIGN.md).

**Holding the invite is the only membership check until the roster closes.** Event signatures
prove *an* identity, not an *authorised* one. Before rotation, anyone with the invite can publish
keys, wallet descriptors, transactions and chat. This is blunted where it matters most — the
coordinator explicitly approves which keys enter the wallet, and members verify the policy of the
wallet they receive. After rotation the invite key carries only joins and chat, so a leaked link
still allows convincing impersonation in the group chat, and nothing more. Verify cosigner
fingerprints with their owners out of band before building a wallet.

**Light-client scanning has a gap limit.** The wallet scans each branch until 20
consecutive unused addresses (and at most 200 addresses per branch). A wallet restored from
software that handed out addresses beyond that gap — or coins sent to a far-future address —
will not see those coins here until the gap is filled. Standard light-wallet behaviour, but
worth knowing before sweeping an old, heavily-used wallet.

**Limited forward secrecy, and relays retain events.** Relays store group messages indefinitely, so
whoever holds the key to a stretch of the channel can read that stretch for good. Rotation bounds
how much any one key covers: the invite key covers only the handshake, and the key that carries
account xpubs, descriptors and transactions is sealed to each member's own public key and never
published anywhere the invite can reach. It is one rotation, though, not a ratchet — lifting the
current key off a rooted or unlocked phone still exposes everything from that rotation onward, and
an xpub exposes a wallet's whole address history in both directions. The app can request deletion
(NIP-09) after broadcasting and on demand, but relays are not obliged to honour it and only your
own events can be removed.

**Relays can also drop events, so delivery is store-and-forward.** Every group message this phone
publishes stays in a per-group outbox until a relay confirms storing it, retried with backoff while
the app is open and again on the next launch; the transaction screen says when no relay has
confirmed a share, and why a relay refused it. Members' wallets send a receipt when a shared
transaction arrives, so the sender sees who has it and can re-share to whoever does not. A member
who agrees to or declines a built wallet tells the coordinator. If a rotation envelope is lost, the
coordinator seals the key again to any roster member still silent on the new epoch, and a member
who saw the rotation notice but never got the key knocks for it. New groups test each relay first,
by storing a realistic-sized event and reading it back over a fresh connection. Retries never
replay an old epoch's ciphertext after a re-secure — see REKEY-DESIGN.md.

**Signatures publish automatically.** In a group wallet, signing sends the signed transaction to
the relays without a further prompt. This is what makes multi-device signing work at all, but it
means the transaction's amounts, destination and change reach the relays as a side effect of
signing.

**Relay metadata is not hidden.** A relay sees your IP address, which channel you post to, when,
and which pubkeys share a channel. Padding conceals *what*; it does not conceal *who, when, and
with whom*. Use a VPN or Tor if that matters, and prefer a relay you run.

**Local storage beyond the keystore is not encrypted.** Chat history, wallet descriptors and xpubs
sit in ordinary app storage. Cloud backup is off and other apps cannot read it, but a rooted or
compromised device can.

**Third-party infrastructure sees what you ask it.** With a public backend (blockstream.info by
default), that provider learns your addresses and therefore your balance and history. Running your own node
(mempool.space instance or Electrum server) removes this, and is the single biggest privacy
improvement available. Note that a self-hosted server over plain HTTP is unencrypted on the wire —
acceptable over Tailscale, a VPN or your own LAN, not over the open internet. Over the open
internet, use an HTTPS mempool / Esplora server: the app verifies an HTTPS hostname, but not a TLS
Electrum server's (the socket library does not on Android), so Electrum — plain or TLS — belongs on
a network you control, and the public picks are HTTPS only. Settings says so when an Electrum host
looks like the open internet.

**Not audited.** No third party has reviewed this code. The cryptography is assembled from
well-regarded libraries (`bitcoinjs-lib`, `@noble/*`) rather than hand-rolled, and the engine is
tested against published vectors. Internal review rounds are written up in
[SECURITY-AUDIT.md](SECURITY-AUDIT.md) — every finding, what was fixed and what remains open — but
none of that is the same as an audit.

### Choices made deliberately

- **The invite only opens the handshake.** Once the roster closes the group moves onto a key sealed
  to each member's own public key, so the one secret that travels through WhatsApp or email is not
  the key to everything the group ever does. Announcing that key on the old channel would have
  achieved nothing — relays keep the announcement — which is why it is sealed per member instead.
- **Group identities are per group**, so relays cannot build a social graph across your wallets.
  They are derived from the invite secret and never rotate, so the coordinator stays pinned across
  a rotation and a member who reinstalls is recognised and let straight back in.
- **The coordinator picks keys explicitly** rather than accepting the first N to arrive, so a
  leaked invite cannot silently occupy a place in the wallet.
- **Backups contain public keys only.** The printable PDF and the config file cannot spend, and say
  so on their face — you still need your recovery phrase.
- **Confirming a send does not say "Sent".** In a multisig nothing moves until the threshold signs,
  and the interface does not pretend otherwise.

---

## Interoperability

Every artefact this app produces is standard:

- `wsh(sortedmulti(...))` output descriptors with Bitcoin Core checksums
- Coldcard/Sparrow/Specter wallet config files
- BIP174 PSBTs, shared as base64 or `ur:crypto-psbt` animated QR
- Descriptor key expressions in Sparrow's format: `[fingerprint/48h/0h/0h/2h]xpub…`

A wallet created here can be rebuilt in Sparrow from its descriptor, and vice versa. The Details
screen shows the descriptors and the first addresses so you can verify a match before funding
anything.

---

## Roadmap

- Make it simpler & easier
