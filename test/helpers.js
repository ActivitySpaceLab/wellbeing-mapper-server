'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { BlobStore, ParticipantCodes, createApp, loadConfig } = require('../server');
const { encryptPackage } = require('../tools/encrypt_sample');

/** A throwaway RSA key pair (2048 bits keeps the tests fast). */
function testKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

const sharedKeys = testKeyPair();

/** A request body like the app's, with a real encrypted package. */
function uploadBody(surveyType, payload = { sample: true }, extra = {}) {
  return {
    encrypted_data: encryptPackage(payload, sharedKeys.publicKeyPem),
    survey_type: surveyType,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

/**
 * Starts the app on an ephemeral port with a temporary storage directory.
 * `codes` (an object) is written to a participant-codes file; without it the
 * codes file is missing. `env` overrides configuration; `statfs` fakes the
 * free-space check.
 */
async function startServer({ codes, env = {}, statfs, dir } = {}) {
  const root = dir || await fsp.mkdtemp(path.join(os.tmpdir(), 'wm-server-test-'));
  const codesFile = path.join(root, 'participant_codes.json');
  if (codes) await fsp.writeFile(codesFile, JSON.stringify(codes));
  const config = loadConfig({
    STORAGE_DIR: path.join(root, 'received'),
    PARTICIPANT_CODES_FILE: codesFile,
    TRUST_PROXY: 'false',
    ...env,
  });
  const store = await new BlobStore(config.storageDir, {
    minFreeBytes: config.minFreeBytes,
    statfs,
  }).init();
  const app = createApp({
    config,
    store,
    codes: ParticipantCodes.load(config.codesFile),
    log: { info() {}, error() {} },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    root,
    storageDir: config.storageDir,
    store,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function request(base, method, route, body, headers = {}) {
  const response = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (error) {
    json = null;
  }
  return { status: response.status, headers: response.headers, json, text };
}

async function storedFiles(storageDir) {
  return (await fsp.readdir(storageDir)).filter((name) => name.endsWith('.json')).sort();
}

module.exports = {
  request, sharedKeys, startServer, storedFiles, testKeyPair, uploadBody,
};
