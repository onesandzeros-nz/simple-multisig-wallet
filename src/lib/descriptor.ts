/**
 * Output descriptor checksum, as implemented in Bitcoin Core
 * (doc/descriptors.md). Lets us emit descriptors that Sparrow,
 * Core, Specter etc. will accept verbatim.
 */

const INPUT_CHARSET =
  '0123456789()[],\'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#"\\ ';
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];

function polymod(symbols: number[]): bigint {
  let chk = 1n;
  for (const value of symbols) {
    const top = chk >> 35n;
    chk = ((chk & 0x7ffffffffn) << 5n) ^ BigInt(value);
    for (let i = 0; i < 5; i++) {
      if ((top >> BigInt(i)) & 1n) chk ^= GENERATOR[i];
    }
  }
  return chk;
}

export function descriptorChecksum(descriptor: string): string {
  const symbols: number[] = [];
  const groups: number[] = [];
  for (const ch of descriptor) {
    const pos = INPUT_CHARSET.indexOf(ch);
    if (pos === -1) throw new Error(`Invalid character in descriptor: ${ch}`);
    symbols.push(pos & 31);
    groups.push(pos >> 5);
    if (groups.length === 3) {
      symbols.push(groups[0] * 9 + groups[1] * 3 + groups[2]);
      groups.length = 0;
    }
  }
  if (groups.length === 1) symbols.push(groups[0]);
  else if (groups.length === 2) symbols.push(groups[0] * 3 + groups[1]);

  const chk = polymod([...symbols, 0, 0, 0, 0, 0, 0, 0, 0]) ^ 1n;
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += CHECKSUM_CHARSET[Number((chk >> (5n * (7n - BigInt(i)))) & 31n)];
  }
  return out;
}

export function withChecksum(descriptor: string): string {
  return `${descriptor}#${descriptorChecksum(descriptor)}`;
}
