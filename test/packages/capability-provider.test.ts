'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const { loadPoints, POINT_VALIDATORS } = require('../../src/runtime/packages/points.ts');
const { checkManifest } = require('../../src/runtime/packages/manifest.ts');

const POINTS = loadPoints().registry;
const HOST = '2.0.0-beta.7';
const OPTIONS = { pointsRegistry: POINTS, hostVersion: HOST, bundled: [] };

function createPackageDir(manifest: any, files: Record<string, any> = {}): string {
  const root = path.join(suiteTempDir('doflow-test-cappkg-'), 'pkg');
  fs.mkdirSync(root, { recursive: true });
  if (manifest !== null) {
    fs.writeFileSync(
      path.join(root, 'doflow-package.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
      'utf8'
    );
  }
  for (const [rel, content] of Object.entries(files)) {
    const absPath = path.join(root, rel);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(
      absPath,
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
      'utf8'
    );
  }
  return root;
}

describe('capability-provider point validator (capability-provider-v1)', () => {
  const validator = POINT_VALIDATORS['capability-provider-v1'];

  test('accepts valid http capability provider', () => {
    const validHttp = {
      capability: 'document.extract',
      name: 'Local OCR Service',
      kind: 'http',
      sourceMode: 'live',
      costTier: 'free',
      timeoutMs: 5000,
      endpoint: 'http://127.0.0.1:8080/extract',
      healthEndpoint: 'http://127.0.0.1:8080/health',
      method: 'POST',
      headers: { 'Authorization': 'Bearer local-token' },
      requestTemplate: { filePath: '{filePath}' },
      responsePath: 'data.extracted',
    };
    const errors = validator('local-ocr', validHttp, { packageId: 'ocr-pkg' });
    assert.deepEqual(errors, []);
  });

  test('accepts valid cli capability provider', () => {
    const validCli = {
      capability: 'text.compress',
      name: 'Local Text Compressor',
      kind: 'cli',
      sourceMode: 'live',
      costTier: 'compute',
      timeoutMs: 15000,
      program: 'compress-bin',
      argvTemplate: ['--in', '{filePath}', '--level', '9'],
      responsePath: 'output.text',
    };
    const errors = validator('local-compressor', validCli, { packageId: 'compress-pkg' });
    assert.deepEqual(errors, []);
  });

  test('accepts localhost and IPv6 loopback [::1] endpoints', () => {
    const baseHttp = {
      capability: 'document.extract',
      name: 'Local OCR Service',
      kind: 'http',
      sourceMode: 'live',
      costTier: 'free',
    };
    assert.deepEqual(validator('p1', { ...baseHttp, endpoint: 'http://localhost:3000/v1' }), []);
    assert.deepEqual(validator('p2', { ...baseHttp, endpoint: 'http://[::1]:8080/api' }), []);
  });

  test('rejects remote endpoints and healthEndpoints with DISALLOWED_REMOTE_ENDPOINT', () => {
    const baseHttp = {
      capability: 'document.extract',
      name: 'Local OCR Service',
      kind: 'http',
      sourceMode: 'live',
      costTier: 'free',
    };

    const disallowedEndpoints = [
      'https://api.external.com/extract',
      'http://192.168.1.100:8080/extract',
      'http://0.0.0.0:8080/extract',
      'http://10.0.0.1:8080/extract',
      'http://172.16.0.1:8080/extract',
    ];

    for (const endpoint of disallowedEndpoints) {
      const errors = validator('ocr', { ...baseHttp, endpoint });
      assert.ok(
        errors.some((e: string) => e.includes('DISALLOWED_REMOTE_ENDPOINT')),
        `expected DISALLOWED_REMOTE_ENDPOINT for endpoint: ${endpoint}`
      );
    }

    const healthErrors = validator('ocr', {
      ...baseHttp,
      endpoint: 'http://127.0.0.1:8080/extract',
      healthEndpoint: 'http://remote.host:8080/health',
    });
    assert.ok(
      healthErrors.some((e: string) => e.includes('DISALLOWED_REMOTE_ENDPOINT')),
      'expected DISALLOWED_REMOTE_ENDPOINT for remote healthEndpoint'
    );
  });

  test('forbids program property when kind is http', () => {
    const errors = validator('bad-http', {
      capability: 'document.extract',
      name: 'Bad HTTP',
      kind: 'http',
      sourceMode: 'live',
      endpoint: 'http://127.0.0.1:8080/extract',
      program: 'should-not-be-here',
    });
    assert.ok(errors.some((e: string) => e.includes("'program' is forbidden when kind is 'http'")));
  });

  test('forbids endpoint property when kind is cli', () => {
    const errors = validator('bad-cli', {
      capability: 'text.compress',
      name: 'Bad CLI',
      kind: 'cli',
      sourceMode: 'live',
      program: 'compress-bin',
      endpoint: 'http://127.0.0.1:8080/extract',
    });
    assert.ok(errors.some((e: string) => e.includes("'endpoint' is forbidden when kind is 'cli'")));
  });

  test('requires program property when kind is cli', () => {
    const errors = validator('no-prog-cli', {
      capability: 'text.compress',
      name: 'Missing Program CLI',
      kind: 'cli',
      sourceMode: 'live',
    });
    assert.ok(errors.some((e: string) => e.includes("'program' is required when kind is 'cli'")));
  });

  test('validates timeout bounds (positive integer between 1 and 60000)', () => {
    const base = {
      capability: 'document.extract',
      name: 'Timeout Test',
      kind: 'http',
      sourceMode: 'live',
      endpoint: 'http://127.0.0.1:8080',
    };

    const invalidTimeouts = [0, -50, 60001, 12.5, '5000', null];
    for (const timeoutMs of invalidTimeouts) {
      const errors = validator('timeout-test', { ...base, timeoutMs });
      assert.ok(
        errors.some((e: string) => e.includes("'timeoutMs' must be a positive integer between 1 and 60000")),
        `expected timeout error for value: ${timeoutMs}`
      );
    }

    assert.deepEqual(validator('timeout-min', { ...base, timeoutMs: 1 }), []);
    assert.deepEqual(validator('timeout-max', { ...base, timeoutMs: 60000 }), []);
  });

  test('validates sourceMode and costTier enumerations', () => {
    const base = {
      capability: 'document.extract',
      name: 'Enum Test',
      kind: 'http',
      endpoint: 'http://127.0.0.1:8080',
    };

    const badSourceErrors = validator('bad-source', { ...base, sourceMode: 'stream' });
    assert.ok(badSourceErrors.some((e: string) => e.includes("'sourceMode' must be 'live' or 'index'")));

    const badCostErrors = validator('bad-cost', { ...base, sourceMode: 'live', costTier: 'expensive' });
    assert.ok(badCostErrors.some((e: string) => e.includes("'costTier' must be one of: free, compute, local-index, local-graph")));

    for (const validTier of ['free', 'compute', 'local-index', 'local-graph']) {
      assert.deepEqual(validator(`cost-${validTier}`, { ...base, sourceMode: 'live', costTier: validTier }), []);
    }
  });

  test('validates structural properties: non-object entry, capability ID, name, kind, HTTP method/headers, CLI argvTemplate', () => {
    assert.ok(validator('raw', 'not-an-object').some((e: string) => e.includes('must be a JSON object')));
    assert.ok(validator('raw', null).some((e: string) => e.includes('must be a JSON object')));
    assert.ok(validator('raw', []).some((e: string) => e.includes('must be a JSON object')));

    const base = {
      capability: 'document.extract',
      name: 'Valid Name',
      kind: 'http',
      sourceMode: 'live',
      endpoint: 'http://127.0.0.1:8080',
    };

    assert.ok(validator('bad-cap', { ...base, capability: 'notdotseparated' }).some((e: string) => e.includes("'capability' must be a dot-separated capability identifier")));
    assert.ok(validator('bad-cap-upper', { ...base, capability: 'Document.Extract' }).some((e: string) => e.includes("'capability' must be a dot-separated capability identifier")));
    assert.ok(validator('empty-name', { ...base, name: '' }).some((e: string) => e.includes("'name' must be a non-empty string of at most 64 characters")));
    assert.ok(validator('long-name', { ...base, name: 'x'.repeat(65) }).some((e: string) => e.includes("'name' must be a non-empty string of at most 64 characters")));
    assert.ok(validator('bad-kind', { ...base, kind: 'grpc' }).some((e: string) => e.includes("'kind' must be 'http' or 'cli'")));
    assert.ok(validator('bad-method', { ...base, method: 'PUT' }).some((e: string) => e.includes("'method' must be 'POST' or 'GET'")));
    assert.ok(validator('bad-headers', { ...base, headers: 'str' }).some((e: string) => e.includes("'headers' must be an object")));
    assert.ok(validator('bad-template', { ...base, requestTemplate: 'str' }).some((e: string) => e.includes("'requestTemplate' must be an object")));
    assert.ok(validator('bad-argv', { capability: 'text.compress', name: 'CLI', kind: 'cli', sourceMode: 'live', program: 'c', argvTemplate: [123] }).some((e: string) => e.includes("'argvTemplate' must be an array of strings")));
  });
});

describe('checkManifest validation with capability-provider contributions', () => {
  const httpProvider = {
    capability: 'document.extract',
    name: 'Local OCR',
    kind: 'http',
    sourceMode: 'live',
    costTier: 'free',
    endpoint: 'http://127.0.0.1:8080/extract',
  };

  const cliProvider = {
    capability: 'text.compress',
    name: 'Local Compressor CLI',
    kind: 'cli',
    sourceMode: 'live',
    costTier: 'compute',
    program: 'compress-bin',
    argvTemplate: ['{filePath}'],
  };

  test('valid package with HTTP capability-provider contribution passes checkManifest with no findings', () => {
    const manifest = {
      manifest: 1,
      id: 'local-ocr-pkg',
      version: '1.0.0',
      summary: 'Local OCR capability provider',
      doflow: '>=2.0.0-beta.1 <3.0.0',
      contributions: [
        {
          point: 'capability-provider',
          version: 1,
          id: 'ocr-extractor',
          file: 'providers/ocr.json',
        },
      ],
    };
    const pkgDir = createPackageDir(manifest, { 'providers/ocr.json': httpProvider });
    const findings = checkManifest(manifest, { ...OPTIONS, root: pkgDir });
    assert.deepEqual(findings, []);
  });

  test('valid package with CLI capability-provider and matching program declaration passes checkManifest', () => {
    const manifest = {
      manifest: 1,
      id: 'local-comp-pkg',
      version: '1.0.0',
      summary: 'Local compressor capability provider',
      doflow: '>=2.0.0-beta.1 <3.0.0',
      programs: [
        {
          id: 'compress-tool',
          binary: 'compress-bin',
          argv: 'capability-cli',
        },
      ],
      contributions: [
        {
          point: 'capability-provider',
          version: 1,
          id: 'text-compressor',
          file: 'providers/compress.json',
          programs: ['compress-tool'],
        },
      ],
    };
    const pkgDir = createPackageDir(manifest, { 'providers/compress.json': cliProvider });
    const findings = checkManifest(manifest, { ...OPTIONS, root: pkgDir });
    assert.deepEqual(findings, []);
  });

  test('detects missing/undeclared program referenced by capability-provider contribution', () => {
    const manifest = {
      manifest: 1,
      id: 'local-comp-pkg',
      version: '1.0.0',
      summary: 'Local compressor capability provider',
      doflow: '>=2.0.0-beta.1 <3.0.0',
      programs: [],
      contributions: [
        {
          point: 'capability-provider',
          version: 1,
          id: 'text-compressor',
          file: 'providers/compress.json',
          programs: ['undeclared-tool'],
        },
      ],
    };
    const pkgDir = createPackageDir(manifest, { 'providers/compress.json': cliProvider });
    const findings = checkManifest(manifest, { ...OPTIONS, root: pkgDir });
    const undeclared = findings.find((f: any) => f.code === 'program-undeclared');
    assert.ok(undeclared, 'expected program-undeclared finding');
    assert.equal(undeclared.field, 'contributions[0].programs');
  });

  test('detects invalid argv shape on program declaration for capability-provider point', () => {
    const manifest = {
      manifest: 1,
      id: 'local-comp-pkg',
      version: '1.0.0',
      summary: 'Local compressor capability provider',
      doflow: '>=2.0.0-beta.1 <3.0.0',
      programs: [
        {
          id: 'compress-tool',
          binary: 'compress-bin',
          argv: 'worker-recipe', // invalid: capability-provider requires 'capability-cli'
        },
      ],
      contributions: [
        {
          point: 'capability-provider',
          version: 1,
          id: 'text-compressor',
          file: 'providers/compress.json',
          programs: ['compress-tool'],
        },
      ],
    };
    const pkgDir = createPackageDir(manifest, { 'providers/compress.json': cliProvider });
    const findings = checkManifest(manifest, { ...OPTIONS, root: pkgDir });
    const invalidArgv = findings.find((f: any) => f.code === 'program-invalid' && f.field === 'programs[0].argv');
    assert.ok(invalidArgv, 'expected program-invalid finding on argv');
    assert.deepEqual(invalidArgv.allowed, ['capability-cli']);
  });

  test('reports file-missing when contribution file does not exist on disk', () => {
    const manifest = {
      manifest: 1,
      id: 'local-ocr-pkg',
      version: '1.0.0',
      summary: 'Local OCR capability provider',
      doflow: '>=2.0.0-beta.1 <3.0.0',
      contributions: [
        {
          point: 'capability-provider',
          version: 1,
          id: 'ocr-extractor',
          file: 'providers/nonexistent.json',
        },
      ],
    };
    const pkgDir = createPackageDir(manifest, {});
    const findings = checkManifest(manifest, { ...OPTIONS, root: pkgDir });
    assert.ok(findings.some((f: any) => f.code === 'file-missing' && f.field === 'contributions[0].file'));
  });
});
