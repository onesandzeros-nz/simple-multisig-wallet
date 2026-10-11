# Google Play Console: what the API cannot set

The listing text, icon, feature graphic and screenshots are uploaded by
`scripts/play-listing.js`. Everything below has no API and is filled in once, in
the Play Console, under **Grow → Store presence** and **Monitor and manage →
Policy → App content**. The answers are what the app actually does.

## Store settings (Store presence → Store settings)

- App category: **Finance**
- Tags: Bitcoin, Cryptocurrency wallet (pick the closest the console offers)
- Store listing contact details: email studio@onesandzeros.nz, website
  https://onesandzeros.nz (already set through the API)
- External marketing: off, unless you want Google to run ads for it

## App content

**Privacy policy** — https://onesandzeros.nz/privacy-policy

**Ads** — No, the app does not contain ads.

**App access** — All functionality is available without special access. No
login exists. (If the reviewer asks how to test: Settings → Testnet mode, then
create a key and a wallet.)

**Content rating** — start the questionnaire, category **Utility, Productivity,
Communication, or Other**. Answer **No** to every content question (violence,
sexuality, language, controlled substances, gambling, user interaction that
shares location, user-generated content). Note: the group chat is a private
channel between people who already hold a shared wallet, encrypted end to end,
not public user-generated content. If the questionnaire asks whether users can
communicate with each other, answer Yes and that it is a private, invite-only
chat with no discovery.

**Target audience and content** — Target age group **18 and over** only. Not
designed for children; the app is a financial tool. "Does your app
unintentionally appeal to children?" No.

**News app** — No.

**COVID-19 contact tracing and status apps** — No.

**Data safety** — Does your app collect or share any of the required user data
types? **No.** Is all user data encrypted in transit? Yes (TLS to chain servers
over HTTPS; encrypted events to relays). Do you provide a way for users to
request deletion? Not applicable, nothing is collected; if the form insists,
answer that all data is on the device and is deleted by deleting the app.
Independent security review: No.

**Government apps** — No.

**Financial features** — Yes, the app provides financial features. Type:
**Cryptocurrency exchanges and software wallets → Software wallet** (self-custody;
the developer never holds funds). It does not provide loans, insurance,
investment advice, or exchange services. New Zealand does not require a
licence for a non-custodial wallet; if the form asks for one, state that the
app is non-custodial and holds no customer funds.

**Health apps** — No.

## Release

- Testing → Internal testing holds the draft release EAS submitted (bundle
  1791751667). Add tester emails there to install it from Play, or promote it to
  closed/open testing or production when the forms above are complete.
- Play App Signing: when prompted, the upload key is the one in
  `../my-upload-key.keystore` (alias `onesandzeros-key`), already used to sign
  the bundle.
