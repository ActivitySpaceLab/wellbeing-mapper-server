#!/usr/bin/env node

/**
 * Test script for the wellbeing mapper data collection server server
 * Tests both local and deployed instances
 * 
 * Usage:
 *   node test-server.js                    # Test localhost:3000
 *   node test-server.js http://localhost:8080  # Test custom URL
 *   node test-server.js https://your-server.example.com # Test deployed proxy
 */

const https = require('https');
const http = require('http');

// Test configuration
const SERVER_URL = process.argv[2] || 'http://localhost:3000';
const TEST_TIMEOUT = 10000; // 10 seconds

console.log(`🧪 Testing server at: ${SERVER_URL}`);
console.log('=' .repeat(60));

// Mock encrypted survey data for testing
const TEST_SURVEYS = {
  initial: {
    encrypted_data: 'MOCK_ENCRYPTED_INITIAL_SURVEY_DATA_' + Date.now(),
    survey_type: 'initial',
    timestamp: new Date().toISOString()
  },
  biweekly: {
    encrypted_data: 'MOCK_ENCRYPTED_BIWEEKLY_SURVEY_DATA_' + Date.now(),
    survey_type: 'biweekly', 
    timestamp: new Date().toISOString()
  },
  consent: {
    encrypted_data: 'MOCK_ENCRYPTED_CONSENT_SURVEY_DATA_' + Date.now(),
    survey_type: 'consent',
    timestamp: new Date().toISOString()
  }
};

// HTTP request helper
function makeRequest(url, options, data = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;
    
    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: TEST_TIMEOUT
    };
    
    const req = client.request(requestOptions, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseData);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: parsed
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: responseData
          });
        }
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    if (data) {
      req.write(data);
    }
    
    req.end();
  });
}

// Test 1: Health check
async function testHealthCheck() {
  console.log('🏥 Testing health check endpoint...');
  
  try {
    const response = await makeRequest(`${SERVER_URL}/health`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });
    
    if (response.statusCode === 200 && response.data.status === 'healthy') {
      console.log('✅ Health check passed');
      console.log(`   Status: ${response.data.status}`);
      console.log(`   Timestamp: ${response.data.timestamp}`);
      console.log(`   Version: ${response.data.version || 'N/A'}`);
      return true;
    } else {
      console.log('❌ Health check failed');
      console.log(`   Status Code: ${response.statusCode}`);
      console.log(`   Response: ${JSON.stringify(response.data, null, 2)}`);
      return false;
    }
  } catch (error) {
    console.log('❌ Health check error:', error.message);
    return false;
  }
}

// Test 2: Survey submission
async function testSurveySubmission(surveyType) {
  console.log(`📝 Testing ${surveyType} survey submission...`);
  
  const testData = TEST_SURVEYS[surveyType];
  const postData = JSON.stringify(testData);
  
  try {
    const response = await makeRequest(`${SERVER_URL}/api/v1/surveys/encrypted`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': postData.length,
        'Accept': 'application/json'
      }
    }, postData);
    
    if (response.statusCode === 200 && response.data.success) {
      console.log(`✅ ${surveyType} survey submission passed`);
      console.log(`   Success: ${response.data.success}`);
      console.log(`   Survey Type: ${response.data.survey_type}`);
      console.log(`   Message: ${response.data.message}`);
      return true;
    } else {
      console.log(`❌ ${surveyType} survey submission failed`);
      console.log(`   Status Code: ${response.statusCode}`);
      console.log(`   Response: ${JSON.stringify(response.data, null, 2)}`);
      return false;
    }
  } catch (error) {
    console.log(`❌ ${surveyType} survey submission error:`, error.message);
    return false;
  }
}

