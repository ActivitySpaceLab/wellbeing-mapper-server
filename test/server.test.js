'use strict';

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, describe, before, after } = require('node:test');

const { hashParticipantCode, parseEncryptedPackage, loadConfig } = require('../server');
const {
  request, sharedKeys, startServer, storedFiles, uploadBody,
} = require('./helpers');

const A_HASH = hashParticipantCode('AB3KP');

describe('health', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.close());

  test('reports ok and the package version', async () => {
    const { status, json } = await request(server.base, 'GET', '/health');
    assert.equal(status, 200);
    assert.equal(json.status, 'ok');
    assert.equal(json.version, require('../package.json').version);
  });

  test('unknown routes answer 404 JSON', async () => {
    const { status, json } = await request(server.base, 'GET', '/nothing/here');
    assert.equal(status, 404);
    assert.equal(json.error, 'Not found');
  });
});

describe('uploads', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.close());

  test('an initial survey is stored as one file holding the whole request', async () => {
    const body = uploadBody('initial', { hello: 'world' });
    const { status, json } = await request(server.base, 'POST', '/api/v1/surveys/encrypted', body);
    assert.equal(status, 200);
    assert.equal(json.success, true);
    assert.equal(json.survey_type, 'initial');
    assert.equal(json.duplicate, false);

    const stored = JSON.parse(await fsp.readFile(path.join(server.storageDir, json.storage_key), 'utf8'));
    assert.equal(stored.category, 'survey');
    assert.equal(stored.survey_type, 'initial');
    assert.equal(stored.submission_id, null);
    assert.equal(stored.client_timestamp, body.timestamp);
    assert.equal(stored.algorithm, 'AES-256-GCM+RSA-OAEP-SHA256');
    assert.equal(stored.research_site, 'wellbeing_mapper');
    assert.deepEqual(stored.payload, body);
    assert.match(json.storage_key, /^\d{4}-\d{2}-\d{2}T.*-survey-initial-r[a-f0-9]{8}\.json$/);
  });

  test('biweekly surveys and consent forms are accepted on their endpoints', async () => {
    const biweekly = await request(server.base, 'POST', '/api/v1/surveys/encrypted', uploadBody('biweekly'));
    assert.equal(biweekly.status, 200);
    const consent = await request(server.base, 'POST', '/api/v1/consent/encrypted', uploadBody('consent'));
    assert.equal(consent.status, 200);
    assert.equal(consent.json.category, 'consent');
    assert.equal(consent.json.survey_type, 'consent');
  });

  test('a wrong or missing survey_type is rejected', async () => {
    for (const body of [uploadBody('consent'), uploadBody(undefined), uploadBody('wellbeing')]) {
      const { status, json } = await request(server.base, 'POST', '/api/v1/surveys/encrypted', body);
      assert.equal(status, 400, JSON.stringify(json));
      assert.match(json.error, /survey_type must be one of: initial, biweekly/);
    }
    const { status } = await request(server.base, 'POST', '/api/v1/consent/encrypted', uploadBody('initial'));
    assert.equal(status, 400);
  });

  test('encrypted_data must be a well-formed package', async () => {
    const cases = [
      [{ survey_type: 'initial' }, /non-empty string/],
      [{ survey_type: 'initial', encrypted_data: 42 }, /non-empty string/],
      [{ survey_type: 'initial', encrypted_data: 'not base64 at all!' }, /must be base64/],
      [{ survey_type: 'initial', encrypted_data: Buffer.from('"just a string"').toString('base64') }, /JSON object/],
      [{ survey_type: 'initial', encrypted_data: Buffer.from('{"encryptedData":"x"}').toString('base64') }, /missing field iv/],
    ];
    for (const [body, expected] of cases) {
      const { status, json } = await request(server.base, 'POST', '/api/v1/surveys/encrypted', body);
      assert.equal(status, 400, JSON.stringify(body));
      assert.match(json.error, expected);
    }
    assert.equal(await storedFiles(server.storageDir).then((f) => f.length), 3);
  });

  test('invalid JSON bodies answer 400', async () => {
    const { status, json } = await request(server.base, 'POST', '/api/v1/surveys/encrypted', '{not json');
    assert.equal(status, 400);
    assert.match(json.error, /not valid JSON/);
  });

  test('a malformed submission_id is rejected', async () => {
    const { status } = await request(server.base, 'POST', '/api/v1/surveys/encrypted',
      uploadBody('initial', {}, { submission_id: 'abc' }));
    assert.equal(status, 400);
  });
});

