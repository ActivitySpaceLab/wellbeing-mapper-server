#!/usr/bin/env node
'use strict';

/**
 * Wellbeing Mapper data-collection server.
 *
 * Receives encrypted survey and consent submissions from the app and stores
 * each one as a file for offline decryption by the research team
 * (tools/decrypt_received.py). It also answers participant-code checks. The
 * server never sees survey data in the clear and keeps no other state, so a
 * backup of the storage directory is a backup of everything.
 *
 * Endpoints (paths match lib/util/env.dart in the app):
 *   GET  /health
 *   POST /api/v1/surveys/encrypted       { encrypted_data, survey_type: initial|biweekly, timestamp?, submission_id? }
 *   POST /api/v1/consent/encrypted       { encrypted_data, survey_type: consent, timestamp?, submission_id? }
 *   POST /api/v1/participants/validate   { hashed_code }
 *
 * `encrypted_data` is the app's encrypted package: base64 of a JSON object
 * with encryptedData, iv, encryptedKey and algorithm (tools/encrypt_sample.js
 * builds one the same way). `submission_id` is an optional opaque 64-hex id
 * the app derives from the record; a resubmission with the same id (a retry
 * after a lost response) is acknowledged without being stored again.
 *
 * Configuration is by environment variable; see .env.template.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const pkg = require('./package.json');

const SURVEY_TYPES = Object.freeze({
  survey: ['initial', 'biweekly'],
  consent: ['consent'],
});
const HEX64 = /^[a-f0-9]{64}$/i;
const RATE_WINDOW_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Reads the configuration from environment variables (see .env.template). */
function loadConfig(env = process.env) {
  const number = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a non-negative number, got "${raw}"`);
    }
    return value;
  };
  return {
    port: number('PORT', 3000),
    nodeEnv: env.NODE_ENV || 'development',
    storageDir: path.resolve(env.STORAGE_DIR || path.join(__dirname, 'received')),
    codesFile: path.resolve(env.PARTICIPANT_CODES_FILE || path.join(__dirname, 'participant_codes.json')),
    maxRequestSize: env.MAX_REQUEST_SIZE || '25mb',
    minFreeBytes: number('MIN_FREE_MB', 500) * 1024 * 1024,
    validateLimit: number('RATE_LIMIT_VALIDATE_PER_10MIN', 60),
    uploadLimit: number('RATE_LIMIT_UPLOAD_PER_10MIN', 300),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    allowedOrigins: !env.ALLOWED_ORIGINS || env.ALLOWED_ORIGINS === '*'
      ? '*'
      : env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
  };
}

/**
 * Express's `trust proxy` setting. The default trusts a reverse proxy on the
 * same host or Docker network (Caddy), so rate limits apply to the real
 * client address rather than to the proxy.
 */
function parseTrustProxy(raw) {
  if (raw === undefined || raw === '') return 'loopback, linklocal, uniquelocal';
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

// ---------------------------------------------------------------------------
// Encrypted package checks
// ---------------------------------------------------------------------------

/**
 * Checks that `encryptedData` has the shape the app produces and returns its
 * unencrypted envelope fields (algorithm, research site). Throws with a
 * reason otherwise, so garbage is rejected instead of stored.
 */
function parseEncryptedPackage(encryptedData) {
  if (typeof encryptedData !== 'string' || encryptedData.length === 0) {
    throw new Error('must be a non-empty string');
  }
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(encryptedData)) {
    throw new Error('must be base64');
  }
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(encryptedData, 'base64').toString('utf8'));
  } catch (error) {
    throw new Error('must decode to a JSON object');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('must decode to a JSON object');
  }
  for (const field of ['encryptedData', 'iv', 'encryptedKey', 'algorithm']) {
    if (typeof envelope[field] !== 'string' || envelope[field].length === 0) {
      throw new Error(`missing field ${field}`);
    }
  }
  return {
    algorithm: envelope.algorithm,
    researchSite: typeof envelope.researchSite === 'string' ? envelope.researchSite : null,
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const FILE_WITH_SUBMISSION_ID = /-s([a-f0-9]{64})\.json$/;

/**
 * One JSON file per submission in a flat directory. Writes are atomic (a
 * temporary file is renamed into place after fsync), so a crash never leaves
 * a truncated file behind. Submission ids are part of the file name, so
 * de-duplication survives restarts without an index.
 */
class BlobStore {
  constructor(dir, { minFreeBytes = 0, statfs = fsp.statfs } = {}) {
    this.dir = dir;
    this.minFreeBytes = minFreeBytes;
    this.statfs = statfs;
    /** submission id -> file name */
    this.filesById = new Map();
  }

  /** Creates the directory, proves it is writable, and indexes what is there. */
  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    const probe = path.join(this.dir, `.write-probe-${process.pid}`);
    try {
      await fsp.writeFile(probe, '');
      await fsp.unlink(probe);
    } catch (error) {
      throw new Error(`Storage directory ${this.dir} is not writable: ${error.message}`);
    }
    for (const name of await fsp.readdir(this.dir)) {
      const match = FILE_WITH_SUBMISSION_ID.exec(name);
      if (match) this.filesById.set(match[1], name);
    }
    return this;
  }

  /** Bytes available on the storage volume, or Infinity when unknown. */
  async freeBytes() {
    if (typeof this.statfs !== 'function') return Infinity;
    try {
      const stats = await this.statfs(this.dir);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch (error) {
      return Infinity;
    }
  }

  async hasRoom() {
    return (await this.freeBytes()) >= this.minFreeBytes;
  }

  /**
   * Stores `record` and returns `{ storageKey, duplicate }`. With a
   * `submissionId` that was stored before, nothing is written and the
   * existing file name is returned with `duplicate: true`.
   */
  async store({ category, surveyType, submissionId, record }) {
    if (submissionId && this.filesById.has(submissionId)) {
      return { storageKey: this.filesById.get(submissionId), duplicate: true };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = submissionId ? `s${submissionId}` : `r${crypto.randomBytes(4).toString('hex')}`;
    const name = `${stamp}-${category}-${surveyType}-${suffix}.json`;
    // Claim the id before the first await, so a concurrent resubmission is a
    // duplicate rather than a second file.
    if (submissionId) this.filesById.set(submissionId, name);
    const tmp = path.join(this.dir, `.tmp-${crypto.randomBytes(8).toString('hex')}`);
    try {
      const handle = await fsp.open(tmp, 'w', 0o640);
      try {
        await handle.writeFile(JSON.stringify(record), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsp.rename(tmp, path.join(this.dir, name));
    } catch (error) {
      if (submissionId) this.filesById.delete(submissionId);
      await fsp.unlink(tmp).catch(() => {});
      throw error;
    }
    return { storageKey: name, duplicate: false };
  }
}

// ---------------------------------------------------------------------------
// Participant codes
// ---------------------------------------------------------------------------

/** SHA-256 of the code, trimmed and uppercased, as the app computes it. */
function hashParticipantCode(code) {
  return crypto.createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

/**
 * The participant-code database (participant_codes.json, written by
 * generate_participant_codes.py). Only hashes are kept. The file holds
 * `<type>_hashes` lists; `<type>_codes` lists of plain codes, from older
 * generator versions, are hashed on load.
 */
class ParticipantCodes {
  static TYPES = ['pilot', 'study', 'test'];

  /** Returns null when the file does not exist; throws when it is malformed. */
  static load(file) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${file} is not valid JSON: ${error.message}`);
    }
    return new ParticipantCodes(json, file);
  }

  constructor(json, file = '(inline)') {
    this.file = file;
    /** hash -> code type */
    this.typeByHash = new Map();
    this.counts = {};
    for (const type of ParticipantCodes.TYPES) {
      const entries = [...(json[`${type}_hashes`] || []), ...(json[`${type}_codes`] || [])];
      for (const entry of entries) {
        if (typeof entry !== 'string' || entry.trim() === '') continue;
        const hash = HEX64.test(entry) ? entry.toLowerCase() : hashParticipantCode(entry);
        this.typeByHash.set(hash, type);
      }
      this.counts[type] = entries.length;
    }
  }

  get size() {
    return this.typeByHash.size;
  }

  /** The code type ('pilot' | 'study' | 'test') for a hash, or null. */
  lookup(hashedCode) {
    return this.typeByHash.get(hashedCode.toLowerCase()) || null;
  }
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

