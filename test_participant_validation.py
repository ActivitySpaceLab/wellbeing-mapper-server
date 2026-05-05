#!/usr/bin/env python3
"""
Test script for participant code validation endpoint
Tests the proxy server participant validation functionality
"""

import requests
import json
import hashlib
from datetime import datetime

def hash_code(code: str) -> str:
    """Generate SHA-256 hash of participant code (matches app implementation)"""
    return hashlib.sha256(code.strip().upper().encode()).hexdigest()

def test_participant_validation(server_url: str = "http://localhost:3000"):
    """Test participant code validation endpoint"""
    
    print("🧪 Testing Participant Code Validation Endpoint")
    print(f"🌐 Server: {server_url}")
    print("="*60)
    
    # Test cases
    test_cases = [
        {
            "name": "Valid Pilot Code P4H1P",
            "code": "P4H1P",
            "should_pass": True
        },
        {
            "name": "Valid Test Code TESTER",
            "code": "TESTER",
            "should_pass": True
        },
        {
            "name": "Valid Study Code P4H001",
            "code": "P4H001",
            "should_pass": True
        },
        {
            "name": "Invalid Code INVALID",
            "code": "INVALID",
            "should_pass": False
        },
        {
            "name": "Empty Code",
            "code": "",
            "should_pass": False
        }
    ]
    
    # Test health endpoint first
    print("1️⃣ Testing health endpoint...")
    try:
        response = requests.get(f"{server_url}/health", timeout=5)
        if response.status_code == 200:
            health_data = response.json()
            print(f"✅ Server healthy: {health_data.get('status')}")
            print(f"📊 Participant codes loaded: {health_data.get('participant_codes_loaded')}")
            print(f"🔢 Total codes: {health_data.get('total_codes')}")
        else:
            print(f"❌ Health check failed: {response.status_code}")
            return
    except Exception as e:
        print(f"❌ Cannot reach server: {e}")
        return
    
    print(f"\n2️⃣ Testing participant validation endpoint...")
    
    # Test each case
    for i, test_case in enumerate(test_cases, 1):
        print(f"\n🧪 Test {i}: {test_case['name']}")
        
        if test_case['code']:
            # Hash the code
            hashed_code = hash_code(test_case['code'])
            print(f"📝 Code: {test_case['code']}")
            print(f"🔐 Hash: {hashed_code[:16]}...")
            
            # Prepare request
            payload = {
                "hashed_code": hashed_code,
                "timestamp": datetime.now().isoformat()
            }
        else:
            # Test with missing/invalid data
            payload = {
                "timestamp": datetime.now().isoformat()
            }
        
        try:
            response = requests.post(
                f"{server_url}/api/v1/participants/validate",
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=5
            )
            
            if response.status_code == 200:
                result = response.json()
                is_valid = result.get('valid', False)
                code_type = result.get('code_type')
                
                if is_valid == test_case['should_pass']:
                    print(f"✅ Result: {'Valid' if is_valid else 'Invalid'} ({code_type or 'N/A'})")
                else:
                    print(f"❌ Unexpected result: {'Valid' if is_valid else 'Invalid'} (expected: {'Valid' if test_case['should_pass'] else 'Invalid'})")
            else:
                result = response.json() if response.headers.get('content-type', '').startswith('application/json') else {'error': response.text}
                if test_case['should_pass']:
                    print(f"❌ Request failed: {response.status_code} - {result.get('error', 'Unknown error')}")
                else:
                    print(f"✅ Expected failure: {response.status_code} - {result.get('error', 'Unknown error')}")
                    
        except Exception as e:
            print(f"❌ Request error: {e}")
    
    # Test stats endpoint
    print(f"\n3️⃣ Testing stats endpoint...")
    try:
        response = requests.get(f"{server_url}/api/v1/participants/stats", timeout=5)
        if response.status_code == 200:
            stats = response.json()
            print(f"✅ Stats retrieved successfully:")
            print(f"   📊 Total codes: {stats.get('total_codes')}")
            print(f"   🧪 Pilot codes: {stats.get('pilot_codes')}")
            print(f"   📚 Study codes: {stats.get('study_codes')}")
            print(f"   🔧 Test codes: {stats.get('test_codes')}")
            print(f"   📅 Database version: {stats.get('database_version')}")
        else:
            print(f"❌ Stats request failed: {response.status_code}")
    except Exception as e:
        print(f"❌ Stats request error: {e}")
    
    print("\n" + "="*60)
    print("🎯 Test Summary:")
    print("✅ If all tests passed, the participant validation system is working")
    print("📱 The mobile app can now use this endpoint for validation")
    print("🔄 Next step: Update the Flutter app to use the API")
    print("="*60)

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Test participant validation endpoint')
    parser.add_argument('--server', type=str, default='http://localhost:3000', help='Server URL')
    args = parser.parse_args()
    
    test_participant_validation(args.server)