describe('de-duplication by submission_id', () => {
  test('a resubmission is acknowledged without a second file, also after a restart', async () => {
    const id = 'a'.repeat(64);
    let server = await startServer();
    const first = await request(server.base, 'POST', '/api/v1/surveys/encrypted',
      uploadBody('biweekly', { n: 1 }, { submission_id: id }));
    assert.equal(first.json.duplicate, false);
    assert.match(first.json.storage_key, new RegExp(`-s${id}\\.json$`));

    const again = await request(server.base, 'POST', '/api/v1/surveys/encrypted',
      uploadBody('biweekly', { n: 2 }, { submission_id: id }));
    assert.equal(again.status, 200);
    assert.equal(again.json.success, true);
    assert.equal(again.json.duplicate, true);
    assert.equal(again.json.storage_key, first.json.storage_key);
    assert.equal((await storedFiles(server.storageDir)).length, 1);

    // The id index is rebuilt from the file names when the server restarts.
    const { root } = server;
    await server.close();
    server = await startServer({ dir: root });
    const afterRestart = await request(server.base, 'POST', '/api/v1/surveys/encrypted',
      uploadBody('biweekly', { n: 3 }, { submission_id: id }));
    assert.equal(afterRestart.json.duplicate, true);
    assert.equal((await storedFiles(server.storageDir)).length, 1);
    await server.close();
  });
});

describe('limits', () => {
  test('bodies over MAX_REQUEST_SIZE answer 413', async () => {
    const server = await startServer({ env: { MAX_REQUEST_SIZE: '2kb' } });
    try {
      const { status, json } = await request(server.base, 'POST', '/api/v1/surveys/encrypted',
        uploadBody('initial', { padding: 'x'.repeat(4096) }));
      assert.equal(status, 413);
      assert.match(json.error, /2kb/);
    } finally {
      await server.close();
    }
  });

  test('a full disk answers 507 so the app retries later', async () => {
    const server = await startServer({
      env: { MIN_FREE_MB: '500' },
      statfs: async () => ({ bavail: 10n, bsize: 4096n }),
    });
    try {
      const { status, json } = await request(server.base, 'POST', '/api/v1/surveys/encrypted', uploadBody('initial'));
      assert.equal(status, 507);
      assert.equal(json.success, false);
      assert.equal((await storedFiles(server.storageDir)).length, 0);
    } finally {
      await server.close();
    }
  });

  test('upload and validation rate limits answer 429', async () => {
    const server = await startServer({
      codes: { study_hashes: [A_HASH] },
      env: { RATE_LIMIT_UPLOAD_PER_10MIN: '2', RATE_LIMIT_VALIDATE_PER_10MIN: '2' },
    });
    try {
      const statuses = [];
      for (let i = 0; i < 3; i += 1) {
        statuses.push((await request(server.base, 'POST', '/api/v1/surveys/encrypted', uploadBody('initial'))).status);
      }
      assert.deepEqual(statuses, [200, 200, 429]);
      const validations = [];
      for (let i = 0; i < 3; i += 1) {
        validations.push(await request(server.base, 'POST', '/api/v1/participants/validate', { hashed_code: A_HASH }));
      }
      assert.deepEqual(validations.map((r) => r.status), [200, 200, 429]);
      assert.equal(validations[2].json.valid, false);
      // The limits are per endpoint: consent uploads are still accepted.
      assert.equal((await request(server.base, 'POST', '/api/v1/consent/encrypted', uploadBody('consent'))).status, 429,
        'upload endpoints share one limit');
    } finally {
      await server.close();
    }
  });
});

describe('participant validation', () => {
  test('answers 503 while no codes file is configured', async () => {
    const server = await startServer();
    try {
      const { status, json } = await request(server.base, 'POST', '/api/v1/participants/validate', { hashed_code: A_HASH });
      assert.equal(status, 503);
      assert.equal(json.valid, false);
    } finally {
      await server.close();
    }
  });

  test('accepts hashes and plain codes in any bucket, and rejects the rest', async () => {
    const server = await startServer({
      codes: {
        study_hashes: [A_HASH.toUpperCase()],
        pilot_codes: ['pq7xm'],
        test_codes: ['TESTER'],
      },
    });
    try {
      const check = async (hash) => (await request(server.base, 'POST', '/api/v1/participants/validate', { hashed_code: hash })).json;
      assert.deepEqual([(await check(A_HASH)).valid, (await check(A_HASH)).code_type], [true, 'study']);
      assert.equal((await check(hashParticipantCode('PQ7XM'))).code_type, 'pilot');
      assert.equal((await check(hashParticipantCode('tester'))).code_type, 'test');
      const unknown = await check(hashParticipantCode('NOPE1'));
      assert.equal(unknown.valid, false);
      assert.equal(unknown.code_type, null);
    } finally {
      await server.close();
    }
  });

  test('rejects anything but a SHA-256 hex digest', async () => {
    const server = await startServer({ codes: { study_hashes: [A_HASH] } });
    try {
      for (const body of [{}, { hashed_code: '' }, { hashed_code: 'AB3KP' }, { hashed_code: 12 }]) {
        const { status, json } = await request(server.base, 'POST', '/api/v1/participants/validate', body);
        assert.equal(status, 400, JSON.stringify(body));
        assert.equal(json.valid, false);
      }
    } finally {
      await server.close();
    }
  });
});

