#!/usr/bin/env python3
"""
Participant Code Generator for Gauteng Wellbeing Mapping Study
Generates secure participant codes and their corresponding SHA-256 hashes

Usage:
    python3 generate_participant_codes.py --count 500 --prefix P4H --start 1
    python3 generate_participant_codes.py --pilot-codes --count 10
    python3 generate_participant_codes.py --verify-existing
"""

import argparse
import json
import hashlib
import os
import csv
from datetime import datetime
from typing import List, Dict, Set

def hash_code(code: str) -> str:
    """Generate SHA-256 hash of participant code (matches app implementation)"""
    return hashlib.sha256(code.strip().upper().encode()).hexdigest()

def generate_study_codes(prefix: str, start: int, count: int) -> List[str]:
    """Generate sequential study codes with zero-padding"""
    codes = []
    for i in range(start, start + count):
        code = f"{prefix}{i:03d}"  # Zero-padded to 3 digits
        codes.append(code)
    return codes

def generate_pilot_codes(prefix: str, count: int) -> List[str]:
    """Generate pilot codes with P suffix"""
    codes = []
    for i in range(1, count + 1):
        code = f"{prefix}{i}P"
        codes.append(code)
    return codes

def verify_codes_against_existing(codes: List[str], existing_file: str) -> Dict[str, any]:
    """Verify codes against existing database"""
    if not os.path.exists(existing_file):
        return {"status": "no_existing_file", "conflicts": []}
    
    try:
        with open(existing_file, 'r') as f:
            existing_data = json.load(f)
        
        existing_codes = set()
        existing_codes.update(existing_data.get('pilot_codes', []))
        existing_codes.update(existing_data.get('study_codes', []))
        existing_codes.update(existing_data.get('test_codes', []))
        
        conflicts = [code for code in codes if code in existing_codes]
        
        return {
            "status": "verified",
            "existing_total": len(existing_codes),
            "new_codes": len(codes),
            "conflicts": conflicts
        }
    except Exception as e:
        return {"status": "error", "error": str(e), "conflicts": []}

def save_codes_database(codes_data: Dict, output_file: str) -> bool:
    """Save codes to JSON database"""
    try:
        with open(output_file, 'w') as f:
            json.dump(codes_data, f, indent=2)
        return True
    except Exception as e:
        print(f"❌ Error saving database: {e}")
        return False

