import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ecc from '@bitcoinerlab/secp256k1';
import { Buffer } from 'buffer';
import {
  channelId,
  conversationKey,
  decryptPayload,
  encryptPayload,
  eventId,
  generateSecretKey,
  getPublicKey,
  openFrom,
  paddedLength,
  sealTo,
  signEvent,
  verifyEvent,
} from '../src/lib/nostr/crypto';
import {
  DEFAULT_RELAYS,
  DELETE_EVENT_KIND,
  decodeMessage,
  needsRotation,
  decodeRekey,
  encodeInvite,
  encodeMessage,
  encodeRekey,
  GROUP_EVENT_KIND,
  GroupMessage,
  MAX_CHAT_CHARS,
  MAX_COSIGNERS,
  MAX_KEY_EXPRESSION_CHARS,
  MAX_MEMO_CHARS,
  MAX_NAME_CHARS,
  MAX_PSBT_CHARS,
  MAX_ROSTER,
  parseInvite,
  REKEY_EVENT_KIND,
} from '../src/lib/nostr/protocol';
import { parseEpochs, serialiseEpochs, withEpoch } from '../src/lib/nostr/epochs';
import { AdoptedEpoch, GroupSession, MAX_EPOCH, ReceivedMessage } from '../src/lib/nostr/session';
import {
  coordinatorKnock,
  epochFloor,
  heardFromMembers,
  knocksToReseal,
  MAX_EPOCH_JUMP,
  reportedEpoch,
  RESEAL_GRACE_MS,
} from '../src/lib/nostr/recovery';
import { makeFakeRelay } from './fakeRelay';
import {
  groupAccountIndex,
  isCoordinatorSeed,
  npubFromPubkey,
  nostrSecretForGroup,
  nostrSecretFromMnemonic,
  shortNpub,
} from '../src/lib/nostr/identity';
import { walletDescriptor, keyExpression, accountXpub, bip48Path, masterFingerprint } from '../src/lib/bitcoin';
import { parseWalletDescriptor } from '../src/lib/walletImport';
import { unreadFor } from '../src/lib/nostr/unread';
import { MNEMONICS, makeWallet } from './helpers';

describe('nostr event signing', () => {
  it('signs and verifies an event', () => {
    const sk = generateSecretKey();
    const event = signEvent(sk, {
      created_at: 1700000000,
      kind: GROUP_EVENT_KIND,
      tags: [['t', 'abc']],
      content: 'hello',
    });
    assert.equal(event.pubkey, getPublicKey(sk));
    assert.equal(event.id.length, 64);
    assert.equal(event.sig.length, 128);
    assert.ok(verifyEvent(event));
  });

  it('rejects tampered events', () => {
    const event = signEvent(generateSecretKey(), {
      created_at: 1700000000,
      kind: GROUP_EVENT_KIND,
      tags: [],
      content: 'original',
    });
    assert.ok(!verifyEvent({ ...event, content: 'changed' }));
    assert.ok(!verifyEvent({ ...event, sig: '00'.repeat(64) }));
    // id recomputed but signature no longer matches
    const forged = { ...event, content: 'changed' };
    forged.id = eventId(forged.pubkey, forged);
    assert.ok(!verifyEvent(forged));
  });
});

describe('group encryption', () => {
  const secret = generateSecretKey();

  it('round-trips a payload', () => {
    const text = JSON.stringify({ type: 'chat', text: 'gm' });
    const sealed = encryptPayload(secret, text);
    assert.notEqual(sealed, text);
    assert.equal(decryptPayload(secret, sealed), text);
  });

  it('produces a different ciphertext each time (random nonce)', () => {
    assert.notEqual(encryptPayload(secret, 'same'), encryptPayload(secret, 'same'));
  });

  it('cannot be read with the wrong group secret', () => {
    const sealed = encryptPayload(secret, 'private');
    assert.throws(() => decryptPayload(generateSecretKey(), sealed));
  });

  it('pads messages so a relay cannot tell their type by size', () => {
    const chat = encryptPayload(secret, JSON.stringify({ type: 'chat', name: 'Rob', text: 'gm' }));
    const key = encryptPayload(
      secret,
      JSON.stringify({ type: 'key', name: 'Rob', keyExpression: `[73c5da0a/48h/0h/0h/2h]${'x'.repeat(111)}` })
    );
    assert.equal(chat.length, key.length, 'short messages must share a ciphertext size');

    // Two PSBTs of different real sizes inside one bucket also match.
    const smallPsbt = encryptPayload(secret, JSON.stringify({ type: 'psbt', base64: 'a'.repeat(900) }));
    const biggerPsbt = encryptPayload(secret, JSON.stringify({ type: 'psbt', base64: 'a'.repeat(1500) }));
    assert.equal(smallPsbt.length, biggerPsbt.length);
    assert.ok(smallPsbt.length > chat.length, 'buckets should still differ across magnitudes');
  });

  it('padding round-trips every size, including bucket edges', () => {
    for (const size of [0, 1, 507, 508, 509, 2043, 2044, 2045, 40000]) {
      const text = 'x'.repeat(size);
      assert.equal(decryptPayload(secret, encryptPayload(secret, text)), text);
    }
    assert.equal(paddedLength(0), 512);
    assert.equal(paddedLength(508), 512);
    assert.equal(paddedLength(509), 2048);
    // Oversized payloads round up to whole multiples of the largest bucket.
    assert.equal(paddedLength(131072), 262144);
  });

  it('preserves unicode through padding', () => {
    const text = JSON.stringify({ type: 'chat', name: 'Zoë', text: 'ça va — 日本語 🙂' });
    assert.equal(decryptPayload(secret, encryptPayload(secret, text)), text);
  });

  it('derives a stable channel id that leaks nothing', () => {
    assert.equal(channelId(secret), channelId(secret));
    assert.equal(channelId(secret).length, 32);
    assert.notEqual(channelId(secret), channelId(generateSecretKey()));
    assert.ok(!channelId(secret).includes(secret.slice(0, 8)));
  });
});

describe('invites', () => {
  it('round-trips through the invite URI', () => {
    const invite = {
      secret: generateSecretKey(),
      relays: ['wss://relay.example/one', 'wss://relay.example/two'],
      name: 'Family savings',
      coordinatorPubkey: 'a'.repeat(64),
      m: 2,
      n: 3,
      network: 'mainnet' as const,
      rekey: true,
    };
    const uri = encodeInvite(invite);
    assert.ok(uri.startsWith('multisig:join?'));
    assert.deepEqual(parseInvite(uri), invite);
    // An invite from a build before rotation says nothing, and must not be
    // read as though it promised it.
    assert.equal(parseInvite(uri.replace('&k=1', '')).rekey, false);
  });

  it('pins the coordinator pubkey and ignores a malformed one', () => {
    const secret = generateSecretKey();
    const uri = encodeInvite({
      secret,
      relays: ['wss://r'],
      name: 'V',
      coordinatorPubkey: 'b'.repeat(64),
      m: 2,
      n: 3,
      network: 'mainnet',
    });
    assert.equal(parseInvite(uri).coordinatorPubkey, 'b'.repeat(64));
    // A non-hex / wrong-length pubkey is dropped rather than trusted.
    assert.equal(parseInvite(uri.replace('c=' + 'b'.repeat(64), 'c=nothex')).coordinatorPubkey, undefined);
  });

  it('rejects non-ws relays and caps how many an invite can inject', () => {
    const secret = generateSecretKey();
    // Plain-http / javascript relays are stripped; ws(s) survive (ws:// is
    // kept deliberately for LAN relays, and the join screen warns about it).
    const mixed = encodeInvite({ secret, relays: ['wss://good'], name: 'V', m: 2, n: 3, network: 'mainnet' })
      + '&r=' + encodeURIComponent('http://evil')
      + '&r=' + encodeURIComponent('javascript:alert(1)')
      + '&r=' + encodeURIComponent('ws://192.168.1.10:7777');
    assert.deepEqual(parseInvite(mixed).relays, ['wss://good', 'ws://192.168.1.10:7777']);

    // A flood of relays cannot balloon past the cap.
    const flood = encodeInvite({ secret, relays: [], name: 'V', m: 2, n: 3, network: 'mainnet' })
      + Array.from({ length: 100 }, (_, i) => `&r=${encodeURIComponent('wss://r' + i)}`).join('');
    assert.ok(parseInvite(flood).relays.length <= 20);
  });

  it('rejects an absurd cosigner count', () => {
    const secret = generateSecretKey();
    const uri = encodeInvite({ secret, relays: ['wss://r'], name: 'V', m: 2, n: 4, network: 'mainnet' });
    assert.throws(() => parseInvite(uri.replace('t=4', 't=100000000')), /invalid policy/i);
  });

  it('falls back to default relays and tolerates whitespace', () => {
    const secret = generateSecretKey();
    const uri = encodeInvite({ secret, relays: [], name: 'X', m: 3, n: 5, network: 'mainnet' });
    const parsed = parseInvite(`  ${uri}\n`);
    assert.deepEqual(parsed.relays, DEFAULT_RELAYS);
    assert.equal(parsed.secret, secret);
    assert.equal(parsed.m, 3);
    assert.equal(parsed.n, 5);
  });

  it('rejects junk and damaged invites', () => {
    assert.throws(() => parseInvite('https://example.com'), /not a group invite/i);
    assert.throws(() => parseInvite('multisig:join?v=1&n=x'), /secret/i);
  });

  it('carries the network so members build on the same chain', () => {
    const secret = generateSecretKey();
    const testnet = encodeInvite({
      secret,
      relays: ['wss://r'],
      name: 'Test vault',
      m: 2,
      n: 3,
      network: 'testnet',
    });
    assert.match(testnet, /net=t/);
    assert.equal(parseInvite(testnet).network, 'testnet');

    // Mainnet is the default and stays out of the URI.
    const mainnet = encodeInvite({ secret, relays: ['wss://r'], name: 'V', m: 2, n: 3, network: 'mainnet' });
    assert.ok(!mainnet.includes('net='));
    assert.equal(parseInvite(mainnet).network, 'mainnet');
  });

  it('carries the policy and rejects impossible ones', () => {
    const secret = generateSecretKey();
    const uri = encodeInvite({ secret, relays: ['wss://r'], name: 'Vault', m: 2, n: 4, network: 'mainnet' });
    assert.match(uri, /m=2/);
    assert.match(uri, /t=4/);
    const parsed = parseInvite(uri);
    assert.equal(parsed.m, 2);
    assert.equal(parsed.n, 4);
    // quorum larger than the key count, or a one-key "multisig"
    assert.throws(() => parseInvite(uri.replace('m=2', 'm=9')), /invalid policy/i);
    assert.throws(() => parseInvite(uri.replace('t=4', 't=1')), /invalid policy/i);
  });
});

