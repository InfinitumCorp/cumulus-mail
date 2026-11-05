# Cumulus://Mail

Private email for every [Cumulus://ID](https://infinitum-corporation.vercel.app/products/cumulus-exchange). One address like `alex@cumulusmail.cloud`, shared storage with Cumulus Drive, encrypted at rest. Mail between Cumulus accounts is marked end-to-end. Nothing in the mailbox is scanned for ads.

This client is the web app: inbox, compose, drafts, calendar, contacts, and Conductor tasks. SCALVS briefs and drafts run through the xAI API when `XAI_API_KEY` is set on the server. Messages stay in the browser until a real mail backend is connected.

## Run

```sh
npm install
npm run dev
```

Open the printed local address. The dev server listens on port 8080.

## Stack

TanStack Start, React 19, Tailwind 4. `npm run build` produces the Vercel output.
