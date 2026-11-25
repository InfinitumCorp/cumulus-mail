# Installable app

The mail client is the web app. It is already an installable PWA
(`public/manifest.webmanifest`, `public/sw.js`). Installing it from the browser
is the supported native-shaped app. The shell is cached. Mail is not cached by
the service worker. An offline copy is an encrypted IndexedDB blob opened with
the mailbox passphrase (`src/lib/mail/offline-store.ts`).

## Capacitor

`apps/capacitor` wraps that same origin. It does not ship a second UI.

```sh
cd apps/capacitor
npm install
npx cap add ios
npx cap add android
npx cap sync
```

The web view loads `https://mail.cumuluscloud.app`. Set `server.url` in
`capacitor.config.ts` to a review host if you are not pointing at production.

## Expo

A second wrapper, same rule: the WebView loads the mail origin and does not
restyle it.

```sh
cd apps/expo
npm install
npx expo start
```