describe('message envelopes', () => {
  it('round-trips every message type', () => {
    const messages = [
      { type: 'join', name: 'Rob' },
      { type: 'key', name: 'Rob', keyExpression: '[73c5da0a/48h/0h/0h/2h]xpub' },
      { type: 'selection', xpubs: ['xpub-a', 'xpub-b'] },
      { type: 'wallet', name: 'Vault', descriptor: 'wsh(sortedmulti(2,a,b))#abc' },
      { type: 'wallet-reply', name: 'Rob', accepted: false, descriptor: 'wsh(sortedmulti(2,a,b))#abc' },
      { type: 'psbt', base64: 'cHNidP8=', memo: 'coffee' },
      { type: 'psbt-ack', txid: 'ab'.repeat(32) },
      { type: 'chat', name: 'Rob', text: 'gm' },
      { type: 'broadcast', txid: 'ab'.repeat(32), memo: 'coffee' },
    ] as const;
    for (const m of messages) {
      assert.deepEqual(decodeMessage(encodeMessage(m as any)), m);
    }
  });

  it('rejects unknown or malformed messages', () => {
    assert.throws(() => decodeMessage('{"type":"evil"}'), /unknown group message/i);
    assert.throws(() => decodeMessage('{}'), /malformed/i);
    assert.throws(
      () => decodeMessage('{"type":"wallet-reply","name":"Rob","accepted":"no","descriptor":"d"}'),
      /malformed wallet reply/i
    );
    assert.throws(() => decodeMessage('{"type":"wallet-reply","name":"Rob","accepted":true}'), /malformed wallet reply/i);
    assert.throws(() => decodeMessage('{"type":"psbt-ack","txid":"nope"}'), /malformed transaction receipt/i);
  });

  it('bounds every field, and keeps only the fields it knows', () => {
    const long = (n: number) => 'x'.repeat(n + 1);
    const hex = 'ab'.repeat(32);
    // Each cap, one over.
    assert.throws(() => decodeMessage(JSON.stringify({ type: 'join', name: long(MAX_NAME_CHARS) })), /too long/i);
    assert.throws(() => decodeMessage(JSON.stringify({ type: 'chat', name: 'Rob', text: long(MAX_CHAT_CHARS) })), /too long/i);
    assert.throws(
      () => decodeMessage(JSON.stringify({ type: 'key', name: 'Rob', keyExpression: long(MAX_KEY_EXPRESSION_CHARS) })),
      /too long/i
    );
    assert.throws(() => decodeMessage(JSON.stringify({ type: 'psbt', base64: long(MAX_PSBT_CHARS) })), /too long/i);
    assert.throws(() => decodeMessage(JSON.stringify({ type: 'psbt', base64: 'cHNidP8=', memo: long(MAX_MEMO_CHARS) })), /too long/i);
    assert.throws(() => decodeMessage(JSON.stringify({ type: 'broadcast', txid: hex, memo: long(MAX_MEMO_CHARS) })), /too long/i);
    assert.throws(
      () => decodeMessage(JSON.stringify({ type: 'selection', xpubs: Array(MAX_COSIGNERS + 1).fill('xpub') })),
      /too many keys/i
    );
    // Exactly at the cap is fine.
    assert.equal(decodeMessage(JSON.stringify({ type: 'chat', name: 'Rob', text: 'x'.repeat(MAX_CHAT_CHARS) })).type, 'chat');
    assert.equal(decodeMessage(JSON.stringify({ type: 'selection', xpubs: Array(MAX_COSIGNERS).fill('xpub') })).type, 'selection');

    // Wrong shapes.
    assert.throws(() => decodeMessage('{"type":"join"}'), /malformed join/i);
    assert.throws(() => decodeMessage('{"type":"join","name":"Rob","rekey":"yes"}'), /malformed join/i);
    assert.throws(() => decodeMessage('{"type":"key","name":"Rob"}'), /malformed key share/i);
    assert.throws(() => decodeMessage('{"type":"selection","xpubs":"xpub"}'), /malformed selection/i);
    assert.throws(() => decodeMessage('{"type":"selection","xpubs":[1]}'), /malformed selection/i);
    assert.throws(() => decodeMessage('{"type":"wallet","name":"V"}'), /malformed wallet/i);
    // A wallet's key holder names: optional, one per key, each a name.
    assert.throws(
      () => decodeMessage(JSON.stringify({ type: 'wallet', name: 'V', descriptor: 'd', names: Array(MAX_COSIGNERS + 1).fill('a') })),
      /too many keys/i
    );
    assert.throws(
      () => decodeMessage(JSON.stringify({ type: 'wallet', name: 'V', descriptor: 'd', names: [long(MAX_NAME_CHARS)] })),
      /too long/i
    );
    assert.throws(() => decodeMessage('{"type":"wallet","name":"V","descriptor":"d","names":"Alice"}'), /malformed wallet/i);
    assert.throws(() => decodeMessage('{"type":"wallet","name":"V","descriptor":"d","names":[1]}'), /malformed wallet/i);
    assert.deepEqual(decodeMessage('{"type":"wallet","name":"V","descriptor":"d","names":["Alice","Bob"]}'), {
      type: 'wallet',
      name: 'V',
      descriptor: 'd',
      names: ['Alice', 'Bob'],
    });
    assert.deepEqual(
      decodeMessage('{"type":"wallet","name":"V","descriptor":"d"}'),
      { type: 'wallet', name: 'V', descriptor: 'd' },
      'older builds send no names'
    );
    assert.throws(() => decodeMessage('{"type":"psbt"}'), /malformed transaction/i);
    assert.throws(() => decodeMessage('{"type":"psbt","base64":"cHNidP8=","memo":5}'), /malformed transaction/i);
    assert.throws(() => decodeMessage('{"type":"chat","name":"Rob"}'), /malformed chat/i);
    assert.throws(() => decodeMessage('{"type":"broadcast","txid":"nope"}'), /malformed broadcast/i);
    assert.throws(() => decodeMessage('{"type":"broadcast","txid":"ab"}'), /malformed broadcast/i);

    // Epochs: a join's report and a rekey notice, 1 ≤ epoch < MAX_EPOCH.
    assert.throws(() => decodeMessage('{"type":"join","name":"Rob","epoch":0}'), /malformed join/i);
    assert.throws(() => decodeMessage('{"type":"join","name":"Rob","epoch":2.5}'), /malformed join/i);
    assert.throws(() => decodeMessage(`{"type":"join","name":"Rob","epoch":${MAX_EPOCH}}`), /malformed join/i);
    assert.deepEqual(decodeMessage(`{"type":"join","name":"Rob","epoch":${MAX_EPOCH - 1}}`), {
      type: 'join',
      name: 'Rob',
      epoch: MAX_EPOCH - 1,
    });
    assert.throws(() => decodeMessage(`{"type":"rekey-notice","epoch":${MAX_EPOCH}}`), /malformed rekey notice/i);

    // Fields the protocol does not know never make it through.
    assert.deepEqual(decodeMessage('{"type":"chat","name":"Rob","text":"gm","__proto__":{"x":1},"extra":true}'), {
      type: 'chat',
      name: 'Rob',
      text: 'gm',
    });
  });

  it('bounds a rekey envelope the same way', () => {
    const ok = 'a'.repeat(64);
    assert.throws(() => decodeRekey(JSON.stringify({ type: 'rekey', epoch: MAX_EPOCH, secret: ok, members: [] })), /epoch/i);
    const members = Array.from({ length: MAX_ROSTER + 5 }, (_, i) => i.toString(16).padStart(64, '0'));
    const decoded = decodeRekey(JSON.stringify({ type: 'rekey', epoch: 1, secret: ok, members: [...members, 'not-a-pubkey', 7] }));
    assert.equal(decoded.members.length, MAX_ROSTER);
    assert.ok(decoded.members.every((m) => /^[0-9a-f]{64}$/.test(m)));
  });

  it('keeps a wallet reply off the invite key, like the wallet it answers', () => {
    assert.equal(needsRotation('wallet-reply'), true);
    assert.equal(needsRotation('psbt-ack'), true);
    assert.equal(needsRotation('wallet'), true);
    assert.equal(needsRotation('chat'), false);
  });
});

