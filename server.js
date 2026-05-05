#!/usr/bin/env node

/**
 * Express.js data collection server for the Wellbeing Mapper app.
 *
 * Receives encrypted survey, consent, and location blobs from the mobile
 * app and persists them to disk (or any storage backend you wire in via
 * `persistEncryptedBlob`). The server never sees plaintext data — only
 * RSA/AES hybrid-encrypted blobs that can be decrypted offline with the
 * private key held by the research team.
 *
 * Endpoints:
 *   GET  /health
 *   POST /api/v1/surveys/encrypted      — initial / biweekly survey blob
 *   POST /api/v1/consent/encrypted      — consent record blob
 *   POST /api/v1/locations/encrypted    — location batch blob
 *   POST /api/v1/participants/validate  — hashed participant-code lookup
 *   POST /api/v1/participants/register  — record a freshly validated code
 *   GET  /api/v1/participants/stats     — code-database stats (admin)
 *
 * Usage:
 *   npm install
 *   node server.js
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Where to persist received encrypted blobs. Override with STORAGE_DIR for
// container/serverless deployments (e.g. mount /tmp on Lambda).
const STORAGE_DIR = process.env.STORAGE_DIR
  || path.join(__dirname, 'received');

// Ensure the storage directory exists at boot. On read-only filesystems
// (e.g. some serverless platforms) callers should set STORAGE_DIR to a
// writable path.
try {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  console.log(`📁 Storage directory: ${STORAGE_DIR}`);
} catch (error) {
  console.warn(`⚠️  Could not create storage directory: ${error.message}`);
}

// Survey-type whitelist for /surveys/encrypted. Consent and location use
// their own dedicated endpoints below.
const VALID_SURVEY_TYPES = ['initial', 'biweekly'];

// Load participant codes database (used by /validate). Optional — the
// server still starts without it, but validation will reject everything.
let participantCodes = null;
try {
  const codesPath = path.join(__dirname, 'participant_codes.json');
  participantCodes = JSON.parse(fs.readFileSync(codesPath, 'utf8'));
  console.log(`✅ Loaded ${participantCodes.meta.totalCodes} participant codes`);
} catch (error) {
  console.warn(`⚠️  Participant codes database not loaded: ${error.message}`);
  console.warn('   /api/v1/participants/validate will reject all requests.');
}

// SHA-256 hash that matches the on-device implementation (uppercased).
function hashParticipantCode(code) {
  return crypto.createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(helmet());
app.use(compression());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : '*',
  methods: ['GET', 'POST'],
  credentials: false,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Persist an encrypted blob to disk. Returns the relative storage key.
 *
 * To swap in S3/GCS/Postgres/etc., replace the body of this function — the
 * route handlers don't care where the blob ends up.
 */
function persistEncryptedBlob({ category, surveyType, body }) {
  const isoTs = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = surveyType ? `${category}-${surveyType}` : category;
  const random = crypto.randomBytes(4).toString('hex');
  const filename = `${isoTs}-${slug}-${random}.json`;
  const fullPath = path.join(STORAGE_DIR, filename);
  const record = {
    received_at: new Date().toISOString(),
    category,
    survey_type: surveyType || null,
    research_site: body.researchSite || body.research_site || null,
    payload: body,
  };
  fs.writeFileSync(fullPath, JSON.stringify(record));
  return path.relative(STORAGE_DIR, fullPath);
}

/**
 * Shared handler for /surveys/encrypted, /consent/encrypted, /locations/encrypted.
 *
 * The app sends:
 *   {
 *     "encrypted_data": "<base64 blob>",
 *     "survey_type":    "initial|biweekly|consent|location",
 *     "timestamp":      "<ISO8601>",
 *     ...optional metadata...
 *   }
 */
