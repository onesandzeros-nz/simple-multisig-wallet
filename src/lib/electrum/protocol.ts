import * as bitcoin from 'bitcoinjs-lib';
import { sha256 } from '@noble/hashes/sha256';
import { Buffer } from 'buffer';
import { btcNetwork } from '../bitcoin';
import { NetworkName } from '../types';

/**
 * Pure pieces of the Electrum protocol (as served by electrs, Fulcrum and
 * ElectrumX). Kept free of sockets so it can be unit tested in Node.
 *
 * Wire format: one JSON-RPC object per line, terminated by \n.
 */

export interface RpcRequest {
  id: number;
  method: string;
  params: unknown[];
}

export function encodeRequest(req: RpcRequest): string {
  return `${JSON.stringify({ jsonrpc: '2.0', ...req })}\n`;
}

export interface RpcResponse {
  id?: number;
  result?: any;
  error?: { code?: number; message?: string } | string;
  method?: string;
  params?: any;
}

/**
 * Splits a raw chunk into complete lines, returning the parsed messages and
 * whatever partial line is left over for the next chunk.
 */
export function feedLines(buffered: string, chunk: string): { messages: RpcResponse[]; rest: string } {
  const combined = buffered + chunk;
  const parts = combined.split('\n');
  const rest = parts.pop() ?? '';
  const messages: RpcResponse[] = [];
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed));
    } catch {
      // A malformed line is not worth killing the connection over.
    }
  }
  return { messages, rest };
}

/** Server errors arrive either as an object or a bare string. */
export function errorMessage(error: RpcResponse['error']): string {
  if (!error) return 'Unknown server error.';
  if (typeof error === 'string') return error;
  const code = error.code === undefined ? '' : ` (code ${error.code})`;
  return `${error.message ?? 'Server error'}${code}`;
}

/**
 * Electrum indexes by script hash: sha256 of the scriptPubKey, reversed.
 * Addresses never travel to the server, only these opaque hashes.
 */
export function addressToScripthash(address: string, network: NetworkName): string {
  const script = bitcoin.address.toOutputScript(address.trim(), btcNetwork(network));
  return Buffer.from(sha256(script)).reverse().toString('hex');
}

/**
 * Electrum reports fees in BTC per kilobyte; we work in sat/vB.
 * Rounded to three decimals so binary-float noise (1.0000000000000002)
 * never reaches the fee display or the builder.
 */
export function btcPerKbToSatPerVb(btcPerKb: number): number | null {
  if (!Number.isFinite(btcPerKb) || btcPerKb <= 0) return null;
  return Math.round(((btcPerKb * 1e8) / 1000) * 1000) / 1000;
}

/** Timestamp out of an 80-byte block header (little-endian at offset 68). */
export function headerTimestamp(headerHex: string): number {
  const header = Buffer.from(headerHex, 'hex');
  if (header.length < 80) throw new Error('Short block header from server.');
  return header.readUInt32LE(68);
}

/** Electrum history heights: 0 means mempool, -1 means unconfirmed parent. */
export function isConfirmedHeight(height: number): boolean {
  return typeof height === 'number' && height > 0;
}