describe('NIP-06 identity from a phone key seed', () => {
  it('derives deterministically from the seed', () => {
    const sk = nostrSecretFromMnemonic(MNEMONICS[0]);
    assert.equal(sk.length, 64);
    assert.equal(nostrSecretFromMnemonic(MNEMONICS[0]), sk);
    assert.notEqual(nostrSecretFromMnemonic(MNEMONICS[1]), sk);
    // Different account index → different identity.
    assert.notEqual(nostrSecretFromMnemonic(MNEMONICS[0], 1), sk);
  });

  it('gives every group a different identity, unlinkable to each other', () => {
    const groupA = generateSecretKey();
    const groupB = generateSecretKey();
    const inA = nostrSecretForGroup(MNEMONICS[0], groupA);
    const inB = nostrSecretForGroup(MNEMONICS[0], groupB);
    assert.notEqual(inA, inB, 'two groups must not share an identity');
    assert.notEqual(getPublicKey(inA), getPublicKey(inB));
  });

  it('never reuses the public NIP-06 identity for a group', () => {
    const publicIdentity = nostrSecretFromMnemonic(MNEMONICS[0]); // account 0
    for (let i = 0; i < 25; i++) {
      const secret = generateSecretKey();
      assert.notEqual(nostrSecretForGroup(MNEMONICS[0], secret), publicIdentity);
      assert.notEqual(groupAccountIndex(secret), 0);
    }
  });

  it('per-group identity is deterministic and survives a reinstall', () => {
    const secret = generateSecretKey();
    assert.equal(
      nostrSecretForGroup(MNEMONICS[0], secret),
      nostrSecretForGroup(MNEMONICS[0], secret)
    );
    // A different member in the same group still gets their own identity.
    assert.notEqual(
      nostrSecretForGroup(MNEMONICS[1], secret),
      nostrSecretForGroup(MNEMONICS[0], secret)
    );
  });

  it('account index is a valid hardened index', () => {
    for (let i = 0; i < 50; i++) {
      const index = groupAccountIndex(generateSecretKey());
      assert.ok(Number.isInteger(index) && index > 0 && index < 0x80000000, `bad index ${index}`);
    }
  });

  it('encodes npub in bech32', () => {
    const pubkey = getPublicKey(nostrSecretFromMnemonic(MNEMONICS[0]));
    const npub = npubFromPubkey(pubkey);
    assert.ok(npub.startsWith('npub1'));
    assert.ok(shortNpub(pubkey).startsWith('npub1'));
  });
});

// --- End-to-end over a fake relay -------------------------------------------

/**
 * In-memory relay that fans events out to every other connected socket. With
 * `retain` it also keeps what it is sent and replays it to each subscription,
 * as real relays do — and `prune` forgets some of it, as real relays may.
 */
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('group session over a relay', () => {
  it('carries a full coordination flow between two members', async () => {
    const relay = makeFakeRelay();
    const secret = generateSecretKey();
    const coordinatorSk = nostrSecretForGroup(MNEMONICS[0], secret);
    const memberSk = nostrSecretForGroup(MNEMONICS[1], secret);

    const coordinator = new GroupSession({
      epochs: [{ epoch: 0, secret }],
      relays: ['wss://fake'],
      identitySecret: coordinatorSk,
      socketFactory: relay.factory,
    });
    const member = new GroupSession({
      epochs: [{ epoch: 0, secret }],
      relays: ['wss://fake'],
      identitySecret: memberSk,
      socketFactory: relay.factory,
    });

    const coordinatorSeen: any[] = [];
    const memberSeen: any[] = [];
    coordinator.start({ onMessage: (m) => coordinatorSeen.push(m) });
    member.start({ onMessage: (m) => memberSeen.push(m) });
    await tick();

    assert.equal(coordinator.connected, 1);
    assert.equal(coordinator.channel, member.channel, 'same secret → same channel');

    // 1. Member shares their key; the coordinator receives it.
    const memberKeyExpr = keyExpression({
      fingerprint: masterFingerprint(MNEMONICS[1]),
      path: bip48Path('mainnet'),
      xpub: accountXpub(MNEMONICS[1], 'mainnet'),
    });
    member.send({ type: 'key', name: 'Alice', keyExpression: memberKeyExpr });
    await tick();

    const receivedKey = coordinatorSeen.find((m) => m.message.type === 'key');
    assert.ok(receivedKey, 'coordinator did not receive the key');
    assert.equal(receivedKey.message.keyExpression, memberKeyExpr);
    assert.equal(receivedKey.author, getPublicKey(memberSk));
    assert.equal(receivedKey.mine, false);

    // 2. Coordinator picks the keys; the member learns immediately, before
    //    any wallet exists.
    const coordinatorKeyExpr = keyExpression({
      fingerprint: masterFingerprint(MNEMONICS[0]),
      path: bip48Path('mainnet'),
      xpub: accountXpub(MNEMONICS[0], 'mainnet'),
    });
    coordinator.send({
      type: 'selection',
      xpubs: [accountXpub(MNEMONICS[0], 'mainnet'), accountXpub(MNEMONICS[1], 'mainnet')],
    });
    await tick();

    const selection = memberSeen.find((m) => m.message.type === 'selection');
    assert.ok(selection, 'member never saw the selection');
    assert.ok(
      selection.message.xpubs.includes(accountXpub(MNEMONICS[1], 'mainnet')),
      "member's own key must appear in the selection they received"
    );
    assert.equal(selection.mine, false);
    assert.ok(coordinatorKeyExpr.length > 0);

    // 3. Coordinator builds a wallet and publishes the descriptor.
    const wallet = makeWallet(2, [MNEMONICS[0], MNEMONICS[1]]);
    coordinator.send({ type: 'wallet', name: 'Vault', descriptor: walletDescriptor(wallet) });
    await tick();

    const receivedWallet = memberSeen.find((m) => m.message.type === 'wallet');
    assert.ok(receivedWallet, 'member did not receive the wallet');
    const parsed = parseWalletDescriptor(receivedWallet.message.descriptor);
    assert.equal(parsed.m, 2);
    assert.equal(parsed.n, 2);

    // 4. A PSBT and a chat message both cross the wire.
    coordinator.send({ type: 'psbt', base64: 'cHNidP8BAA==', memo: 'rent' });
    member.send({ type: 'chat', name: 'Alice', text: 'signed it' });
    await tick();

    assert.equal(memberSeen.filter((m) => m.message.type === 'psbt').length, 1);
    const chat = coordinatorSeen.find((m) => m.message.type === 'chat');
    assert.equal(chat.message.text, 'signed it');

    // Senders see their own messages immediately (relays may not echo).
    assert.ok(coordinatorSeen.some((m) => m.mine && m.message.type === 'wallet'));

    // Everything on the wire was encrypted and tagged with the channel only.
    const published = relay.log.filter((m) => m[0] === 'EVENT').map((m) => m[1]);
    assert.ok(published.length >= 4);
    for (const event of published) {
      assert.equal(event.kind, GROUP_EVENT_KIND);
      assert.deepEqual(event.tags, [['t', coordinator.channel]]);
      assert.ok(!event.content.includes('xpub'), 'plaintext key leaked to relay');
      assert.ok(!event.content.includes('signed it'), 'plaintext chat leaked to relay');
      assert.ok(verifyEvent(event));
    }

    coordinator.stop();
    member.stop();
  });

  it('ignores events from a different group on the same relay', async () => {
    const relay = makeFakeRelay();
    const ours = new GroupSession({
      epochs: [{ epoch: 0, secret: generateSecretKey() }],
      relays: ['wss://fake'],
      identitySecret: generateSecretKey(),
      socketFactory: relay.factory,
    });
    const stranger = new GroupSession({
      epochs: [{ epoch: 0, secret: generateSecretKey() }],
      relays: ['wss://fake'],
      identitySecret: generateSecretKey(),
      socketFactory: relay.factory,
    });
    const seen: any[] = [];
    ours.start({ onMessage: (m) => seen.push(m) });
    stranger.start({ onMessage: () => {} });
    await tick();

    stranger.send({ type: 'chat', name: 'Mallory', text: 'can you read this?' });
    await tick();

    assert.equal(seen.length, 0, 'decrypted a foreign group message');
    ours.stop();
    stranger.stop();
  });

  it('publishes NIP-09 deletions for its own events', async () => {
    const relay = makeFakeRelay();
    const secret = generateSecretKey();
    const session = new GroupSession({
      epochs: [{ epoch: 0, secret }],
      relays: ['wss://fake'],
      identitySecret: nostrSecretForGroup(MNEMONICS[0], secret),
      socketFactory: relay.factory,
    });
    session.start({ onMessage: () => {} });
    await tick();
    const keyEventId = session.send({ type: 'chat', name: 'Rob', text: 'to be deleted' });
    await tick();

    session.requestDeletion([keyEventId]);
    await tick();

    const deletion = relay.log
      .filter((m) => m[0] === 'EVENT')
      .map((m) => m[1])
      .find((e: any) => e.kind === DELETE_EVENT_KIND);
    assert.ok(deletion, 'no deletion event published');
    assert.deepEqual(deletion.tags, [['e', keyEventId]]);
    assert.equal(deletion.pubkey, session.pubkey, 'relays only honour self-signed deletions');
    assert.ok(verifyEvent(deletion));

    // Nothing is sent when there is nothing to delete.
    const before = relay.log.length;
    session.requestDeletion([]);
    assert.equal(relay.log.length, before);
    session.stop();
  });

  it('queues publishes made before the socket opens', async () => {
    const relay = makeFakeRelay();
    const session = new GroupSession({
      epochs: [{ epoch: 0, secret: generateSecretKey() }],
      relays: ['wss://fake'],
      identitySecret: generateSecretKey(),
      socketFactory: relay.factory,
    });
    session.start({ onMessage: () => {} });
    session.send({ type: 'chat', name: 'Rob', text: 'early' }); // before onopen fires
    await tick();
    assert.ok(relay.log.some((m) => m[0] === 'EVENT'), 'queued event never sent');
    session.stop();
  });
});

