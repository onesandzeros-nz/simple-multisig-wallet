# Privacy Policy for Ones and Zeros Apps

**Last updated: 12 October 2026**

Ones and Zeros Technology Limited ("we", "us", "our") of Queenstown, New Zealand, makes mobile apps. This policy explains what each of our apps does with information, and it applies to every app we publish under the Ones and Zeros name unless an app shows its own policy. It is written to comply with the New Zealand Privacy Act 2020 and with the policies of the Apple App Store and Google Play.

## The short version

Our apps do not collect personal information. We run no accounts, no analytics, no advertising and no crash reporting, and nothing you do in an app is sent to us. Where an app connects to the internet, it connects only to services you can see and choose, and this policy says which.

## What applies to every app

**No collection.** We do not collect, store or transmit personal information about you. We have no servers that receive data from the apps, so we have nothing to sell, share or lose.

**No accounts.** None of our apps asks you to sign up or sign in with us.

**No tracking.** The apps contain no analytics, advertising, tracking or crash-reporting software, from us or from anyone else.

**Your data stays on your device.** Anything an app keeps, it keeps on your phone. We cannot see it, and deleting the app deletes it, except where this policy says a secret lives in the phone's secure keystore and is removed when you remove it in the app.

**App stores.** Apple and Google handle the download, payment and update of our apps under their own privacy policies. They may tell us aggregate figures such as how many people installed an app, never who.

**Permissions.** An app asks for a device permission only for the feature that needs it, at the moment you use that feature, and uses it for nothing else. Each app's permissions are listed below.

**Open source.** Where an app's source code is published, as Simple Multisig's is on GitHub, you can check for yourself that it does what this policy says.

## Simple Multisig ("SMS")

Simple Multisig is a bitcoin wallet where spending needs more than one key. Everything it stores, it stores on your phone.

**What the app stores on your phone**

- Recovery phrases, group keys and your security-mode PIN record are kept in the phone's secure keystore (iOS Keychain or Android Keystore), marked as never to be backed up to the cloud.
- Wallet details (public keys, descriptors, balances, transaction history), group chat, pending transactions and settings are kept in the app's own storage. Android cloud backup is turned off for the app, and on iOS this storage is marked as excluded from iCloud and iTunes backups.
- If you turn on security mode, the app stores a fictional text-message inbox on your phone. The contacts and conversations in it are invented; they are not real people and nothing you type there is sent anywhere.

**Who the app talks to, and what they can see**

- *Blockchain server.* To show balances and send transactions the app queries a server. By default this is a public server you choose in Settings (blockstream.info, mempool.space or mempool.emzy.de, each run by its own operator), or your own node. That server sees your IP address and the wallet addresses it is asked about, and so can infer balances and history. Running your own node removes this.
- *Nostr relays, for group wallets only.* Members of a group wallet coordinate through public Nostr relays (relay.damus.io, nos.lol and relay.primal.net by default, or relays you add). What the app publishes there is encrypted so that only group members can read it. A relay sees your IP address, that encrypted data, and when it was sent, and relays generally keep what they are sent indefinitely. The app can ask a relay to delete its own messages, but relays are not obliged to comply.
- *The other members of your group.* Within a group you share, by your own actions, the name you chose, your public keys, the wallet's details, transactions to be signed and chat messages. These go to the other members, encrypted, through the relays above. Choose your group members as you would choose who to hand a wallet to.
- *Hardware wallets.* A Ledger, Trezor, BitBox02 or TAPSIGNER connected over USB or NFC sees the transactions you ask it to sign. The app keeps a pairing key for a BitBox02 and a wallet approval for a Ledger in the secure keystore so you need not repeat those steps.

Private wallets, which do not use a group, never touch a relay.

**Permissions the app may ask for**

- *Camera*: to scan QR codes for keys, wallets, transactions and payment addresses.
- *NFC*: to read a TAPSIGNER card or an NFC tag carrying a transaction.
- *USB* (Android): to connect a hardware wallet.
- *Biometrics or passcode*: to confirm it is you before a recovery phrase or group invite is shown. The check is done by the phone; the app never sees your fingerprint or face.
- *Files and sharing*: only when you choose to import or export a wallet, transaction or backup.

**Security mode.** Three wrong PINs in a row erase every key, wallet, group and chat on the phone. This is a feature you turn on yourself, and it is described in the app before you do.

## Boltcard NFC Programmer

Boltcard NFC Programmer writes Lightning Network payment cards. The app does not collect, store or transmit any personal information. All operations, including reading and writing NFC cards and reading a QR code, take place locally on your device.

**Permissions the app may ask for**

- *NFC*: to read from and write to compatible NFC tags and cards, such as NTAG424 DNA cards.
- *Camera*: to read the URL and key information used to program a card.

The app does not integrate with or use any third-party services, libraries or SDKs that collect data. Since no data is collected or transmitted, there is no server-side data for a breach to expose.

## Children

Our apps are not directed at children and do not knowingly collect information from anyone, children included.

## Your rights

Under the Privacy Act 2020 you can ask us what personal information we hold about you and ask for it to be corrected. Because our apps send us nothing, we do not expect to hold any; if you ask, we will confirm that and explain what the app keeps on your own device. If you are not satisfied with our response you may complain to the Office of the Privacy Commissioner, privacy.org.nz.

## Changes to this policy

When we change this policy we update the date at the top and publish the new version at the same address. Continued use of an app after a change means you accept the updated policy.

## Contact

Ones and Zeros Technology Limited
Queenstown, New Zealand
Email: studio@onesandzeros.nz
