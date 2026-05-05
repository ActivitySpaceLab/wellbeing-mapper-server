#!/usr/bin/env python3
"""
Test script to verify Flutter API integration with the participant validation server.
This simulates the HTTP calls that the Flutter app will make to the server.
"""

import requests
import json
import hashlib

def hash_participant_code(code):
    """Hash a participant code using SHA-256"""
    return hashlib.sha256(code.encode('utf-8')).hexdigest()

def test_flutter_validation_flow():
    """Test the complete validation flow that Flutter will use"""
    base_url = "http://localhost:3000"
    validate_endpoint = "/api/v1/participants/validate"
    
    print("🧪 Testing Flutter API Integration Flow")
    print("=" * 50)
    
    # Test cases that Flutter will encounter
    test_cases = [
        {"code": "P4H1P", "expected": True, "type": "pilot"},
        {"code": "P4H001", "expected": True, "type": "study"},
        {"code": "TEST1", "expected": True, "type": "test"},
        {"code": "INVALID", "expected": False, "type": "invalid"},
        {"code": "", "expected": False, "type": "empty"},
    ]
    
    for i, test in enumerate(test_cases, 1):
        print(f"\n{i}. Testing {test['type']} code: '{test['code']}'")
        
        if test['code']:
            hashed_code = hash_participant_code(test['code'].upper())
            print(f"   Hashed: {hashed_code[:16]}...")
        else:
            # Flutter will skip hashing for empty codes
            print("   Skipping validation for empty code")
            continue
        
        try:
            # This is exactly what Flutter will send
            payload = {
                'hashed_code': hashed_code,
                'timestamp': '2025-09-17T05:32:33.000Z'
            }
            
            response = requests.post(
                f"{base_url}{validate_endpoint}",
                headers={
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                json=payload,
                timeout=10
            )
            
            print(f"   Status: {response.status_code}")
            
            if response.status_code == 200:
                data = response.json()
                is_valid = data.get('valid', False)
                code_type = data.get('code_type', 'unknown')
                
                print(f"   Valid: {is_valid}")
                print(f"   Type: {code_type}")
                
                if is_valid == test['expected']:
                    print("   ✅ PASS - Validation result matches expected")
                else:
                    print("   ❌ FAIL - Validation result doesn't match expected")
            else:
                print(f"   Response: {response.text}")
                if test['expected']:
                    print("   ❌ FAIL - Expected valid code but got error")
                else:
                    print("   ✅ PASS - Expected invalid code and got error")
                    
        except requests.RequestException as e:
            print(f"   ❌ NETWORK ERROR: {e}")
            print("   This would trigger Flutter fallback validation")

def test_server_health():
    """Test server health endpoint"""
    print("\n🏥 Testing Server Health")
    print("=" * 30)
    
    try:
        response = requests.get("http://localhost:3000/health", timeout=5)
        print(f"Status: {response.status_code}")
        
        if response.status_code == 200:
            data = response.json()
            print(f"Codes loaded: {data.get('codes_loaded', 'unknown')}")
            print("✅ Server is healthy")
        else:
            print("❌ Server health check failed")
            
    except requests.RequestException as e:
        print(f"❌ Health check failed: {e}")

def test_error_scenarios():
    """Test error scenarios that Flutter might encounter"""
    print("\n🚨 Testing Error Scenarios")
    print("=" * 35)
    
    base_url = "http://localhost:3000"
    validate_endpoint = "/api/v1/participants/validate"
    
    # Test malformed requests
    test_cases = [
        {
            "name": "Missing hashed_code",
            "payload": {"timestamp": "2025-09-17T05:32:33.000Z"},
            "expected_status": 400
        },
        {
            "name": "Invalid JSON structure",
            "payload": {"invalid": "structure"},
            "expected_status": 400
        },
        {
            "name": "Empty hashed_code",
            "payload": {"hashed_code": "", "timestamp": "2025-09-17T05:32:33.000Z"},
            "expected_status": 400
        }
    ]
    
    for test in test_cases:
        print(f"\nTesting: {test['name']}")
        
        try:
            response = requests.post(
                f"{base_url}{validate_endpoint}",
                headers={'Content-Type': 'application/json'},
                json=test['payload'],
                timeout=5
            )
            
            print(f"Status: {response.status_code}")
            if response.status_code == test['expected_status']:
                print("✅ PASS - Got expected error status")
            else:
                print(f"❌ FAIL - Expected {test['expected_status']}, got {response.status_code}")
                
        except requests.RequestException as e:
            print(f"❌ REQUEST ERROR: {e}")

if __name__ == "__main__":
    print("🔧 Flutter API Integration Test")
    print("Testing participant validation endpoints that Flutter will use")
    print("=" * 60)
    
    test_server_health()
    test_flutter_validation_flow()
    test_error_scenarios()
    
    print("\n" + "=" * 60)
    print("🎯 Integration Test Complete")
    print("If all tests pass, Flutter integration is ready!")