describe('unread markers', () => {
  const group: any = { id: 'g1', walletId: 'w1', lastReadChatAt: 100, lastSeenTxAt: 100 };
  const chats: any[] = [
    { id: 'a', groupId: 'g1', mine: false, at: 50, text: 'old' },
    { id: 'b', groupId: 'g1', mine: false, at: 150, text: 'new' },
    { id: 'c', groupId: 'g1', mine: true, at: 200, text: 'mine' },
    { id: 'd', groupId: 'other', mine: false, at: 300, text: 'another group' },
  ];
  const pending: any[] = [
    { id: 't1', walletId: 'w1', updatedAt: 50 },
    { id: 't2', walletId: 'w1', updatedAt: 150 },
    { id: 't3', walletId: 'w2', updatedAt: 900 },
  ];

  it('counts only what arrived after the last look', () => {
    const counts = unreadFor(group, chats, pending);
    assert.equal(counts.chat, 1, 'own and already-read messages must not count');
    assert.equal(counts.transactions, 1, 'another wallet must not count');
    assert.equal(counts.total, 2);
  });

  it('treats a never-opened group as all unread', () => {
    const fresh = { ...group, lastReadChatAt: undefined, lastSeenTxAt: undefined };
    const counts = unreadFor(fresh as any, chats, pending);
    assert.equal(counts.chat, 2, 'both messages from others are unread');
    assert.equal(counts.transactions, 2);
  });

  it('clears once everything has been seen', () => {
    const caughtUp = { ...group, lastReadChatAt: 1000, lastSeenTxAt: 1000 };
    assert.equal(unreadFor(caughtUp as any, chats, pending).total, 0);
  });

  it('a group with no wallet yet has no unread transactions', () => {
    const setup = { ...group, walletId: undefined };
    assert.equal(unreadFor(setup as any, chats, pending).transactions, 0);
  });
});

describe('epoch storage', () => {
  it('reads a bare secret from before rotation as epoch 0', () => {
    const secret = generateSecretKey();
    assert.deepEqual(parseEpochs(secret), [{ epoch: 0, secret }]);
    // Uppercase hex from an older write is normalised rather than rejected —
    // treating it as corrupt would lock the member out of their own group.
    assert.deepEqual(parseEpochs(secret.toUpperCase()), [{ epoch: 0, secret }]);
  });

  it('round-trips a rotated list, sorted', () => {
    const invite = generateSecretKey();
    const rotated = generateSecretKey();
    const stored = serialiseEpochs([
      { epoch: 1, secret: rotated },
      { epoch: 0, secret: invite },
    ]);
    assert.deepEqual(parseEpochs(stored), [
      { epoch: 0, secret: invite },
      { epoch: 1, secret: rotated },
    ]);
  });

  it('drops junk rather than throwing', () => {
    assert.deepEqual(parseEpochs(null), []);
    assert.deepEqual(parseEpochs('not json at all'), []);
    assert.deepEqual(parseEpochs('{"epoch":0}'), []);
    assert.deepEqual(parseEpochs('[{"epoch":0,"secret":"too short"}]'), []);
    assert.deepEqual(parseEpochs(`[{"epoch":-1,"secret":"${'a'.repeat(64)}"}]`), []);
  });

  it('never records the same epoch twice', () => {
    const one = [{ epoch: 0, secret: generateSecretKey() }];
    const two = withEpoch(one, { epoch: 1, secret: generateSecretKey() });
    assert.equal(two.length, 2);
    // Two live sessions on one group both adopt the same rotation.
    assert.equal(withEpoch(two, { epoch: 1, secret: generateSecretKey() }), two);
  });
});

describe('pairwise sealing', () => {
  it('agrees on a shared key from either side', () => {
    const a = generateSecretKey();
    const b = generateSecretKey();
    assert.ok(conversationKey(a, getPublicKey(b)).equals(conversationKey(b, getPublicKey(a))));
    assert.ok(!conversationKey(a, getPublicKey(b)).equals(conversationKey(a, getPublicKey(generateSecretKey()))));
  });

  it('agrees across point parities, not just on average', () => {
    // conversationKey discards the parity byte of the ECDH product on
    // purpose: a lifted x-only pubkey may be the *negation* of the owner's
    // real point, but negation leaves the x coordinate unchanged, so both
    // sides still land on the same 32 bytes. If that subarray(1, 33) is ever
    // "simplified" to the whole compressed point, only pairs whose points
    // share a parity keep agreeing — a per-pair coin flip that fails
    // silently in production. A single random pair only catches that half
    // the time, so pin the mixed-parity case deterministically, then sweep.
    const parityOf = (secretHex: string): number =>
      ecc.pointFromScalar(Buffer.from(secretHex, 'hex'), true)![0] & 1;

    const keys: string[] = [generateSecretKey()];
    while (keys.length < 2) {
      const candidate = generateSecretKey();
      if (parityOf(candidate) !== parityOf(keys[0])) keys.push(candidate);
    }
    const [even, odd] = keys;
    assert.ok(conversationKey(even, getPublicKey(odd)).equals(conversationKey(odd, getPublicKey(even))));

    let mixed = 0;
    for (let i = 0; i < 200; i++) {
      const a = generateSecretKey();
      const b = generateSecretKey();
      if (parityOf(a) !== parityOf(b)) mixed++;
      assert.ok(conversationKey(a, getPublicKey(b)).equals(conversationKey(b, getPublicKey(a))));
    }
    // ~half of all pairs are mixed-parity; this just proves the sweep above
    // actually exercised the case it exists for.
    assert.ok(mixed > 50, `only ${mixed}/200 mixed-parity pairs — sweep is not covering the parity split`);
  });

  it('round-trips a rekey and refuses everyone else', () => {
    const coordinator = generateSecretKey();
    const member = generateSecretKey();
    const outsider = generateSecretKey();
    const rekey = {
      type: 'rekey' as const,
      epoch: 1,
      secret: generateSecretKey(),
      members: [getPublicKey(member)],
    };
    const envelope = sealTo(coordinator, getPublicKey(member), encodeRekey(rekey));
    assert.deepEqual(decodeRekey(openFrom(member, getPublicKey(coordinator), envelope)), rekey);
    assert.throws(() => openFrom(outsider, getPublicKey(coordinator), envelope));
  });

  it('seals one epoch to several members without any of them opening another copy', () => {
    const coordinator = generateSecretKey();
    const members = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
    const secret = generateSecretKey();
    const body = encodeRekey({ type: 'rekey', epoch: 1, secret, members: members.map(getPublicKey) });
    const envelopes = members.map((m) => sealTo(coordinator, getPublicKey(m), body));

    members.forEach((me, mine) => {
      envelopes.forEach((envelope, i) => {
        if (i === mine) {
          assert.equal(decodeRekey(openFrom(me, getPublicKey(coordinator), envelope)).secret, secret);
        } else {
          assert.throws(() => openFrom(me, getPublicKey(coordinator), envelope));
        }
      });
    });
  });

  it('rejects a malformed rekey', () => {
    const ok = 'a'.repeat(64);
    assert.throws(() => decodeRekey(JSON.stringify({ type: 'chat' })), /not a rekey/i);
    // Epoch 0 is the invite; a rekey can never claim it.
    assert.throws(() => decodeRekey(JSON.stringify({ type: 'rekey', epoch: 0, secret: ok, members: [] })), /epoch/i);
    assert.throws(() => decodeRekey(JSON.stringify({ type: 'rekey', epoch: 1, secret: 'nope', members: [] })), /secret/i);
  });
});