function createApp({ config, store, codes, log = console }) {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors({ origin: config.allowedOrigins, methods: ['GET', 'POST'] }));
  app.use(express.json({ limit: config.maxRequestSize }));

  // One line per request; never bodies or client addresses. Successful
  // health checks are not logged (the container healthcheck sends one every
  // 30 seconds).
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path === '/health' && res.statusCode === 200) return;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      log.info(`${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });
    next();
  });

  const limiter = (limit, message) => (limit > 0
    ? rateLimit({
      windowMs: RATE_WINDOW_MS,
      limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message,
    })
    : (req, res, next) => next());
  const uploadLimiter = limiter(config.uploadLimit, { success: false, error: 'Too many requests; try again later' });
  const validateLimiter = limiter(config.validateLimit, { valid: false, error: 'Too many requests; try again later' });

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      version: pkg.version,
      uptime_seconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  const bad = (res, error) => res.status(400).json({ success: false, error });

  /** Handler for the two upload endpoints. */
  const upload = (category, allowedTypes) => async (req, res, next) => {
    try {
      const body = req.body || {};
      const surveyType = body.survey_type === undefined && category === 'consent'
        ? 'consent'
        : body.survey_type;
      if (!allowedTypes.includes(surveyType)) {
        return bad(res, `survey_type must be one of: ${allowedTypes.join(', ')}`);
      }
      let envelope;
      try {
        envelope = parseEncryptedPackage(body.encrypted_data);
      } catch (error) {
        return bad(res, `encrypted_data ${error.message}`);
      }
      const submissionId = body.submission_id;
      if (submissionId !== undefined && submissionId !== null
          && !(typeof submissionId === 'string' && /^[a-f0-9]{64}$/.test(submissionId))) {
        return bad(res, 'submission_id must be a 64-character lowercase hex string');
      }
      if (!(await store.hasRoom())) {
        // A 5xx, so the app keeps the record and retries later.
        return res.status(507).json({ success: false, error: 'Server storage is full; try again later' });
      }

      const record = {
        received_at: new Date().toISOString(),
        category,
        survey_type: surveyType,
        submission_id: submissionId || null,
        client_timestamp: typeof body.timestamp === 'string' ? body.timestamp : null,
        algorithm: envelope.algorithm,
        research_site: envelope.researchSite,
        payload: body,
      };
      const { storageKey, duplicate } = await store.store({
        category, surveyType, submissionId: submissionId || null, record,
      });
      log.info(`${duplicate ? 'duplicate' : 'stored'} ${category}/${surveyType} `
        + `${(body.encrypted_data.length / 1024).toFixed(0)}KB -> ${storageKey}`);
      return res.json({
        success: true,
        category,
        survey_type: surveyType,
        storage_key: storageKey,
        duplicate,
        server_timestamp: new Date().toISOString(),
      });
    } catch (error) {
      return next(error);
    }
  };

  app.post('/api/v1/surveys/encrypted', uploadLimiter, upload('survey', SURVEY_TYPES.survey));
  app.post('/api/v1/consent/encrypted', uploadLimiter, upload('consent', SURVEY_TYPES.consent));

  app.post('/api/v1/participants/validate', validateLimiter, (req, res) => {
    const hashedCode = (req.body || {}).hashed_code;
    if (typeof hashedCode !== 'string' || !HEX64.test(hashedCode)) {
      return res.status(400).json({ valid: false, error: 'hashed_code must be a SHA-256 hex digest' });
    }
    if (!codes) {
      return res.status(503).json({ valid: false, error: 'Participant codes are not configured on this server' });
    }
    const codeType = codes.lookup(hashedCode);
    log.info(codeType ? `participant code accepted (${codeType})` : 'participant code rejected');
    return res.json({ valid: codeType !== null, code_type: codeType, timestamp: new Date().toISOString() });
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ success: false, error: `Request body exceeds ${config.maxRequestSize}` });
    }
    if (error.type === 'entity.parse.failed' || (error instanceof SyntaxError && error.status === 400)) {
      return res.status(400).json({ success: false, error: 'Request body is not valid JSON' });
    }
    log.error(`${new Date().toISOString()} ${req.method} ${req.path} failed: ${error.stack || error}`);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  const config = loadConfig();
  const store = await new BlobStore(config.storageDir, { minFreeBytes: config.minFreeBytes }).init();
  const codes = ParticipantCodes.load(config.codesFile);
  const app = createApp({ config, store, codes });

  const server = app.listen(config.port, () => {
    console.info(`Wellbeing Mapper server ${pkg.version} listening on port ${config.port} (${config.nodeEnv})`);
    console.info(`Storage: ${config.storageDir} (${store.filesById.size} submissions with ids on disk)`);
    console.info(codes
      ? `Participant codes: ${codes.size} loaded from ${config.codesFile}`
      : `Participant codes: none (${config.codesFile} not found); /participants/validate answers 503`);
  });

  const shutdown = (signal) => {
    console.info(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Startup failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  BlobStore,
  ParticipantCodes,
  SURVEY_TYPES,
  createApp,
  hashParticipantCode,
  loadConfig,
  parseEncryptedPackage,
};
