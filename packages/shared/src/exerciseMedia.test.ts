import { describe, expect, it } from 'vitest';
import {
  MEDIA_RIGHTS, checkUpload, formatBytes, formatTimecode, mediaKindLabel, mediaRightsLabel, normalizeMediaFilename,
  parseTimecode, validTrim,
} from './exerciseMedia';

describe('normalizeMediaFilename', () => {
  it.each([
    ['heel_slide.mp4', 'heel slide'],
    ['03 - Heel-Slide.MP4', 'heel slide'],
    ['0001-2gPfomN.gif', '2g pfom n'],
    ['SideLyingLegRaise.webm', 'side lying leg raise'],
    ['C:\\clips\\knee\\straight leg raise (v2).mp4', 'straight leg raise v2'],
    ['החלקת_עקב.jpg', 'החלקת עקב'],
    ['no-extension', 'no extension'],
    ['  spaced   out .png', 'spaced out'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeMediaFilename(input)).toBe(expected);
  });
});

describe('checkUpload', () => {
  it('accepts supported types within their cap', () => {
    expect(checkUpload('image/jpeg', 1000)).toEqual({ ok: true, kind: 'image', ext: 'jpg' });
    expect(checkUpload('image/gif', 14 * 1024 * 1024)).toEqual({ ok: true, kind: 'gif', ext: 'gif' });
    expect(checkUpload('video/mp4', 50 * 1024 * 1024)).toEqual({ ok: true, kind: 'clip', ext: 'mp4' });
  });
  it('rejects unsupported and oversized files', () => {
    expect(checkUpload('video/quicktime', 10)).toEqual({ ok: false, reason: 'unsupported_type' });
    expect(checkUpload('image/png', 5 * 1024 * 1024 + 1)).toEqual({ ok: false, reason: 'too_large', maxBytes: 5 * 1024 * 1024 });
  });
});

describe('timecodes', () => {
  it('parses', () => {
    expect(parseTimecode('')).toBeNull();
    expect(parseTimecode('90')).toBe(90);
    expect(parseTimecode('1:05')).toBe(65);
    expect(parseTimecode(' 1:02:03 ')).toBe(3723);
    expect(parseTimecode('1:75')).toBeNaN();
    expect(parseTimecode('abc')).toBeNaN();
    expect(parseTimecode('-5')).toBeNaN();
  });
  it('formats', () => {
    expect(formatTimecode(null)).toBe('');
    expect(formatTimecode(0)).toBe('0:00');
    expect(formatTimecode(65)).toBe('1:05');
    expect(formatTimecode(3723)).toBe('1:02:03');
  });
  it('round-trips', () => {
    for (const s of [0, 9, 60, 599, 3600, 4000]) expect(parseTimecode(formatTimecode(s))).toBe(s);
  });
  it('validates trim windows like the DB constraint', () => {
    expect(validTrim(null, null)).toBe(true);
    expect(validTrim(5, null)).toBe(true);
    expect(validTrim(null, 5)).toBe(true);
    expect(validTrim(5, 10)).toBe(true);
    expect(validTrim(10, 10)).toBe(false);
    expect(validTrim(null, 0)).toBe(false);
    expect(validTrim(Number.NaN, 10)).toBe(false);
  });
});

describe('formatBytes', () => {
  it('formats', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('media labels', () => {
  it.each([...MEDIA_RIGHTS])('rights %s has a Hebrew label', (r) => expect(mediaRightsLabel(r)).toMatch(/[֐-׿]/));
  // GIF / YouTube are brand names and stay in Latin script
  it.each(['image', 'clip'])('kind %s has a Hebrew label', (k) => expect(mediaKindLabel(k)).toMatch(/[֐-׿]/));
  it.each(['gif', 'video'])('kind %s resolves to a label', (k) => expect(mediaKindLabel(k)).not.toMatch(/^media\./));
});
