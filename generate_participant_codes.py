#!/usr/bin/env python3
"""
Participant code generator for the Wellbeing Mapper study.

Writes two files:

  participant_codes.json   Only SHA-256 hashes of the codes. This is the file
                           the server loads (PARTICIPANT_CODES_FILE). A copy
                           of it, or of the server, reveals no code.
  participant_codes_<type>_<date>.csv
                           The codes themselves, one per participant, to hand
                           out. Keep this file private and off the server.

Codes are short, random, and drawn from an alphabet with no 0/O or 1/I/L
confusion and no special characters, so they are easy to read out and type
but hard to guess. The app uppercases input before hashing, so codes are
case-insensitive.

Examples:
    # 500 study codes, 5 characters each (recommended default)
    python3 generate_participant_codes.py --count 500

    # 20 pilot codes into the same database (the study codes are kept)
    python3 generate_participant_codes.py --count 20 --type pilot

    # A human-readable prefix, e.g. IT-AB3KP
    python3 generate_participant_codes.py --count 500 --prefix IT-

    # 6-character codes for extra guess-resistance
    python3 generate_participant_codes.py --count 1000 --length 6

Test codes (TESTER, TEST123, DEV001) are only added with --with-test-codes.
The app accepts them offline in debug builds; putting them in the server's
file would let anyone who knows them unlock research mode in the released
app, so leave them out of the production database.
"""

import argparse
import csv
import hashlib
import json
import os
import secrets
import sys
from datetime import datetime, timezone
from typing import Dict, List, Set

# Digits 2-9 and letters A-Z without I, L, O: 31 unambiguous characters.
ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
TYPES = ("pilot", "study", "test")
TEST_CODES = ["TESTER", "TEST123", "DEV001"]


def hash_code(code: str) -> str:
    """SHA-256 of the code, trimmed and uppercased (as the app and server do)."""
    return hashlib.sha256(code.strip().upper().encode()).hexdigest()


def generate_codes(count: int, length: int, prefix: str, taken_hashes: Set[str]) -> List[str]:
    """`count` unique random codes whose hashes are not in `taken_hashes`."""
    keyspace = len(ALPHABET) ** length
    if count > keyspace // 2:
        raise ValueError(
            f"{count} codes of length {length} would use more than half of the "
            f"{keyspace:,} possible codes; increase --length"
        )
    codes: List[str] = []
    seen = set(taken_hashes)
    while len(codes) < count:
        code = prefix + "".join(secrets.choice(ALPHABET) for _ in range(length))
        digest = hash_code(code)
        if digest in seen:
            continue
        seen.add(digest)
        codes.append(code)
    return codes


def existing_hashes(data: Dict, code_type: str) -> List[str]:
    """Hashes already in the database for a type; plain codes from older
    generator versions are hashed."""
    hashes = list(data.get(f"{code_type}_hashes", []))
    hashes += [hash_code(code) for code in data.get(f"{code_type}_codes", [])]
    return sorted(set(hashes))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate random participant codes for the Wellbeing Mapper study",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Examples:")[1],
    )
    parser.add_argument("--count", type=int, default=500, help="codes to generate (default 500)")
    parser.add_argument("--length", type=int, default=5, help="random characters per code (default 5)")
    parser.add_argument("--prefix", default="", help="fixed prefix, e.g. IT- (default none)")
    parser.add_argument("--type", choices=TYPES, default="study", help="which list the codes go into")
    parser.add_argument("--with-test-codes", action="store_true",
                        help=f"also accept the debug test codes {', '.join(TEST_CODES)}")
    parser.add_argument("--output-dir", default=".", help="where to write the files (default: here)")
    args = parser.parse_args()
    if args.count < 1 or args.length < 3:
        parser.error("--count must be at least 1 and --length at least 3")

    json_path = os.path.join(args.output_dir, "participant_codes.json")
    existing: Dict = {}
    if os.path.exists(json_path):
        with open(json_path, encoding="utf-8") as f:
            existing = json.load(f)
        print(f"Extending {json_path}")

    hashes = {t: existing_hashes(existing, t) for t in TYPES}
    if args.with_test_codes:
        hashes["test"] = sorted(set(hashes["test"]) | {hash_code(c) for c in TEST_CODES})
    taken = {h for hs in hashes.values() for h in hs}

    try:
        new_codes = generate_codes(args.count, args.length, args.prefix, taken)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    hashes[args.type] = sorted(set(hashes[args.type]) | {hash_code(c) for c in new_codes})

    database = {
        "meta": {
            "version": "3.0.0",
            "created": datetime.now(timezone.utc).isoformat(),
            "description": "SHA-256 hashes of Wellbeing Mapper participant codes; the codes are not in this file",
            "code_length": args.length,
            "alphabet": ALPHABET,
            "totalCodes": sum(len(hs) for hs in hashes.values()),
        },
        **{f"{t}_hashes": hashes[t] for t in TYPES},
    }
    os.makedirs(args.output_dir, exist_ok=True)
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(database, f, indent=2)

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    csv_path = os.path.join(args.output_dir, f"participant_codes_{args.type}_{stamp}.csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["code", "sha256"])
        for code in new_codes:
            writer.writerow([code, hash_code(code)])

    keyspace = len(ALPHABET) ** args.length
    print(f"Generated {len(new_codes)} {args.type} codes of {args.length} characters"
          f" (prefix {args.prefix!r}); {keyspace:,} possible codes, so a random guess"
          f" hits a valid code with probability {database['meta']['totalCodes'] / keyspace:.1e}")
    print(f"  hashes (for the server): {json_path}  "
          f"[pilot {len(hashes['pilot'])}, study {len(hashes['study'])}, test {len(hashes['test'])}]")
    print(f"  codes (keep private):    {csv_path}")
    print("Sample:", ", ".join(new_codes[:3]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