describe('configuration', () => {
  test('rejects non-numeric limits', () => {
    assert.throws(() => loadConfig({ MIN_FREE_MB: 'lots' }), /MIN_FREE_MB/);
  });

  test('trusts the local reverse proxy by default', () => {
    assert.equal(loadConfig({}).trustProxy, 'loopback, linklocal, uniquelocal');
    assert.equal(loadConfig({ TRUST_PROXY: 'false' }).trustProxy, false);
    assert.equal(loadConfig({ TRUST_PROXY: '2' }).trustProxy, 2);
  });

  test('parseEncryptedPackage reads the envelope fields', () => {
    const envelope = parseEncryptedPackage(uploadBody('initial').encrypted_data);
    assert.equal(envelope.algorithm, 'AES-256-GCM+RSA-OAEP-SHA256');
    assert.equal(envelope.researchSite, 'wellbeing_mapper');
  });

  test('a storage directory that cannot be written fails startup', async () => {
    if (process.getuid && process.getuid() === 0) return; // root can write anywhere
    const { BlobStore } = require('../server');
    const os = require('os');
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wm-readonly-'));
    await fsp.chmod(root, 0o500);
    try {
      await assert.rejects(
        new BlobStore(path.join(root, 'received')).init(),
        /not writable|EACCES|EPERM/,
      );
    } finally {
      await fsp.chmod(root, 0o700);
    }
  });
});

describe('decryption tool', () => {
  const python = process.env.PYTHON || 'python3';
  const available = spawnSync(python, ['-c', 'import cryptography'], { encoding: 'utf8' }).status === 0;

  test('decrypts what the server stored, with the private key', { skip: !available && `${python} lacks the cryptography package` }, async () => {
    const server = await startServer();
    try {
      const payload = { type: 'biweekly_survey', answers: { happy: 7, note: 'ciao è' }, list: [1, 2, 3] };
      const { json } = await request(server.base, 'POST', '/api/v1/surveys/encrypted',
        uploadBody('biweekly', payload, { submission_id: 'b'.repeat(64) }));
      const keyFile = path.join(server.root, 'private.pem');
      await fsp.writeFile(keyFile, sharedKeys.privateKeyPem);
      const outDir = path.join(server.root, 'decrypted');

      const run = spawnSync(python, [
        path.join(__dirname, '..', 'tools', 'decrypt_received.py'),
        '--key', keyFile, '--out', outDir, server.storageDir,
      ], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stderr, /decrypted 1, failed 0/);

      const result = JSON.parse(await fsp.readFile(path.join(outDir, json.storage_key.replace(/\.json$/, '.decrypted.json')), 'utf8'));
      assert.deepEqual(result.plaintext, payload);
      assert.equal(result.survey_type, 'biweekly');
      assert.equal(result.submission_id, 'b'.repeat(64));
      assert.equal(result.source_file, json.storage_key);
    } finally {
      await server.close();
    }
  });

  test('reports a file encrypted for another key and keeps going', { skip: !available && `${python} lacks the cryptography package` }, async () => {
    const server = await startServer();
    try {
      await request(server.base, 'POST', '/api/v1/consent/encrypted', uploadBody('consent', { ok: true }));
      const { testKeyPair } = require('./helpers');
      const otherKey = path.join(server.root, 'other.pem');
      await fsp.writeFile(otherKey, testKeyPair().privateKeyPem);
      const run = spawnSync(python, [
        path.join(__dirname, '..', 'tools', 'decrypt_received.py'),
        '--key', otherKey, '--stdout', server.storageDir,
      ], { encoding: 'utf8' });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /FAILED .*\.json/);
      assert.match(run.stderr, /decrypted 0, failed 1/);
    } finally {
      await server.close();
    }
  });
});
