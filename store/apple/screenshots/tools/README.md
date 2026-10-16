# How the App Store screenshots were made

The images in `../iphone-6.9/` are 1320×2868 PNGs from the iPhone 17 Pro Max
simulator (iOS 26.5), Apple's 6.9" size. The app does not support iPad.

App Store Connect now requires the medium Dynamic Island size (1206×2622 or
1179×2556) and treats the 6.9" size as optional, so `../iphone-6.3/` holds
the same shots scaled to 1206×2622 with the alpha channel dropped (Apple
rejects transparency). Regenerate it from the 6.9" set with:

    for f in store/apple/screenshots/iphone-6.9/*.png; do
      magick "$f" -resize 1206x2622^ -gravity center -extent 1206x2622 \
        -alpha off -depth 8 "PNG24:store/apple/screenshots/iphone-6.3/$(basename "$f")"
    done

(and the same for `extra/`). Upload the 6.3" set; add the 6.9" set too if
you want the large phones to show native-resolution images.

The product page header and search results artwork in `../../promo/` are
built by `scripts/make-apple-promo.sh` from the logo mark and `02-wallet.png`.

The wallet data is seeded, not real: `seed.ts` writes keys, wallets, groups,
chats and one pending transaction into the app's AsyncStorage manifest, and
`fake-esplora.js` is a local Esplora-compatible server that answers the
wallet's address, UTXO, history and fee calls from `chain.json` (which
`seed.ts` also produces). The phone key ("Rob's phone") is restored through
the app's own UI from the recovery phrase `seed.ts` prints, so it lives in
the simulator keychain like a real one.

Steps, from the project root:

1. `npx expo run:ios --device <simulator udid> --no-bundler` with Metro running.
2. Install idb (`brew tap facebook/fb && brew trust facebook/fb && brew install
   idb-companion`, then `pip install fb-idb` in a venv) and set `UDID` and `IDB`
   at the top of `ui.py`. It dumps the accessibility tree and taps by label.
   Turn the simulator keyboard's autocorrect off first
   (`xcrun simctl spawn <udid> defaults write -g KeyboardAutocorrection -bool false`).
3. Keys tab → Create a key → name "Rob" → Restore from a recovery phrase →
   the phrase `seed.ts` prints → Restore key.
4. Quit the app, run `npx tsx store/apple/screenshots/tools/seed.ts <outdir>`
   with `LOCAL_KEY_ID` set to the id of the restored key (first entry of
   `sms.keys.v1` in the manifest), merge `manifest.seed.json` into
   `<container>/Library/Application Support/<bundle id>/RCTAsyncLocalStorage_V1/manifest.json`
   keeping the local key record, and start `node fake-esplora.js` from the
   directory holding `chain.json`.
5. `xcrun simctl status_bar <udid> override --time 9:41 --batteryState charged
   --batteryLevel 100 --wifiBars 3 --cellularBars 4`, relaunch, and take
   each screen with `xcrun simctl io <udid> screenshot <file>`.

Security mode was turned on for the "disguised as a messaging app" shot with
PIN 246810.
