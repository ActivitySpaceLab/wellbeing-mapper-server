#!/usr/bin/env python3
"""Decrypts submissions stored by the Wellbeing Mapper server.

The server writes one JSON file per submission into its storage directory
(`received/`). This tool decrypts them with the study's RSA private key, which
must never be on the server, and writes one plaintext JSON file per
submission.

Usage:
    decrypt_received.py --key private_key.pem --out decrypted/ received/
    decrypt_received.py --key private_key.pem --stdout received/2026-...json

A passphrase-protected key is unlocked with --passphrase-env NAME (the name
of an environment variable holding the passphrase) or, failing that, a
prompt. Files that fail to decrypt are reported and skipped; the exit status
is 1 if any failed.

Requires the `cryptography` package (pip install cryptography).

Encryption scheme (ResearchServerService._encrypt in the app): the payload is
AES-256-GCM encrypted with a random key and a 16-byte IV, the GCM tag is
appended to the ciphertext, and the key is wrapped with RSA-OAEP-SHA-256.
The RSA plaintext is the base64 *text* of the AES key, so it is base64-decoded
after unwrapping. The whole package is a base64-encoded JSON object.
"""

import argparse
import base64
import getpass
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:  # pragma: no cover - reported to the user below
    sys.exit("This tool needs the 'cryptography' package: pip install cryptography")

EXPECTED_ALGORITHM = "AES-256-GCM+RSA-OAEP-SHA256"


def load_private_key(path: Path, passphrase: Optional[str]):
    pem = path.read_bytes()
    password = passphrase.encode() if passphrase else None
    try:
        return serialization.load_pem_private_key(pem, password=password)
    except TypeError:
        # The key is encrypted and no passphrase was given.
        password = getpass.getpass(f"Passphrase for {path}: ").encode()
        return serialization.load_pem_private_key(pem, password=password)


def decode_package(encrypted_data: str) -> Dict[str, Any]:
    """The JSON envelope inside `encrypted_data` (base64, or bare JSON)."""
    text = encrypted_data.strip()
    if text.startswith("{"):
        return json.loads(text)
    return json.loads(base64.b64decode(text).decode("utf-8"))


def decrypt_package(private_key, encrypted_data: str) -> Any:
    """Returns the decrypted payload (parsed JSON) of one `encrypted_data`."""
    package = decode_package(encrypted_data)
    algorithm = package.get("algorithm")
    if algorithm != EXPECTED_ALGORITHM:
        raise ValueError(f"unsupported algorithm {algorithm!r} (expected {EXPECTED_ALGORITHM})")
    key_text = private_key.decrypt(
        base64.b64decode(package["encryptedKey"]),
        padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
    )
    aes_key = base64.b64decode(key_text)
    if len(aes_key) != 32:
        raise ValueError(f"unwrapped AES key has {len(aes_key)} bytes, expected 32")
    plaintext = AESGCM(aes_key).decrypt(
        base64.b64decode(package["iv"]),
        base64.b64decode(package["encryptedData"]),  # ciphertext + 16-byte GCM tag
        None,
    )
    return json.loads(plaintext.decode("utf-8"))


def decrypt_file(private_key, path: Path) -> Dict[str, Any]:
    """Decrypts one stored submission (or a bare request body) from `path`."""
    stored = json.loads(path.read_text(encoding="utf-8"))
    body = stored.get("payload", stored)
    if "encrypted_data" not in body:
        raise ValueError("no encrypted_data in file")
    result = {
        key: stored.get(key)
        for key in ("received_at", "category", "survey_type", "submission_id", "client_timestamp")
    }
    result["source_file"] = path.name
    result["plaintext"] = decrypt_package(private_key, body["encrypted_data"])
    return result


def input_files(paths):
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            yield from sorted(f for f in p.iterdir() if f.suffix == ".json" and not f.name.startswith("."))
        else:
            yield p


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("paths", nargs="+", help="stored submission files or directories of them")
    parser.add_argument("--key", required=True, type=Path, help="RSA private key (PEM)")
    parser.add_argument("--passphrase-env", metavar="NAME", help="environment variable holding the key passphrase")
    output = parser.add_mutually_exclusive_group(required=True)
    output.add_argument("--out", type=Path, help="directory for the decrypted files")
    output.add_argument("--stdout", action="store_true", help="print decrypted submissions instead")
    args = parser.parse_args()

    passphrase = os.environ.get(args.passphrase_env) if args.passphrase_env else None
    private_key = load_private_key(args.key, passphrase)
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)

    decrypted = failed = 0
    for path in input_files(args.paths):
        try:
            result = decrypt_file(private_key, path)
        except Exception as error:  # noqa: BLE001 - report and carry on
            failed += 1
            print(f"FAILED {path}: {error}", file=sys.stderr)
            continue
        decrypted += 1
        if args.stdout:
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            target = args.out / f"{path.stem}.decrypted.json"
            target.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"decrypted {decrypted}, failed {failed}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