function handleEncryptedSubmission(category, allowedSurveyTypes) {
  return (req, res) => {
    try {
      const { encrypted_data: encryptedData, survey_type: surveyType, timestamp } = req.body;

      if (!encryptedData) {
        return res.status(400).json({
          error: 'Missing required field: encrypted_data',
        });
      }

      if (allowedSurveyTypes && !allowedSurveyTypes.includes(surveyType)) {
        return res.status(400).json({
          error: `Invalid survey_type: ${surveyType}.`
            + ` Must be one of: ${allowedSurveyTypes.join(', ')}`,
        });
      }

      const sizeMb = encryptedData.length / (1024 * 1024);
      console.log(`📥 ${category} submission`
        + (surveyType ? ` (${surveyType})` : '')
        + ` — ${sizeMb.toFixed(2)}MB`);

      if (sizeMb > 9) {
        return res.status(413).json({
          error: 'Payload too large',
          size_mb: sizeMb.toFixed(2),
          max_size_mb: 10,
        });
      }

      const storageKey = persistEncryptedBlob({
        category,
        surveyType,
        body: req.body,
      });

      console.log(`💾 Stored as ${storageKey}`);

      return res.json({
        success: true,
        category,
        survey_type: surveyType || null,
        storage_key: storageKey,
        server_timestamp: new Date().toISOString(),
        client_timestamp: timestamp || null,
      });
    } catch (error) {
      console.error(`❌ ${category} submission error:`, error);
      return res.status(500).json({
        error: 'Internal server error',
        message: error.message,
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    server_version: '2.0.0',
  });
});

// Encrypted blob submission endpoints. Paths match `lib/util/env.dart`.
app.post('/api/v1/surveys/encrypted',
  handleEncryptedSubmission('survey', VALID_SURVEY_TYPES));
app.post('/api/v1/consent/encrypted',
  handleEncryptedSubmission('consent'));
app.post('/api/v1/locations/encrypted',
  handleEncryptedSubmission('location'));

// Participant code validation — checks the SHA-256 hash sent by the app
// against the precomputed list of valid codes loaded above.
app.post('/api/v1/participants/validate', (req, res) => {
  try {
    const { hashed_code: hashedCode } = req.body;

    if (!hashedCode) {
      return res.status(400).json({
        valid: false,
        error: 'Missing required field: hashed_code',
      });
    }

    if (!/^[a-f0-9]{64}$/i.test(hashedCode)) {
      return res.status(400).json({
        valid: false,
        error: 'Invalid hash format',
      });
    }

    if (!participantCodes) {
      return res.status(503).json({
        valid: false,
        error: 'Participant codes database not loaded',
      });
    }

    const lookup = hashedCode.toLowerCase();
    let codeType = null;
    const buckets = [
      ['pilot', participantCodes.pilot_codes],
      ['study', participantCodes.study_codes],
      ['test', participantCodes.test_codes],
    ];

    for (const [type, list] of buckets) {
      if (list.some((code) => hashParticipantCode(code) === lookup)) {
        codeType = type;
        break;
      }
    }

    const valid = codeType !== null;
    console.log(valid
      ? `✅ Valid ${codeType} participant code accepted`
      : `❌ Invalid participant code: ${lookup.substring(0, 8)}…`);

    res.json({
      valid,
      code_type: codeType,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('❌ Participant validation error:', error);
    res.status(500).json({
      valid: false,
      error: 'Internal server error during validation',
    });
  }
});

// Participant registration — used by the app once a code has been
// validated to record an opt-in (kept minimal for now).
app.post('/api/v1/participants/register', (req, res) => {
  try {
    const { hashed_code: hashedCode, research_site: researchSite, timestamp } = req.body;

    if (!hashedCode || !/^[a-f0-9]{64}$/i.test(hashedCode)) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid hashed_code',
      });
    }

    persistEncryptedBlob({
      category: 'registration',
      surveyType: null,
      body: {
        hashed_code: hashedCode,
        research_site: researchSite || null,
        client_timestamp: timestamp || null,
      },
    });

    res.json({
      success: true,
      server_timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('❌ Participant registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during registration',
    });
  }
});

// Admin / observability endpoint for the participant codes database.
app.get('/api/v1/participants/stats', (req, res) => {
  if (!participantCodes) {
    return res.status(503).json({
      error: 'Participant codes database not loaded',
    });
  }

  res.json({
    total_codes: participantCodes.meta.totalCodes,
    pilot_codes: participantCodes.pilot_codes.length,
    study_codes: participantCodes.study_codes.length,
    test_codes: participantCodes.test_codes.length,
    database_version: participantCodes.meta.version,
    created: participantCodes.meta.created,
  });
});

// ---------------------------------------------------------------------------
// Error handlers
// ---------------------------------------------------------------------------

app.use((error, req, res, _next) => {
  console.error('❌ Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development'
      ? error.message
      : 'Something went wrong',
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    available_endpoints: [
      'GET  /health',
      'POST /api/v1/surveys/encrypted',
      'POST /api/v1/consent/encrypted',
      'POST /api/v1/locations/encrypted',
      'POST /api/v1/participants/validate',
      'POST /api/v1/participants/register',
      'GET  /api/v1/participants/stats',
    ],
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// Only start a listener when invoked directly (not when imported by the
// Lambda/Vercel handler).
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`🚀 Wellbeing Mapper data collection server listening on :${PORT}`);
    console.log(`📡 Health: http://localhost:${PORT}/health`);
    console.log('🔐 Server only handles encrypted blobs — no plaintext data is processed.');
  });

  const shutdown = (signal) => {
    console.log(`🛑 Received ${signal}, shutting down…`);
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
