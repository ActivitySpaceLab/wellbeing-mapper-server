# Wellbeing Mapper server

The server that the [Wellbeing Mapper app](https://github.com/ActivitySpaceLab/wellbeing-mapper-app)
sends research data to. It does two things:

* stores every survey and consent submission it receives, one file each, for
  the research team to decrypt on their own computers;
* answers whether a participant code is valid, from a list of code hashes.

It has no database, no accounts and no decryption. Each submission is
encrypted on the phone with the study's public key before it is sent, and
only the private key, which never goes near the server, can read it. So a
copy of the server's data directory is a complete backup, and someone who
breaks into the server gets encrypted files and code hashes.

Contents: [How the app talks to it](#how-the-app-talks-to-it) ·
[Deploying on the VPS](#deploying-on-the-vps) · [Keys](#keys) ·
[Participant codes](#participant-codes) · [Backups](#backups) ·
[Day-to-day operation](#day-to-day-operation) ·
[Decrypting the data](#decrypting-the-data) ·
[Development and tests](#development-and-tests) · [Security notes](#security-notes)

## How the app talks to it

| Method | Path | Request body | Answer |
| --- | --- | --- | --- |
| GET | `/health` | | `{"status":"ok","version":…}` |
| POST | `/api/v1/surveys/encrypted` | `{encrypted_data, survey_type: "initial"\|"biweekly", timestamp, submission_id}` | `{"success":true,"storage_key":…,"duplicate":false}` |
| POST | `/api/v1/consent/encrypted` | same, with `survey_type: "consent"` | same |
| POST | `/api/v1/participants/validate` | `{hashed_code}` (SHA-256 of the code, uppercased) | `{"valid":true,"code_type":"study"}` |

The paths are the constants in the app's `lib/util/env.dart`; the app builds
the full URL from `SERVER_BASE_URL` (see [Point the app at it](#point-the-app-at-it)).

The app uploads only when all of these hold: it is in research mode, the
participant has completed the consent form, and the build was given a server
URL. It retries network errors and 5xx answers with backoff and keeps the
record locally in the meantime; a 4xx answer is final. Biweekly surveys carry
the participant's location history for the period inside the encrypted
payload, so there is no separate location endpoint.

`encrypted_data` is the app's encrypted package: base64 of a JSON object
`{encryptedData, iv, encryptedKey, algorithm, researchSite, timestamp}`. The
payload is AES-256-GCM encrypted with a fresh key (the GCM tag is appended
to the ciphertext); the key is wrapped with RSA-OAEP-SHA-256, and the RSA
plaintext is the base64 *text* of the key. `tools/encrypt_sample.js` builds
one exactly this way and `tools/decrypt_received.py` reverses it. The server
checks the shape of the package (a request that is not one is rejected with
400, so junk is never stored) and stores the whole request body together
with `received_at`, `category`, `survey_type`, `submission_id`,
`client_timestamp`, `algorithm` and `research_site`.

`submission_id` is optional: a SHA-256 the app derives from the participant
id, the record type and the record's local id. If the same id arrives again
(the app retries after a lost answer), the server answers success with
`"duplicate": true` and stores nothing.

Other answers: `413` request larger than `MAX_REQUEST_SIZE`; `429` rate
limit; `503` no participant-code file on the server; `507` the storage
volume is nearly full (the app retries later).

## Deploying on the VPS

You need:

* a Linux virtual machine with a public address and sudo (the steps below
  assume Ubuntu or Debian);
* a DNS name for it, for example `wellbeing-mapper.upf.edu`, pointing at
  that address. The app is built with this name, and iOS refuses plain HTTP,
  so a name with a valid certificate is required;
* ports 443 and 80 reachable from the internet. Port 80 is only used by
  Let's Encrypt to prove you own the name. If the university issues the
  certificate instead, only 443 is needed; both Caddyfiles show where the
  certificate goes;
* the study key pair ([Keys](#keys)) and the participant-code file
  ([Participant codes](#participant-codes)).

Both options below put Caddy in front of the Node server. Caddy terminates
HTTPS and renews the certificate itself. Choose A if Docker is available or
allowed on the machine; it is one command to run and one to update. Choose B
otherwise.

### Option A: Docker Compose

```bash
# Docker Engine with the Compose plugin
sudo apt install docker.io docker-compose-v2      # Ubuntu 24.04; otherwise see docs.docker.com/engine/install
sudo usermod -aG docker "$USER" && newgrp docker

git clone https://github.com/ActivitySpaceLab/wellbeing-mapper-server.git
cd wellbeing-mapper-server
cp .env.template .env            # defaults are fine; see the comments to tune limits
nano Caddyfile                   # your host name and an email for certificate notices
mkdir -p data
cp /path/to/participant_codes.json data/

docker compose up -d --build
docker compose ps                # both services "running", app "healthy" after ~10 s
docker compose logs app          # "Participant codes: N loaded from /data/participant_codes.json"
```

Then, from any computer, `scripts/check-deployment.sh https://your-host`.

Submissions are in `data/received/`, the code file in `data/`; both are on
the host, so `docker compose up -d --build` after a `git pull` updates the
server without touching them. The code file is read at start:
`docker compose restart app` after replacing it.

### Option B: systemd, without Docker

```bash
# Node 20 or newer and Caddy
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# A service user, the code, and the data directory
sudo useradd -r -s /usr/sbin/nologin wellbeing
sudo git clone https://github.com/ActivitySpaceLab/wellbeing-mapper-server.git /opt/wellbeing-mapper-server
cd /opt/wellbeing-mapper-server && sudo npm ci --omit=dev
sudo mkdir -p /var/lib/wellbeing-mapper/received
sudo cp /path/to/participant_codes.json /var/lib/wellbeing-mapper/
sudo chown -R wellbeing:wellbeing /var/lib/wellbeing-mapper

# The service
sudo cp deploy/systemd/wellbeing-mapper-server.env /etc/wellbeing-mapper-server.env
sudo chmod 640 /etc/wellbeing-mapper-server.env
sudo cp deploy/systemd/wellbeing-mapper-server.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now wellbeing-mapper-server
systemctl status wellbeing-mapper-server

# HTTPS
sudo cp deploy/systemd/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile    # your host name and email
sudo systemctl reload caddy
```

Then `scripts/check-deployment.sh https://your-host`. To update:
`cd /opt/wellbeing-mapper-server && sudo git pull && sudo npm ci --omit=dev && sudo systemctl restart wellbeing-mapper-server`.
After replacing the code file: `sudo systemctl restart wellbeing-mapper-server`.

### Point the app at it

The app is built with the server's URL (and carries the study's public key,
see [Keys](#keys)):

```bash
fvm flutter build apk --flavor production --dart-define=APP_FLAVOR=production \
  --dart-define=SERVER_BASE_URL=https://your-host/api/v1
fvm flutter build ipa --flavor production --dart-define=APP_FLAVOR=production \
  --dart-define=SERVER_BASE_URL=https://your-host/api/v1
```

A build without `SERVER_BASE_URL` never uploads anything and cannot unlock
research mode with a real code, which is what you want for test builds.

## Keys

Every submission is encrypted with the study's RSA public key, which is
compiled into the app. Only the matching private key can decrypt the data.
The app ships with a placeholder key: generate the study's own pair before
collecting data, and never reuse the placeholder.

```bash
openssl genrsa -out wellbeing_private_key.pem 4096
openssl rsa -in wellbeing_private_key.pem -pubout -out wellbeing_public_key.pem
```

* Paste the contents of `wellbeing_public_key.pem` into `ENV.researchPublicKey`
  in the app's `lib/util/env.dart` and rebuild the app.
* Keep `wellbeing_private_key.pem` offline, in a password manager or the
  university's secrets vault, with a copy somewhere safe: if it is lost, the
  collected data can never be read. It is used only by
  `tools/decrypt_received.py` on the research team's computers. It must
  never be copied to the server or committed to git (`*.pem` is ignored).
* If the private key leaks, generate a new pair and ship a new app version.
  Data already encrypted with the old key still needs the old private key.

## Participant codes

Each participant gets a code that unlocks research mode in the app. Codes
are five random characters from an alphabet without look-alikes (no 0/O,
1/I/L), case-insensitive, and the server only ever sees their SHA-256 hashes.

```bash
python3 generate_participant_codes.py --count 500           # study codes
python3 generate_participant_codes.py --count 20 --type pilot   # adds pilot codes to the same file
```

This writes `participant_codes.json`, which holds only hashes and goes on
the server (`data/` for Docker, `/var/lib/wellbeing-mapper/` for systemd;
the server reads it at start), and `participant_codes_<type>_<date>.csv`,
which holds the codes to hand out. Keep the CSV private and off the server.
Running the generator again extends the existing file. Both files are
gitignored.

The app also accepts a few fixed test codes (`TESTER`, …) when it is built
without a server URL or in debug mode. They are not in the server's file
unless you pass `--with-test-codes`; leave them out of the production file,
or anyone who knows them can unlock research mode in the released app.

## Backups

The data directory is the whole state of the server. `scripts/backup.sh`
writes a dated `tar.gz` of it and deletes archives older than 90 days:

```bash
# Docker deployment, daily at 03:15, keeping archives for 90 days (crontab -e)
15 3 * * * /home/you/wellbeing-mapper-server/scripts/backup.sh /home/you/wellbeing-mapper-server/data /var/backups/wellbeing-mapper 90
# systemd deployment
15 3 * * * /opt/wellbeing-mapper-server/scripts/backup.sh /var/lib/wellbeing-mapper /var/backups/wellbeing-mapper 90
```

Copy the archives to another machine regularly (`rsync`, or the university's
backup service). They contain only encrypted submissions and code hashes, so
they can be stored anywhere.

## Day-to-day operation

* **Logs**: `docker compose logs -f app`, or `journalctl -u wellbeing-mapper-server -f`.
  One line per request with status and duration; stored submissions are
  logged with their file name. Bodies and client addresses are never logged.
* **How much has arrived**: `ls data/received | wc -l`. File names start
  with the time received and include the category and survey type.
* **Disk**: uploads are refused with 507 when the volume has less than
  `MIN_FREE_MB` (500 MB) free, and the app retries later. Check `df -h`
  occasionally; a biweekly survey is a few hundred KB to a few MB.
* **Rate limits**: 60 code checks and 300 uploads per address per 10 minutes
  (`RATE_LIMIT_*` in `.env`). Participants on one campus network share an
  address, so the limits are generous; raise them for group onboarding
  sessions if 429s appear in the log.
* **Certificate**: Caddy renews it automatically. `docker compose logs caddy`
  or `journalctl -u caddy` if HTTPS stops working.
* **Update**: `git pull`, then `docker compose up -d --build` or the systemd
  update line above.

Configuration reference: `.env.template`.

## Decrypting the data

On a research team computer with the private key, copy the received files
and decrypt them:

```bash
rsync -av you@your-host:wellbeing-mapper-server/data/received/ ./received/
pip install cryptography
python3 tools/decrypt_received.py --key wellbeing_private_key.pem --out decrypted/ received/
```

For each stored file this writes `<name>.decrypted.json` with the server's
metadata (`received_at`, `survey_type`, `submission_id`, …) and the
`plaintext` the app encrypted: the survey answers, the participant's UUID,
and, for biweekly surveys, the location history the participant chose to
share. Files that cannot be decrypted (a different key, a damaged file) are
listed on stderr and the exit status is 1. A passphrase-protected key is
unlocked with `--passphrase-env NAME` or a prompt.

## Development and tests

Needs Node 20 or newer.

```bash
npm install
npm test          # unit and end-to-end tests against the app object (node:test)
npm run smoke     # starts the server on port 3001 and drives it with real encryption
scripts/dev.sh    # local server with restarts on change; storage in ./received
```

The tests include decrypting stored submissions with `tools/decrypt_received.py`
when `python3` has the `cryptography` package (`PYTHON=/path/to/python npm test`
to pick an interpreter). To run the app against a local server, see the
app's `docs/CONTRIBUTOR_SETUP.md`: `scripts/run-with-local-server.sh` there
builds it with `SERVER_BASE_URL=http://localhost:3000/api/v1`.

## Security notes

* Submissions are readable only with the private key, which is never on the
  server. Participant codes are stored as hashes only.
* Each submission is written atomically (temporary file, then rename), so a
  crash never leaves a half-written file. Storage stops at `MIN_FREE_MB`
  free so the disk cannot fill completely.
* Requests are validated (JSON, package shape, size limit, survey type) and
  rate limited per address; HTTP headers are hardened by helmet and Caddy
  (HSTS). Logs contain no bodies and no addresses.
* The upload endpoints are unauthenticated by design: the app has no secret
  that a phone could keep. Anyone can therefore submit a well-formed package.
  Such submissions decrypt to junk and are easy to discard; the size limit,
  rate limit and free-space guard bound what they can cost.
* The code check can be used to guess codes. With five-character codes
  there are 28 million possibilities; at 60 guesses per address per 10
  minutes, guessing a valid code takes weeks per address, and a guessed
  code only lets someone submit data under it.
* Keep the VPS itself updated (`unattended-upgrades`) and reachable only
  on 22, 80 and 443.
