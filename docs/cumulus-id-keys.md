# Cumulus://ID key directory

Mail publishes and looks up OpenPGP public keys at Cumulus://ID. The identity
service is a different repository. This app speaks the contract below and
keeps working when that service is absent: a failed lookup is a miss, not an
error, and mail still sends.

## Contract

Base URL: `CID_KEYS_URL`, default `https://id.cumuluscloud.app/api/keys`.

`GET {base}/{email}`

- `email` is lowercase and URL-encoded.
- `200` with `Content-Type: application/pgp-keys` and an armored public key.
- `404` when that address has not published one.
- No redirects. The body must contain `BEGIN PGP PUBLIC KEY BLOCK`.

`PUT {base}/{email}`

- Header `Authorization: Bearer <Cumulus ID access token>`.
- Body: the armored public key.
- `204` when the token's verified email is `{email}`.
- `401` or `403` otherwise. The private key is never sent.

Mail calls `PUT` after the owner creates or imports a key, and `GET` when a
recipient has no key on the contact. The local WKD on this host is checked
first.

## What the identity repo needs

A worker route implementing the two methods above, storing only the public
key, keyed by the verified email. No change to the sign-in flow.
