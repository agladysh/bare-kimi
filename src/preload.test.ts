import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendPreload,
  findWire,
  formatPreloadMessage,
  preloadRecord,
  readPreloadItem,
} from './preload.ts';
import { makeTempDir } from '../test/helpers.ts';

const cleanups: string[] = [];

function temp(prefix: string): string {
  const dir = makeTempDir(prefix);
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('preloadRecord', () => {
  test('matches the measured context.append_message shape', () => {
    const record = preloadRecord({ path: 'doc.md', content: 'a\nb\n' }, 1_700_000_000_000);
    expect(record['type']).toBe('context.append_message');
    expect(record['agentId']).toBe('main');
    expect(record['time']).toBe(1_700_000_000_000);
    const message = record['message'] as Record<string, unknown>;
    expect(message['role']).toBe('user');
    expect(message['origin']).toEqual({ kind: 'user' });
    expect(message['toolCalls']).toEqual([]);
    expect(String(message['id'])).toMatch(/^msg_[A-Za-z0-9]{24}$/);
    // Only validated content-part types may appear: text is the safe one.
    expect(message['content']).toEqual([
      { type: 'text', text: '[preload] doc.md (3 lines)\n\na\nb\n' },
    ]);
  });

  test('ids are random per record', () => {
    const a = preloadRecord({ path: 'x', content: '' }, 0);
    const b = preloadRecord({ path: 'x', content: '' }, 0);
    expect((a['message'] as Record<string, unknown>)['id']).not.toBe(
      (b['message'] as Record<string, unknown>)['id'],
    );
  });
});

describe('formatPreloadMessage', () => {
  test('labels provenance', () => {
    expect(formatPreloadMessage({ path: 'f.txt', content: 'hello' })).toBe(
      '[preload] f.txt (1 lines)\n\nhello',
    );
  });
});

describe('readPreloadItem', () => {
  test('reads text and rejects binary before any run', () => {
    const root = temp('bare-kimi-preload-');
    const text = join(root, 'note.md');
    writeFileSync(text, 'hello\n');
    expect(readPreloadItem(text)).toEqual({ path: text, content: 'hello\n' });

    const binary = join(root, 'blob.bin');
    writeFileSync(binary, Buffer.from([0x66, 0x00, 0x66]));
    expect(() => readPreloadItem(binary)).toThrow('looks binary');
  });
});

describe('findWire / appendPreload', () => {
  test('round-trips records into a session wire journal', () => {
    const home = temp('bare-kimi-wire-');
    const sessionId = 'session_abc';
    const wire = join(home, 'sessions', 'wd_fake_000000000000', sessionId, 'agents', 'main', 'wire.jsonl');
    mkdirSync(join(wire, '..'), { recursive: true });
    writeFileSync(wire, '{"type":"metadata","protocol_version":"1.5"}\n');

    expect(findWire(home, sessionId)).toBe(wire);
    expect(() => findWire(home, 'session_nope')).toThrow('not found');

    const appended = appendPreload(wire, [
      { path: 'a.md', content: 'A' },
      { path: 'b.md', content: 'B' },
    ]);
    expect(appended).toBe(2);

    const lines = readFileSync(wire, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
    const first: unknown = JSON.parse(lines[1]!);
    expect((first as Record<string, unknown>)['type']).toBe('context.append_message');
    // Append-only: the metadata line is untouched.
    expect(lines[0]).toBe('{"type":"metadata","protocol_version":"1.5"}');
  });

  test('preload files on disk are not left behind by readPreloadItem', () => {
    const root = temp('bare-kimi-preload-');
    const file = join(root, 'keep.md');
    writeFileSync(file, 'x');
    readPreloadItem(file);
    expect(existsSync(file)).toBe(true);
  });
});