// Test 3: Invalid requests
async function testInvalidRequests() {
  console.log('🚫 Testing invalid request handling...');
  
  const tests = [
    {
      name: 'Missing encrypted_data',
      data: { survey_type: 'initial' }
    },
    {
      name: 'Missing survey_type',
      data: { encrypted_data: 'test' }
    },
    {
      name: 'Invalid survey_type',
      data: { encrypted_data: 'test', survey_type: 'invalid_type' }
    },
    {
      name: 'Empty request body',
      data: {}
    }
  ];
  
  let passed = 0;
  
  for (const test of tests) {
    try {
      const postData = JSON.stringify(test.data);
      const response = await makeRequest(`${SERVER_URL}/api/v1/surveys/encrypted`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': postData.length
        }
      }, postData);
      
      if (response.statusCode === 400) {
        console.log(`   ✅ ${test.name} - correctly rejected`);
        passed++;
      } else {
        console.log(`   ❌ ${test.name} - should have been rejected (got ${response.statusCode})`);
      }
    } catch (error) {
      console.log(`   ❌ ${test.name} - error: ${error.message}`);
    }
  }
  
  console.log(`📊 Invalid request tests: ${passed}/${tests.length} passed`);
  return passed === tests.length;
}

// Test 4: 404 handling
async function test404Handling() {
  console.log('🔍 Testing 404 handling...');
  
  try {
    const response = await makeRequest(`${SERVER_URL}/nonexistent`, {
      method: 'GET'
    });
    
    if (response.statusCode === 404) {
      console.log('✅ 404 handling passed');
      return true;
    } else {
      console.log(`❌ 404 handling failed - got ${response.statusCode}`);
      return false;
    }
  } catch (error) {
    console.log('❌ 404 test error:', error.message);
    return false;
  }
}

// Main test runner
async function runTests() {
  console.log(`🚀 Starting server tests\n`);
  
  const results = {
    healthCheck: false,
    initialSurvey: false,
    biweeklySurvey: false,
    consentSurvey: false,
    invalidRequests: false,
    notFound: false
  };
  
  // Run all tests
  results.healthCheck = await testHealthCheck();
  console.log();
  
  if (results.healthCheck) {
    results.initialSurvey = await testSurveySubmission('initial');
    console.log();
    
    results.biweeklySurvey = await testSurveySubmission('biweekly');
    console.log();
    
    results.consentSurvey = await testSurveySubmission('consent');
    console.log();
  } else {
    console.log('⚠️ Skipping survey tests - health check failed\n');
  }
  
  results.invalidRequests = await testInvalidRequests();
  console.log();
  
  results.notFound = await test404Handling();
  console.log();
  
  // Summary
  const passed = Object.values(results).filter(Boolean).length;
  const total = Object.keys(results).length;
  
  console.log('=' .repeat(60));
  console.log('📊 TEST SUMMARY');
  console.log('=' .repeat(60));
  console.log(`Health Check:      ${results.healthCheck ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Initial Survey:    ${results.initialSurvey ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Biweekly Survey:   ${results.biweeklySurvey ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Consent Survey:    ${results.consentSurvey ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Invalid Requests:  ${results.invalidRequests ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`404 Handling:      ${results.notFound ? '✅ PASS' : '❌ FAIL'}`);
  console.log('-'.repeat(60));
  console.log(`Overall: ${passed}/${total} tests passed`);
  
  if (passed === total) {
    console.log('🎉 All tests passed! Proxy server is working correctly.');
    process.exit(0);
  } else {
    console.log('❌ Some tests failed. Please check the server server configuration.');
    process.exit(1);
  }
}

// Handle command line help
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Encrypted Survey Proxy Test Suite');
  console.log('');
  console.log('Usage:');
  console.log('  node test-server.js [URL]');
  console.log('');
  console.log('Examples:');
  console.log('  node test-server.js                           # Test localhost:3000');
  console.log('  node test-server.js http://localhost:8080     # Test custom local URL');
  console.log('  node test-server.js https://your-server.example.com   # Test deployed proxy');
  console.log('');
  process.exit(0);
}

// Run the tests
runTests().catch(error => {
  console.error('❌ Test runner error:', error);
  process.exit(1);
});