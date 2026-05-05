# Wellbeing Mapper — Data Collection Server

Stateless Node.js/Express server that receives encrypted survey, consent,
and location blobs from the Wellbeing Mapper mobile app and persists them
for later offline decryption by the research team.

The server **never sees plaintext data**. Payloads are RSA/AES hybrid-
encrypted on the device with a public key bundled in the app, and can only
be decrypted with the corresponding private key held by the research team.

## Endpoints

| Method | Path                              | Purpose                                  |
| ------ | --------------------------------- | ---------------------------------------- |
| GET    | `/health`                         | Liveness probe                           |
| POST   | `/api/v1/surveys/encrypted`       | Initial / biweekly survey blob           |
| POST   | `/api/v1/consent/encrypted`       | Consent record blob                      |
| POST   | `/api/v1/locations/encrypted`     | Location batch blob                      |
| POST   | `/api/v1/participants/validate`   | Participant code lookup (hashed)         |
| POST   | `/api/v1/participants/register`   | Record an opted-in participant           |
| GET    | `/api/v1/participants/stats`      | Code-database stats (admin)              |

The submission paths must match the constants in
[`lib/util/env.dart`](../lib/util/env.dart).

## Local development

```bash
cd data_collection_server
cp .env.template .env
npm install
npm start              # listens on PORT (default 3000)
npm run test:local     # smoke-test against http://localhost:3000
```

Received blobs are written to `STORAGE_DIR` (default `./received`,
gitignored). Each file is named
`<timestamp>-<category>[-<survey_type>]-<random>.json` and contains the
raw request body plus a `received_at` timestamp.

## Participant codes

Generate the database with `python generate_participant_codes.py`. The
resulting `participant_codes.json` is gitignored and must be deployed
alongside `server.js`. Without it, `/participants/validate` returns 503.

## Deployment

* **AWS Lambda**: see `deploy/deploy-aws.sh`. Set
  `STORAGE_DIR=/tmp/received` (or wire `persistEncryptedBlob` to S3 for
  durable storage).
* **Vercel**: `vercel deploy`. The default config in `vercel.json` writes
  to `/tmp/received` (ephemeral). Replace with a persistent backend
  before collecting real data.

## Security notes

* No API tokens or upstream forwarding — encrypted blobs land on disk
  and stop there.
* `helmet`, `compression`, and `cors` are enabled by default.
* `participant_codes.json`, `.env`, `*.pem`, and `received/` are
  gitignored. Double-check before committing.
