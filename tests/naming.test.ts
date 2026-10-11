import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPhoneKeyName, memberName, possessive } from '../src/lib/naming';

describe('member name', () => {
  it('prefers the name the user gave the app', () => {
    assert.equal(memberName('Rob', { name: 'My phone key', displayName: 'Old name' }), 'Rob');
    assert.equal(memberName('  Rob  ', { name: 'My phone key' }), 'Rob');
  });

  it('falls back to the legacy per-key group name, then the key name, then the fallback', () => {
    assert.equal(memberName('', { name: 'My phone key', displayName: 'Robbie' }), 'Robbie');
    assert.equal(memberName(undefined, { name: 'My phone key', displayName: '  ' }), 'My phone key');
    assert.equal(memberName('', undefined), 'Member');
    assert.equal(memberName('', undefined, 'Me'), 'Me');
  });
});

describe('possessive', () => {
  it('adds an apostrophe s', () => {
    assert.equal(possessive('Rob'), "Rob's");
    assert.equal(possessive('James'), "James's");
  });

  it('leaves a name that already ends in apostrophe s alone', () => {
    assert.equal(possessive("Rob's"), "Rob's");
    assert.equal(possessive('Rob’s'), 'Rob’s');
  });
});

describe('default phone key name', () => {
  it('names the key after the person', () => {
    assert.equal(defaultPhoneKeyName('Rob', []), "Rob's phone");
  });

  it('numbers a second key rather than repeating the name', () => {
    assert.equal(defaultPhoneKeyName('Rob', ["Rob's phone"]), "Rob's phone 2");
    assert.equal(defaultPhoneKeyName('Rob', ["rob's phone", "Rob's phone 2"]), "Rob's phone 3");
  });

  it('keeps the old default when no name was given', () => {
    assert.equal(defaultPhoneKeyName('', []), 'My phone key');
    assert.equal(defaultPhoneKeyName(undefined, ['My phone key']), 'My phone key 2');
  });
});