describe('group key rotation', () => {
  /** A coordinator and a member sharing an invite secret, both rotation-aware. */
  function rotatingPair(relay: ReturnType<typeof makeFakeRelay>) {
    const secret = generateSecretKey();
    const coordinatorSk = nostrSecretForGroup(MNEMONICS[0], secret);
    const memberSk = nostrSecretForGroup(MNEMONICS[1], secret);
    const coordinatorPubkey = getPublicKey(coordinatorSk);
    const make = (identitySecret: string) =>
      new GroupSession({
        epochs: [{ epoch: 0, secret }],
        relays: ['wss://fake'],
        identitySecret,
        coordinatorPubkey,
        rotation: true,
        socketFactory: relay.factory,
      });
    return {
      secret,
      coordinatorSk,
      coordinatorPubkey,
      coordinator: make(coordinatorSk),
      member: make(memberSk),
    };
  }

  it('moves the group onto a key the invite cannot read', async () => {
    const relay = makeFakeRelay();
    const { secret, coordinator, member } = rotatingPair(relay);
    const coordinatorSeen: any[] = [];
    coordinator.start({ onMessage: (m) => coordinatorSeen.push(m) });
    member.start({ onMessage: () => {} });
    await tick();

    member.send({ type: 'join', name: 'Alice', rekey: true });
    await tick();

    const adopted = coordinator.rotate([coordinator.pubkey, member.pubkey]);
    await tick();

    assert.equal(adopted.epoch, 1);
    assert.equal(coordinator.epoch, 1);
    assert.equal(member.epoch, 1, 'the member must adopt the sealed epoch');
    assert.equal(coordinator.channel, member.channel, 'both moved to the same new channel');
    assert.notEqual(coordinator.channel, channelId(secret), 'the channel moved off the invite');

    // The whole point of waiting: the xpub travels under the rotated key.
    const expression = keyExpression({
      fingerprint: masterFingerprint(MNEMONICS[1]),
      path: bip48Path('mainnet'),
      xpub: accountXpub(MNEMONICS[1], 'mainnet'),
    });
    member.send({ type: 'key', name: 'Alice', keyExpression: expression });
    await tick();
    const received = coordinatorSeen.find((m) => m.message.type === 'key');
    assert.ok(received, 'the coordinator did not receive the key');
    assert.equal(received.epoch, 1);

    // THE LOAD-BEARING CASE. Someone who obtains the invite link later holds
    // the epoch-0 secret and can fetch the entire retained transcript. All it
    // should ever open is the handshake.
    const published = relay.log.filter((m) => m[0] === 'EVENT').map((m) => m[1]);
    assert.ok(published.length > 0);
    const readable = published
      .map((e: any) => {
        try {
          return JSON.parse(decryptPayload(secret, e.content)).type;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    assert.deepEqual([...new Set(readable)].sort(), ['join', 'rekey-notice']);
  });

  it('keeps identities pinned across a rotation', async () => {
    const relay = makeFakeRelay();
    const { coordinator, coordinatorPubkey, member } = rotatingPair(relay);
    coordinator.start({ onMessage: () => {} });
    member.start({ onMessage: () => {} });
    await tick();

    const before = [coordinator.pubkey, member.pubkey];
    coordinator.rotate(before);
    await tick();

    assert.equal(member.epoch, 1);
    assert.deepEqual([coordinator.pubkey, member.pubkey], before);
    // Group.coordinatorPubkey is pinned from the invite and is the only thing
    // stopping an invite-holder pushing a malicious wallet. It would be void
    // across the boundary if identities moved with the epoch.
    assert.equal(coordinator.pubkey, coordinatorPubkey);
  });

  it('ignores a rotation from anyone but the pinned coordinator', async () => {
    const relay = makeFakeRelay();
    const { secret, coordinatorPubkey, member } = rotatingPair(relay);
    // Someone holding the invite, but not the coordinator, tries to move the
    // group onto a key of their own.
    const impostor = new GroupSession({
      epochs: [{ epoch: 0, secret }],
      relays: ['wss://fake'],
      identitySecret: generateSecretKey(),
      coordinatorPubkey,
      rotation: true,
      socketFactory: relay.factory,
    });
    member.start({ onMessage: () => {} });
    impostor.start({ onMessage: () => {} });
    await tick();

    impostor.rotate([member.pubkey, impostor.pubkey]);
    await tick();
    assert.equal(member.epoch, 0, 'the member must not follow an unpinned rotation');
  });

  it('never goes backwards to an earlier epoch', async () => {
    const relay = makeFakeRelay();
    const { secret, coordinatorSk, coordinator, member } = rotatingPair(relay);
    coordinator.start({ onMessage: () => {} });
    member.start({ onMessage: () => {} });
    await tick();

    coordinator.rotate([coordinator.pubkey, member.pubkey]);
    await tick();
    coordinator.rotate([coordinator.pubkey, member.pubkey]);
    await tick();
    assert.equal(member.epoch, 2);

    // A freshly signed envelope replaying epoch 1 — genuinely from the
    // coordinator, so only the epoch check can reject it.
    const stale = signEvent(coordinatorSk, {
      created_at: Math.floor(Date.now() / 1000),
      kind: REKEY_EVENT_KIND,
      tags: [['t', channelId(secret)]],
      content: sealTo(
        coordinatorSk,
        member.pubkey,
        encodeRekey({ type: 'rekey', epoch: 1, secret: generateSecretKey(), members: [] })
      ),
    });
    relay.sockets[0].send(JSON.stringify(['EVENT', stale]));
    await tick();
    assert.equal(member.epoch, 2, 'a replayed earlier epoch must be ignored');
  });

  it('hears the lobby after rotating, and seals a returning member back in', async () => {
    const relay = makeFakeRelay();
    const { coordinator, member } = rotatingPair(relay);
    const coordinatorSeen: any[] = [];
    coordinator.start({ onMessage: (m) => coordinatorSeen.push(m) });
    await tick();

    // Rotate before the member is listening: it is the phone that was off, or
    // was restored from a backup and holds only the invite.
    coordinator.rotate([coordinator.pubkey]);
    await tick();
    assert.equal(coordinator.epoch, 1);

    member.start({ onMessage: () => {} });
    await tick();
    member.send({ type: 'join', name: 'Alice', rekey: true });
    await tick();

    const join = coordinatorSeen.find((m) => m.message.type === 'join' && !m.mine);
    assert.ok(join, 'the coordinator must still hear the lobby after rotating');
    assert.equal(join.epoch, 0);
    assert.equal(member.epoch, 0);

    // A reinstalled member derives the same pubkey from seed + invite, so the
    // coordinator recognises them and can seal them back in.
    coordinator.reseal(member.pubkey, [coordinator.pubkey, member.pubkey]);
    await tick();
    assert.equal(member.epoch, 1, 'the returning member should be back on the current epoch');
    assert.equal(member.channel, coordinator.channel);
  });

  it('refuses to put keys or transactions on the invite key', async () => {
    const relay = makeFakeRelay();
    const { coordinator } = rotatingPair(relay);
    coordinator.start({ onMessage: () => {} });
    await tick();

    assert.throws(() => coordinator.send({ type: 'key', name: 'Rob', keyExpression: 'x' }), /not secured/i);
    assert.throws(() => coordinator.send({ type: 'psbt', base64: 'x' }), /not secured/i);
    assert.throws(() => coordinator.send({ type: 'wallet', name: 'V', descriptor: 'x' }), /not secured/i);
    // Announcing yourself is exactly what epoch 0 is for.
    assert.doesNotThrow(() => coordinator.send({ type: 'join', name: 'Rob', rekey: true }));

    coordinator.rotate([coordinator.pubkey]);
    assert.doesNotThrow(() => coordinator.send({ type: 'key', name: 'Rob', keyExpression: 'x' }));
  });

  /**
   * Someone who obtained the invite link. They cannot read the rotated
   * channel, but they hold the epoch-0 secret, and nothing stops them writing
   * to the lobby under a Nostr identity of their own — straight onto the
   * wire, past GroupSession and its send guard.
   */
  function intruderOn(relay: ReturnType<typeof makeFakeRelay>, secret: string) {
    const identity = generateSecretKey();
    const wire = relay.factory();
    return {
      pubkey: getPublicKey(identity),
      inject(message: GroupMessage) {
        const event = signEvent(identity, {
          created_at: Math.floor(Date.now() / 1000),
          kind: GROUP_EVENT_KIND,
          tags: [['t', channelId(secret)]],
          content: encryptPayload(secret, encodeMessage(message)),
        });
        wire.send(JSON.stringify(['EVENT', event]));
      },
    };
  }

  const SEALED_ONLY: GroupMessage[] = [
    { type: 'key', name: 'Rob', keyExpression: 'x' },
    { type: 'selection', xpubs: ['x'] },
    { type: 'wallet', name: 'V', descriptor: 'x' },
    { type: 'wallet-reply', name: 'Alice', descriptor: 'x', accepted: true },
    { type: 'psbt', base64: 'x', memo: 'pay me' },
    { type: 'psbt-ack', txid: 'a'.repeat(64) },
    { type: 'broadcast', txid: 'a'.repeat(64) },
  ];

  it('ignores keys and transactions that arrive on the invite key once rotated', async () => {
    const relay = makeFakeRelay();
    const { secret, coordinator, member } = rotatingPair(relay);
    const coordinatorSeen: ReceivedMessage[] = [];
    const memberSeen: ReceivedMessage[] = [];
    coordinator.start({ onMessage: (m) => coordinatorSeen.push(m) });
    member.start({ onMessage: (m) => memberSeen.push(m) });
    await tick();
    member.send({ type: 'join', name: 'Alice', rekey: true });
    await tick();
    coordinator.rotate([coordinator.pubkey, member.pubkey]);
    await tick();
    assert.equal(coordinator.epoch, 1);
    assert.equal(member.epoch, 1);

    const intruder = intruderOn(relay, secret);
    for (const message of SEALED_ONLY) intruder.inject(message);
    // Announcing yourself is what the lobby is for: a join must still arrive.
    intruder.inject({ type: 'join', name: 'Mallory', rekey: true });
    await tick();

    for (const [who, seen] of [
      ['coordinator', coordinatorSeen],
      ['member', memberSeen],
    ] as const) {
      const fromIntruder = seen.filter((m) => m.author === intruder.pubkey);
      assert.deepEqual(
        fromIntruder.map((m) => m.message.type),
        ['join'],
        `the ${who} must hear nothing but the join from the lobby`
      );
      assert.ok(
        seen.every((m) => m.epoch !== 0 || !needsRotation(m.message.type)),
        `the ${who} delivered something sealed-only under epoch 0`
      );
    }
  });

  it('ignores keys and transactions on the invite key before rotating too', async () => {
    // The roster is still open, so a legitimate member would be refused by
    // the send guard — anything of these types under epoch 0 is an intruder's.
    const relay = makeFakeRelay();
    const { secret, coordinator } = rotatingPair(relay);
    const seen: ReceivedMessage[] = [];
    coordinator.start({ onMessage: (m) => seen.push(m) });
    await tick();
    assert.equal(coordinator.epoch, 0);

    const intruder = intruderOn(relay, secret);
    for (const message of SEALED_ONLY) intruder.inject(message);
    intruder.inject({ type: 'chat', name: 'Mallory', text: 'hello' });
    await tick();

    const fromIntruder = seen.filter((m) => m.author === intruder.pubkey).map((m) => m.message.type);
    assert.deepEqual(fromIntruder, ['chat']);
  });

  it('never adopts, and never issues, an epoch at the ceiling', async () => {
    const relay = makeFakeRelay();
    const { secret, coordinatorSk, coordinatorPubkey, coordinator, member } = rotatingPair(relay);
    coordinator.start({ onMessage: () => {} });
    member.start({ onMessage: () => {} });
    await tick();
    coordinator.rotate([coordinator.pubkey, member.pubkey]);
    await tick();
    assert.equal(member.epoch, 1);

    // Genuinely the coordinator's, so only the bound can reject it.
    const ceiling = signEvent(coordinatorSk, {
      created_at: Math.floor(Date.now() / 1000),
      kind: REKEY_EVENT_KIND,
      tags: [['t', channelId(secret)]],
      content: sealTo(
        coordinatorSk,
        member.pubkey,
        encodeRekey({ type: 'rekey', epoch: MAX_EPOCH, secret: generateSecretKey(), members: [] })
      ),
    });
    relay.sockets[0].send(JSON.stringify(['EVENT', ceiling]));
    await tick();
    assert.equal(member.epoch, 1, 'an epoch at MAX_EPOCH must not be adopted');

    // A coordinator restored onto an absurd epoch cannot climb past it either.
    const high = new GroupSession({
      epochs: [
        { epoch: 0, secret },
        { epoch: MAX_EPOCH - 1, secret: generateSecretKey() },
      ],
      relays: ['wss://fake'],
      identitySecret: coordinatorSk,
      coordinatorPubkey,
      rotation: true,
      socketFactory: relay.factory,
    });
    assert.throws(() => high.rotate([high.pubkey]), /run out of key numbers/i);
    assert.throws(() => coordinator.rotate([coordinator.pubkey], MAX_EPOCH), /impossible key number/i);
  });

  it('reads an event only under the key its channel tag names', async () => {
    const relay = makeFakeRelay();
    const { secret, coordinator, member } = rotatingPair(relay);
    const seen: ReceivedMessage[] = [];
    coordinator.start({ onMessage: (m) => seen.push(m) });
    member.start({ onMessage: () => {} });
    await tick();
    const adopted = coordinator.rotate([coordinator.pubkey, member.pubkey]);
    await tick();

    // Encrypted under the rotated key but tagged for the lobby. Trying every
    // key we hold on every event would be work done for whoever floods the
    // channel; the tag says which one, and only that one is tried.
    const identity = generateSecretKey();
    const wire = relay.factory();
    const publish = (tag: string) => {
      const event = signEvent(identity, {
        created_at: Math.floor(Date.now() / 1000),
        kind: GROUP_EVENT_KIND,
        tags: [['t', tag]],
        content: encryptPayload(adopted.secret, encodeMessage({ type: 'chat', name: 'Mallory', text: 'hi' })),
      });
      wire.send(JSON.stringify(['EVENT', event]));
    };
    publish(channelId(secret));
    await tick();
    assert.equal(seen.filter((m) => m.author === getPublicKey(identity)).length, 0, 'wrong tag: not read');
    publish(channelId(adopted.secret));
    await tick();
    assert.equal(seen.filter((m) => m.author === getPublicKey(identity)).length, 1, 'right tag: read');
  });

  it('refuses to send what nobody would accept', async () => {
    const relay = makeFakeRelay();
    const { coordinator } = rotatingPair(relay);
    coordinator.start({ onMessage: () => {} });
    await tick();
    assert.throws(
      () => coordinator.send({ type: 'chat', name: 'Rob', text: 'x'.repeat(MAX_CHAT_CHARS + 1) }),
      /message is too long/i
    );
    assert.throws(() => coordinator.send({ type: 'join', name: 'x'.repeat(MAX_NAME_CHARS + 1) }), /name is too long/i);
    assert.throws(() => coordinator.send({ type: 'broadcast', txid: 'nope' } as GroupMessage), /malformed broadcast/i);
    assert.equal(relay.events().length, 0, 'nothing reached the wire');
    assert.doesNotThrow(() => coordinator.send({ type: 'chat', name: 'Rob', text: 'x'.repeat(MAX_CHAT_CHARS) }));
  });

  it('leaves groups from before rotation working as they were', async () => {
    const relay = makeFakeRelay();
    const secret = generateSecretKey();
    // No rotation flag: an invite from a build that predates all of this.
    const legacy = new GroupSession({
      epochs: [{ epoch: 0, secret }],
      relays: ['wss://fake'],
      identitySecret: nostrSecretForGroup(MNEMONICS[0], secret),
      socketFactory: relay.factory,
    });
    const seen: ReceivedMessage[] = [];
    legacy.start({ onMessage: (m) => seen.push(m) });
    await tick();
    assert.equal(legacy.epoch, 0);
    assert.doesNotThrow(() => legacy.send({ type: 'key', name: 'Rob', keyExpression: 'x' }));

    // Everything a pre-rotation group has lives on epoch 0, so the receive
    // guard must stay out of the way: another member's key still arrives.
    const peer = intruderOn(relay, secret);
    peer.inject({ type: 'key', name: 'Alice', keyExpression: 'y' });
    await tick();
    const received = seen.find((m) => m.author === peer.pubkey);
    assert.equal(received?.message.type, 'key');
    assert.equal(received?.epoch, 0);
  });

  it('needs its epoch-0 secret to run at all', () => {
    assert.throws(
      () =>
        new GroupSession({
          epochs: [{ epoch: 1, secret: generateSecretKey() }],
          relays: ['wss://fake'],
          identitySecret: generateSecretKey(),
        }),
      /epoch-0/i
    );
  });

  /**
   * A rekey sealed to `recipient` by someone who is not the coordinator. Any
   * invite-holder can build one: the lobby tag is derived from the invite, and
   * the recipient's pubkey is published on it in the clear.
   */
  function hostileRekey(inviteSecret: string, recipient: string) {
    const attacker = generateSecretKey();
    return signEvent(attacker, {
      created_at: Math.floor(Date.now() / 1000),
      kind: REKEY_EVENT_KIND,
      tags: [['t', channelId(inviteSecret)]],
      content: sealTo(
        attacker,
        recipient,
        encodeRekey({ type: 'rekey', epoch: 1, secret: generateSecretKey(), members: [] })
      ),
    });
  }

  it('never lets a group from before rotation be moved off epoch 0', async () => {
    const relay = makeFakeRelay();
    const secret = generateSecretKey();
    const memberSk = nostrSecretForGroup(MNEMONICS[1], secret);
    // An invite that predates all of this: no k=1, and — because it also
    // predates coordinator pinning — no coordinator pubkey to check against.
    const legacy = new GroupSession({
      epochs: [{ epoch: 0, secret }],
      relays: ['wss://fake'],
      identitySecret: memberSk,
      socketFactory: relay.factory,
    });
    legacy.start({ onMessage: () => {} });
    await tick();

    relay.factory().send(JSON.stringify(['EVENT', hostileRekey(secret, getPublicKey(memberSk))]));
    await tick();

    assert.equal(legacy.epoch, 0, 'a pre-rotation group must stay on the invite key for good');
    // And it cannot be talked into rotating itself off the channel either.
    assert.throws(() => legacy.rotate([getPublicKey(memberSk)]), /before key rotation/i);
  });

  it('refuses a rotation when no coordinator is pinned to check it against', async () => {
    const relay = makeFakeRelay();
    const secret = generateSecretKey();
    const memberSk = nostrSecretForGroup(MNEMONICS[1], secret);
    // Rotation on but the pin missing — every real rotating invite carries
    // `c=`, so this means something is wrong and the author is unauthenticated.
    const unpinned = new GroupSession({
      epochs: [{ epoch: 0, secret }],
      relays: ['wss://fake'],
      identitySecret: memberSk,
      rotation: true,
      socketFactory: relay.factory,
    });
    unpinned.start({ onMessage: () => {} });
    await tick();

    relay.factory().send(JSON.stringify(['EVENT', hostileRekey(secret, getPublicKey(memberSk))]));
    await tick();

    assert.equal(unpinned.epoch, 0, 'an unauthenticated rotation must never be adopted');
  });
});

// --- Recovery after a lost phone (RECOVERY-DESIGN.md) -----------------------

/**
 * Moves Date.now forward. A knock is told apart from a join sent before the
 * rotation by when it was sent, and events carry whole seconds.
 */
function fakeClock() {
  const real = Date.now;
  let offset = 0;
  Date.now = () => real() + offset;
  return {
    advance: (ms: number) => {
      offset += ms;
    },
    restore: () => {
      Date.now = real;
    },
  };
}

describe('group recovery — who to answer', () => {
  const C = 'c'.repeat(64);
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const X = 'e'.repeat(64);
  let n = 0;
  const msg = (author: string, at: number, message: GroupMessage, epoch = 0): ReceivedMessage => ({
    id: `m${n++}`,
    author,
    mine: false,
    at,
    epoch,
    message,
  });
  const join = (name: string, extra: { epoch?: number } = {}): GroupMessage => ({ type: 'join', name, rekey: true, ...extra });
  const coordinatorRecord = {
    coordinator: true,
    coordinatorPubkey: C,
    rekey: true,
    currentEpoch: 1,
    currentEpochAt: 1000,
    roster: [C, A, B],
  };
  const memberRecord = { coordinator: false, coordinatorPubkey: C, rekey: true, currentEpoch: 1, currentEpochAt: 1000 };

  it('reseals a roster member who knocks after the epoch began, once', () => {
    const messages = [
      msg(A, 500, join('Alice')), // before the rotation: the original join
      msg(A, 2000, join('Alice')),
      msg(A, 3000, join('Alice')), // knocked twice: the newest counts
      msg(X, 2000, join('Mallory')), // not on the roster — a latecomer is a decision
      msg(B, 2000, join('Bob', { epoch: 1 })), // answering a lost coordinator: holds the key
      msg(B, 2500, join('Bob'), 1), // on the current epoch, so not locked out
    ];
    const now = 10_000;
    assert.deepEqual(knocksToReseal(messages, coordinatorRecord, 1, now), [{ author: A, at: 3000 }]);
    assert.deepEqual(knocksToReseal(messages, { ...coordinatorRecord, resealed: { [A]: 3000 } }, 1, now), []);
    assert.deepEqual(
      knocksToReseal(messages, { ...coordinatorRecord, currentEpochAt: undefined }, 1, now),
      [],
      'with no known start, every pre-rotation join would look like a knock'
    );
    assert.deepEqual(knocksToReseal(messages, coordinatorRecord, 0, now), []);
    assert.deepEqual(knocksToReseal(messages, memberRecord, 1, now), [], 'only the coordinator reseals');
  });

  it('answers a member at most once per grace, however many knocks they publish', () => {
    // A knock's time is the knocker's: answered once, a member could re-date
    // the knock forever and have an envelope published for every copy.
    const answeredAt = 5000;
    const answered = { ...coordinatorRecord, resealed: { [A]: 2000 }, resealedAt: { [A]: answeredAt } };
    const again = [msg(A, 2000, join('Alice')), msg(A, 2001, join('Alice'))];
    assert.deepEqual(knocksToReseal(again, answered, 1, answeredAt + RESEAL_GRACE_MS - 1), [], 'a newer knock inside the grace waits');
    assert.deepEqual(
      knocksToReseal(again, answered, 1, answeredAt + RESEAL_GRACE_MS),
      [{ author: A, at: 2001 }],
      'and is answered when the grace ends'
    );
    const future = [msg(A, 9_999_999, join('Alice'))];
    assert.deepEqual(knocksToReseal(future, answered, 1, answeredAt + 1), [], 'a knock dated in the future is no exception');
    assert.deepEqual(
      knocksToReseal([msg(B, 2000, join('Bob'))], answered, 1, answeredAt + 1),
      [{ author: B, at: 2000 }],
      'the grace is per member'
    );
  });

  it('answers a coordinator that knocks after the epoch began, once', () => {
    const original = msg(C, 500, join('Coordinator'));
    assert.equal(coordinatorKnock([original], memberRecord, 1), null, 'its pre-rotation join is no knock');
    const knock = msg(C, 2000, join('Coordinator'));
    assert.equal(coordinatorKnock([original, knock], memberRecord, 1), 2000);
    assert.equal(coordinatorKnock([knock], { ...memberRecord, answeredCoordinatorAt: 2000 }, 1), null);
    assert.equal(coordinatorKnock([msg(A, 2000, join('Alice'))], memberRecord, 1), null, 'only the pinned coordinator');
    assert.equal(coordinatorKnock([knock], memberRecord, 0), null, 'nothing to tell without the key');
    assert.equal(coordinatorKnock([knock], { ...memberRecord, coordinator: true }, 1), null);
  });

  it('finds the epoch to re-secure above, believing only sensible numbers', () => {
    const lost = { coordinator: true, coordinatorPubkey: C, rekey: true, currentEpoch: 0 };
    const roster = [C, A, B];
    assert.equal(epochFloor([], lost, roster), 0);
    assert.equal(heardFromMembers([], roster), false);
    const heard = [
      msg(A, 1, join('Alice', { epoch: 3 })),
      msg(B, 1, join('Bob', { epoch: 2 })),
      msg(X, 1, join('Mallory', { epoch: MAX_EPOCH })),
      msg(X, 1, join('Mallory', { epoch: 2.5 })),
      msg(A, 1, { type: 'rekey-notice', epoch: 9 }), // not the coordinator's notice
      msg(C, 1, { type: 'rekey-notice', epoch: 1 }),
    ];
    assert.equal(epochFloor(heard, lost, roster), 3);
    assert.equal(heardFromMembers(heard, roster), true);
    assert.equal(reportedEpoch(msg(A, 1, join('Alice', { epoch: 0 }))), null);
  });

  it('believes an epoch only from someone about to be sealed in', () => {
    // Anyone holding the invite can answer on the lobby. A stranger claiming
    // a huge epoch would otherwise burn the group's numbering to the ceiling.
    const lost = { coordinator: true, coordinatorPubkey: C, rekey: true, currentEpoch: 0 };
    const stranger = [msg(X, 1, join('Mallory', { epoch: MAX_EPOCH - 1 }))];
    assert.equal(epochFloor(stranger, lost, [C, A, B]), 0, 'not on the roster: ignored');
    assert.equal(heardFromMembers(stranger, [C, A, B]), false, 'and does not count as an answer');
    assert.equal(epochFloor([msg(A, 1, join('Alice', { epoch: 4 })), ...stranger], lost, [C, A, B]), 4);
    assert.equal(heardFromMembers(stranger, [X]), true, 'the coordinator can still choose to trust them');
  });

  it('believes no jump a real group could make', () => {
    const lost = { coordinator: true, coordinatorPubkey: C, rekey: true, currentEpoch: 5 };
    const claim = (epoch: number) => [msg(A, 1, join('Alice', { epoch }))];
    assert.equal(epochFloor(claim(5 + MAX_EPOCH_JUMP), lost, [A]), 5 + MAX_EPOCH_JUMP, 'at the bound');
    assert.equal(epochFloor(claim(5 + MAX_EPOCH_JUMP + 1), lost, [A]), 5, 'past it: a roster member gone wrong');
    assert.equal(epochFloor([msg(C, 1, { type: 'rekey-notice', epoch: 5 + MAX_EPOCH_JUMP + 1 })], lost, [A]), 5);
    assert.equal(epochFloor(claim(MAX_EPOCH - 1), { ...lost, currentEpoch: MAX_EPOCH - 1 }, [A]), MAX_EPOCH - 1);
  });
});

describe('group recovery over a relay', () => {
  function setupGroup(relay: ReturnType<typeof makeFakeRelay>) {
    const secret = generateSecretKey();
    const coordinatorPubkey = getPublicKey(nostrSecretForGroup(MNEMONICS[0], secret));
    // A phone holding a seed and the invite — and, unless told otherwise, nothing else.
    const phone = (mnemonic: string) =>
      new GroupSession({
        epochs: [{ epoch: 0, secret }],
        relays: ['wss://fake'],
        identitySecret: nostrSecretForGroup(mnemonic, secret),
        coordinatorPubkey,
        rotation: true,
        socketFactory: relay.factory,
      });
    return { secret, coordinatorPubkey, phone };
  }

  function listen(session: GroupSession) {
    const seen: ReceivedMessage[] = [];
    const adopted: AdoptedEpoch[] = [];
    session.start({ onMessage: (m) => seen.push(m), onRekey: (e) => adopted.push(e) });
    return { seen, adopted };
  }

  it('recognises the coordinator by its seed alone', () => {
    const secret = generateSecretKey();
    const pinned = getPublicKey(nostrSecretForGroup(MNEMONICS[0], secret));
    assert.equal(isCoordinatorSeed(MNEMONICS[0], secret, pinned), true);
    assert.equal(isCoordinatorSeed(MNEMONICS[1], secret, pinned), false);
    assert.equal(isCoordinatorSeed(MNEMONICS[0], generateSecretKey(), pinned), false, 'another group');
    assert.equal(isCoordinatorSeed(MNEMONICS[0], secret, undefined), false);
  });

  it('brings a restored coordinator and member back from their own sealed copies', async () => {
    const relay = makeFakeRelay({ retain: true });
    const { phone } = setupGroup(relay);
    const coordinator = phone(MNEMONICS[0]);
    const member = phone(MNEMONICS[1]);
    listen(coordinator);
    listen(member);
    await tick();
    member.send({ type: 'join', name: 'Alice', rekey: true });
    await tick();
    const roster = [coordinator.pubkey, member.pubkey];
    coordinator.rotate(roster);
    await tick();
    assert.equal(member.epoch, 1);
    coordinator.stop();
    member.stop();

    // New phones: the same seeds and the invite from the backup.
    const restoredCoordinator = phone(MNEMONICS[0]);
    const restoredMember = phone(MNEMONICS[1]);
    const c = listen(restoredCoordinator);
    const m = listen(restoredMember);
    await tick();
    assert.equal(restoredCoordinator.epoch, 1, 'the coordinator sealed a copy to itself');
    assert.equal(restoredMember.epoch, 1);
    assert.deepEqual([...c.adopted[0].members].sort(), [...roster].sort(), 'the roster comes back with it');
    assert.equal(m.adopted[0].at % 1000, 0, "the epoch's start is the envelope's time");
    assert.equal(restoredMember.channel, restoredCoordinator.channel);
  });

  it('reseals a member whose envelope the relays dropped, when they knock', async () => {
    const clock = fakeClock();
    try {
      const relay = makeFakeRelay({ retain: true });
      const { phone, coordinatorPubkey } = setupGroup(relay);
      const coordinator = phone(MNEMONICS[0]);
      const member = phone(MNEMONICS[1]);
      const c = listen(coordinator);
      listen(member);
      await tick();
      member.send({ type: 'join', name: 'Alice', rekey: true });
      await tick();
      const rotated = coordinator.rotate([coordinator.pubkey, member.pubkey]);
      await tick();
      member.stop();
      relay.prune((e) => e.kind === REKEY_EVENT_KIND);
      clock.advance(10_000);

      const restored = phone(MNEMONICS[1]);
      const stranger = phone(MNEMONICS[2]);
      listen(restored);
      listen(stranger);
      await tick();
      assert.equal(restored.epoch, 0, 'its envelope is gone');
      restored.send({ type: 'join', name: 'Alice', rekey: true }); // on the lobby: a knock
      stranger.send({ type: 'join', name: 'Mallory', rekey: true });
      await tick();

      const record = {
        coordinator: true,
        coordinatorPubkey,
        rekey: true,
        currentEpoch: rotated.epoch,
        currentEpochAt: rotated.at,
        roster: rotated.members,
      };
      const knocks = knocksToReseal(c.seen, record, coordinator.epoch, Date.now());
      assert.deepEqual(
        knocks.map((k) => k.author),
        [restored.pubkey],
        'the same seed and invite give the same pubkey; the stranger is a latecomer'
      );
      for (const k of knocks) coordinator.reseal(k.author, rotated.members);
      await tick();
      assert.equal(restored.epoch, 1);
      assert.equal(stranger.epoch, 0);
      assert.deepEqual(
        knocksToReseal(c.seen, { ...record, resealed: { [restored.pubkey]: knocks[0].at } }, 1, Date.now()),
        []
      );
    } finally {
      clock.restore();
    }
  });

  it("re-secures a group whose coordinator lost its copy, above the members' epoch", async () => {
    const clock = fakeClock();
    try {
      const relay = makeFakeRelay({ retain: true });
      const { phone, coordinatorPubkey } = setupGroup(relay);
      const coordinator = phone(MNEMONICS[0]);
      const member = phone(MNEMONICS[1]);
      listen(coordinator);
      const m = listen(member);
      await tick();
      member.send({ type: 'join', name: 'Alice', rekey: true });
      await tick();
      coordinator.rotate([coordinator.pubkey, member.pubkey]);
      await tick();
      coordinator.rotate([coordinator.pubkey, member.pubkey]);
      await tick();
      assert.equal(member.epoch, 2);
      const memberRecord = {
        coordinator: false,
        coordinatorPubkey,
        rekey: true,
        currentEpoch: 2,
        currentEpochAt: m.adopted[m.adopted.length - 1].at,
      };
      coordinator.stop();
      relay.prune((e) => e.kind === REKEY_EVENT_KIND);
      clock.advance(10_000);

      const restored = phone(MNEMONICS[0]);
      const c = listen(restored);
      await tick();
      assert.equal(restored.epoch, 0, 'its own copy is gone');
      restored.send({ type: 'join', name: 'Coordinator', rekey: true }); // the knock
      await tick();

      // The member's app hears it and says which epoch the group is on.
      const knockAt = coordinatorKnock(m.seen, memberRecord, member.epoch);
      assert.ok(knockAt, 'the member must recognise a coordinator that lost the key');
      member.announce({ type: 'join', name: 'Alice', rekey: true, epoch: member.epoch });
      await tick();
      assert.equal(coordinatorKnock(m.seen, { ...memberRecord, answeredCoordinatorAt: knockAt }, member.epoch), null);

      assert.equal(heardFromMembers(c.seen, [member.pubkey]), true);
      const floor = epochFloor(
        c.seen,
        { coordinator: true, coordinatorPubkey, rekey: true, currentEpoch: 0 },
        [restored.pubkey, member.pubkey]
      );
      assert.equal(floor, 2);
      const adopted = restored.rotate([restored.pubkey, member.pubkey], floor);
      await tick();
      assert.equal(adopted.epoch, 3);
      assert.equal(member.epoch, 3, 'the member follows, since the new epoch is above its own');
      assert.equal(member.channel, restored.channel);
    } finally {
      clock.restore();
    }
  });

  it('announces only a join, and always on the lobby', async () => {
    const relay = makeFakeRelay();
    const { phone, secret } = setupGroup(relay);
    const coordinator = phone(MNEMONICS[0]);
    const member = phone(MNEMONICS[1]);
    listen(coordinator);
    listen(member);
    await tick();
    coordinator.rotate([coordinator.pubkey, member.pubkey]);
    await tick();
    assert.equal(member.epoch, 1);

    member.announce({ type: 'join', name: 'Alice', rekey: true, epoch: 1 });
    const events = relay.log.filter((x) => x[0] === 'EVENT').map((x) => x[1]);
    const last = events[events.length - 1];
    assert.deepEqual(last.tags, [['t', channelId(secret)]]);
    assert.equal(JSON.parse(decryptPayload(secret, last.content)).epoch, 1);
    assert.throws(() => member.announce({ type: 'chat', name: 'Alice', text: 'hi' } as any), /Only a join/);
  });

  it('numbers a rotation above the floor it is given, and refuses an absurd one', async () => {
    const relay = makeFakeRelay();
    const { phone } = setupGroup(relay);
    const coordinator = phone(MNEMONICS[0]);
    listen(coordinator);
    await tick();
    assert.equal(coordinator.rotate([coordinator.pubkey], 5).epoch, 6);
    assert.equal(coordinator.rotate([coordinator.pubkey], 2).epoch, 7, 'never below its own epoch');
    for (const bad of [MAX_EPOCH, -1, 1.5, NaN]) {
      assert.throws(() => coordinator.rotate([coordinator.pubkey], bad), /impossible/);
    }
  });
});