def save_codes_csv(codes: List[str], output_file: str) -> bool:
    """Save codes to CSV for easy distribution"""
    try:
        with open(output_file, 'w', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(['Code', 'SHA256_Hash'])
            for code in codes:
                writer.writerow([code, hash_code(code)])
        return True
    except Exception as e:
        print(f"❌ Error saving CSV: {e}")
        return False

def print_codes_summary(codes_data: Dict):
    """Print summary of generated codes"""
    print("\n" + "="*60)
    print("📋 PARTICIPANT CODES SUMMARY")
    print("="*60)
    print(f"📅 Generated: {codes_data['meta']['created']}")
    print(f"📊 Total Codes: {codes_data['meta']['totalCodes']}")
    print(f"🧪 Pilot Codes: {len(codes_data.get('pilot_codes', []))}")
    print(f"📚 Study Codes: {len(codes_data.get('study_codes', []))}")
    print(f"🔧 Test Codes: {len(codes_data.get('test_codes', []))}")
    
    if codes_data.get('pilot_codes'):
        print(f"\n🧪 Pilot Codes: {', '.join(codes_data['pilot_codes'][:5])}{'...' if len(codes_data['pilot_codes']) > 5 else ''}")
    
    if codes_data.get('study_codes'):
        print(f"📚 Study Codes: {codes_data['study_codes'][0]} to {codes_data['study_codes'][-1]}")
    
    print("\n🔒 Security Features:")
    print("  • Codes are hashed with SHA-256 before validation")
    print("  • Server never receives plaintext codes")
    print("  • Each code is cryptographically unique")
    
    print("\n📦 Distribution Options:")
    print("  • Upload participant_codes.json to proxy server")
    print("  • Use CSV file for participant handouts")
    print("  • QR codes can be generated from CSV data")
    print("="*60)

def main():
    parser = argparse.ArgumentParser(description='Generate participant codes for Gauteng Wellbeing Study')
    parser.add_argument('--count', type=int, default=500, help='Number of codes to generate')
    parser.add_argument('--prefix', type=str, default='P4H', help='Code prefix')
    parser.add_argument('--start', type=int, default=1, help='Starting number for sequential codes')
    parser.add_argument('--pilot-codes', action='store_true', help='Generate pilot codes with P suffix')
    parser.add_argument('--verify-existing', action='store_true', help='Verify against existing codes file')
    parser.add_argument('--output-dir', type=str, default='.', help='Output directory')
    parser.add_argument('--existing-file', type=str, default='participant_codes.json', help='Existing codes file to check against')
    
    args = parser.parse_args()
    
    print("🚀 Gauteng Wellbeing Study - Participant Code Generator")
    print(f"📅 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    
    # Generate codes based on type
    if args.pilot_codes:
        print(f"\n🧪 Generating {args.count} pilot codes...")
        new_codes = generate_pilot_codes(args.prefix, args.count)
        code_type = "pilot"
    else:
        print(f"\n📚 Generating {args.count} study codes...")
        new_codes = generate_study_codes(args.prefix, args.start, args.count)
        code_type = "study"
    
    print(f"✅ Generated {len(new_codes)} codes")
    
    # Verify against existing if requested
    if args.verify_existing:
        print(f"\n🔍 Verifying against existing file: {args.existing_file}")
        verification = verify_codes_against_existing(new_codes, args.existing_file)
        
        if verification["status"] == "verified":
            print(f"📊 Existing codes: {verification['existing_total']}")
            print(f"🆕 New codes: {verification['new_codes']}")
            if verification["conflicts"]:
                print(f"⚠️  Conflicts found: {len(verification['conflicts'])}")
                print(f"   Conflicting codes: {', '.join(verification['conflicts'][:5])}{'...' if len(verification['conflicts']) > 5 else ''}")
                print("❌ Cannot proceed with conflicting codes")
                return
            else:
                print("✅ No conflicts found")
        elif verification["status"] == "no_existing_file":
            print("ℹ️  No existing file found - will create new database")
        else:
            print(f"❌ Verification error: {verification.get('error', 'Unknown error')}")
            return
    
    # Load existing data if available
    existing_data = {}
    if os.path.exists(args.existing_file):
        try:
            with open(args.existing_file, 'r') as f:
                existing_data = json.load(f)
            print(f"📁 Loaded existing data from {args.existing_file}")
        except Exception as e:
            print(f"⚠️  Could not load existing file: {e}")
    
    # Create codes database structure
    codes_data = {
        "meta": {
            "version": "1.0.0",
            "created": datetime.now().isoformat() + "Z",
            "description": "Participant codes for Gauteng Wellbeing Mapping Study",
            "generator_version": "1.0.0"
        },
        "pilot_codes": existing_data.get("pilot_codes", []),
        "study_codes": existing_data.get("study_codes", []),
        "test_codes": existing_data.get("test_codes", ["TESTER", "TEST123", "DEV001"])
    }
    
    # Add new codes to appropriate category
    if code_type == "pilot":
        codes_data["pilot_codes"].extend(new_codes)
        codes_data["pilot_codes"] = sorted(list(set(codes_data["pilot_codes"])))  # Remove duplicates and sort
    else:
        codes_data["study_codes"].extend(new_codes)
        codes_data["study_codes"] = sorted(list(set(codes_data["study_codes"])))  # Remove duplicates and sort
    
    # Calculate total
    total_codes = len(codes_data["pilot_codes"]) + len(codes_data["study_codes"]) + len(codes_data["test_codes"])
    codes_data["meta"]["totalCodes"] = total_codes
    
    # Save files
    output_json = os.path.join(args.output_dir, "participant_codes.json")
    output_csv = os.path.join(args.output_dir, f"participant_codes_{code_type}_{datetime.now().strftime('%Y%m%d')}.csv")
    
    print(f"\n💾 Saving codes database...")
    if save_codes_database(codes_data, output_json):
        print(f"✅ Database saved: {output_json}")
    
    print(f"💾 Saving CSV for distribution...")
    if save_codes_csv(new_codes, output_csv):
        print(f"✅ CSV saved: {output_csv}")
    
    # Print summary
    print_codes_summary(codes_data)
    
    # Print first few codes and hashes for verification
    print(f"\n🔍 Sample {code_type} codes and hashes:")
    for i, code in enumerate(new_codes[:3]):
        print(f"  {code} → {hash_code(code)}")
    
    if len(new_codes) > 3:
        print(f"  ... and {len(new_codes) - 3} more")
    
    print(f"\n🎯 Next Steps:")
    print(f"  1. Upload {output_json} to your proxy server")
    print(f"  2. Use {output_csv} to create participant handouts")
    print(f"  3. Test validation with a few codes")
    print(f"  4. Deploy updated proxy server")

if __name__ == "__main__":
    main()