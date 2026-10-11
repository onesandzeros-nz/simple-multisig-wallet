import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { Buffer } from 'buffer';

/**
 * Anti-klepto (sign-to-contract): stops a device leaking its seed through the
 * signatures it makes.
 *
 * An ECDSA signer picks a secret nonce for every signature. A malicious or
 * buggy one can pick nonces that encode key material, which anyone who knows
 * the trick reads off the blockchain. Here the phone contributes randomness
 * the device cannot predict: the device first commits to its nonce, the phone
 * then reveals its own, and the signature must use the two combined — which
 * the phone checks before it accepts the signature.
 *
 * Reference: bitbox02-api-go, api/firmware/secp256k1.go
 */

export function taggedSha256(tag: string, message: Uint8Array): Buffer {
  const tagHash = sha256(Buffer.from(tag, 'ascii'));
  return Buffer.from(sha256(Buffer.concat([tagHash, tagHash, message])));
}

export function newHostNonce(): Buffer {
  const out = new Uint8Array(32);
  crypto.getRandomValues(out);
  return Buffer.from(out);
}

/** What the device is shown before it commits: a hash that hides our nonce. */
export function hostCommitment(hostNonce: Uint8Array): Buffer {
  if (hostNonce.length !== 32) throw new Error('A host nonce must be 32 bytes.');
  return taggedSha256('s2c/ecdsa/data', hostNonce);
}

/** A usable 64-byte signature: r and s in range, s in the lower half as Bitcoin requires. */
export function validateCompactSignature(signature: Uint8Array): void {
  if (signature.length !== 64) throw new Error('The BitBox02 returned a signature of the wrong size.');
  const n = secp256k1.CURVE.n;
  const r = BigInt('0x' + Buffer.from(signature.subarray(0, 32)).toString('hex'));
  const s = BigInt('0x' + Buffer.from(signature.subarray(32, 64)).toString('hex'));
  if (r === 0n || r >= n || s === 0n || s >= n) {
    throw new Error('The BitBox02 returned a signature that is not valid.');
  }
  if (s > n >> 1n) throw new Error('The BitBox02 returned a signature Bitcoin would reject (high S).');
}

/**
 * Checks that the signature's nonce is the one the device committed to,
 * tweaked by ours: R = commitment + H(commitment ‖ host nonce)·G, and r = R.x.
 */
export function verifyAntiklepto(hostNonce: Uint8Array, signerCommitment: Uint8Array, signature: Uint8Array): void {
  validateCompactSignature(signature);
  if (hostNonce.length !== 32) throw new Error('A host nonce must be 32 bytes.');
  const failure =
    'The BitBox02 did not use this phone’s randomness in its signature, so the signature was ' +
    'discarded. If this happens again, stop using the device and contact its manufacturer — it ' +
    'may be leaking its key.';
  let x: bigint;
  try {
    const commitment = secp256k1.ProjectivePoint.fromHex(Uint8Array.from(signerCommitment));
    const tweak =
      BigInt(
        '0x' +
          taggedSha256(
            's2c/ecdsa/point',
            Buffer.concat([Buffer.from(commitment.toRawBytes(true)), Buffer.from(hostNonce)])
          ).toString('hex')
      ) % secp256k1.CURVE.n;
    // A zero tweak cannot be multiplied; it would also mean the hash was zero.
    if (tweak === 0n) throw new Error(failure);
    x = commitment.add(secp256k1.ProjectivePoint.BASE.multiply(tweak)).toAffine().x % secp256k1.CURVE.n;
  } catch {
    throw new Error(failure);
  }
  const r = BigInt('0x' + Buffer.from(signature.subarray(0, 32)).toString('hex'));
  if (x !== r) throw new Error(failure);
}
