import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { LINEAR_API_SERVICE_NAME } from '../src/plugin.js';

/**
 * Manifest ↔ code ↔ package.json consistency.
 *
 * Nothing reads `manifest.yaml` at runtime in this package, so every `# ===`
 * comment next to `identity.id` is a promise no compiler keeps. Three of those
 * promises are load-bearing: a version that disagrees with package.json ships
 * a permanently mislabelled artefact (hub versions are immutable), an entry
 * that disagrees with the build produces a plugin core cannot start, and a
 * `provides:` name that disagrees with `ctx.services.provide` produces a
 * capability the Linear agent can never resolve — all three with no error
 * until install time.
 *
 * Line-oriented on purpose rather than a YAML parse: the package has zero
 * runtime dependencies, and pulling in a parser for one test is the worse
 * trade against a handful of narrow assertions.
 */

const root = process.cwd();
const manifest = readFileSync(join(root, 'manifest.yaml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  main: string;
};

function scalar(key: string): string {
  const m = new RegExp(`^\\s*${key}:\\s*"([^"]*)"`, 'm').exec(manifest);
  assert.ok(m, `manifest key not found: ${key}`);
  return m?.[1] ?? '';
}

/** The `- "value"` items of a named list block. */
function listItems(key: string): string[] {
  const block = new RegExp(`^\\s*${key}:\\s*\\n((?:\\s*(?:#[^\\n]*|- [^\\n]*)\\n)*)`, 'm').exec(
    manifest,
  );
  assert.ok(block, `manifest list not found: ${key}`);
  return [...(block?.[1] ?? '').matchAll(/^\s*- "([^"]+)"/gm)].map((m) => m[1] ?? '');
}

describe('manifest.yaml ↔ package.json', () => {
  it('declares the same id and version', () => {
    assert.equal(scalar('id'), pkg.name);
    assert.equal(scalar('version'), pkg.version);
  });

  it('declares the entry point package.json points at', () => {
    assert.equal(scalar('entry'), 'dist/plugin.js');
    assert.equal(pkg.main, 'dist/plugin.js');
  });
});

describe('manifest.yaml ↔ code', () => {
  it('is an integration in the linear domain', () => {
    assert.equal(scalar('kind'), 'integration');
    assert.equal(scalar('domain'), 'linear');
  });

  it('provides the capability name the plugin registers', () => {
    assert.deepEqual(listItems('provides'), [`${LINEAR_API_SERVICE_NAME}@2`]);
  });

  it('names the client type a builder agent would look up', () => {
    const block = /^service_types:\n([\s\S]*?)(?=^\S)/m.exec(manifest)?.[1] ?? '';
    assert.match(block, new RegExp(`service:\\s*"${LINEAR_API_SERVICE_NAME}"`));
    assert.match(block, new RegExp(`from:\\s*"${pkg.name}"`));
    assert.match(block, /name:\s*"LinearClient"/);
  });

  it('allows exactly the one host the client talks to', () => {
    assert.deepEqual(listItems('outbound'), ['api.linear.app']);
  });

  it('declares the secret the plugin requires, and nothing else', () => {
    const keys = [...manifest.matchAll(/^\s*- key:\s*"([^"]+)"/gm)].map((m) => m[1]);
    assert.deepEqual(keys, ['linear_api_key']);
    assert.ok(/type:\s*"secret"/.test(manifest));
    assert.ok(/required:\s*true/.test(manifest));
  });

  it('mounts no routes and claims no public paths — Push is not in scope', () => {
    assert.ok(!/public_paths/.test(manifest));
    assert.ok(!/^\s*routes:/m.test(manifest));
  });

  it('carries a localized description rather than a bare string (#885)', () => {
    assert.ok(
      /description:\s*\n\s*en:\s*"/.test(manifest),
      'identity.description must be an en/de locale map',
    );
    assert.ok(/^\s*de:\s*"/m.test(manifest));
  });
});

describe('host API', () => {
  // `compat.core` starts at 1.0, and the connection check arrived in a later
  // host. A named import of a runtime export an older host lacks fails the
  // whole module at link time, so the host package may be imported for its
  // types only.
  for (const rel of readdirSync(join(root, 'src')).filter((f) => f.endsWith('.ts'))) {
    it(`src/${rel} imports @omadia/plugin-api for types only`, () => {
      const text = readFileSync(join(root, 'src', rel), 'utf8');
      const imports = [...text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'@omadia\/plugin-api';/gms)];
      for (const match of imports) {
        assert.ok(match[1], `src/${rel} has a runtime import: ${match[0]}`);
      }
    });
  }

  it('keeps the range of hosts it loads on', () => {
    assert.equal(scalar('core'), '>=1.0 <2.0');
  });
});

describe('shipped files', () => {
  // The maintainer keeps working notes in a local `_scratch/` directory next
  // to the checkout. It is not part of this repository, and nothing in it may
  // be referenced from a file that is.
  const SHIPPED = [
    'manifest.yaml',
    'package.json',
    'README.md',
    'INTEGRATION.md',
    'tsconfig.json',
    'src/client.ts',
    'src/connectionStatus.ts',
    'src/plugin.ts',
    'scripts/build-zip.mjs',
    'scripts/test.mjs',
  ];

  for (const rel of SHIPPED) {
    it(`${rel} references no internal working directory`, () => {
      const text = readFileSync(join(root, rel), 'utf8');
      // The needle carries the separator on purpose: the reference that must
      // never ship is a path into that directory, and matching the bare word
      // would also flag prose about the unrelated `filesystem.scratch`
      // manifest key.
      assert.ok(!text.includes('_scratch/'), `${rel} references the internal working directory`);
    });
  }
});
