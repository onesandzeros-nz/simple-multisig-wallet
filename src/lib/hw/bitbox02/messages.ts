import { decodeMessage, encodeMessage, FieldSpec, Message, MessageSchema } from '../protobuf';

/**
 * The BitBox02 messages this app sends and reads, written out from the
 * firmware's .proto files (github.com/BitBoxSwiss/bitbox02-firmware,
 * messages/: hww.proto, btc.proto, common.proto, antiklepto.proto,
 * bitbox02_system.proto, mnemonic.proto). Field names and numbers are the
 * firmware's own, so each schema can be checked against its source line by
 * line; anything the app has no use for is left out and is skipped on read.
 *
 * The firmware speaks proto3: repeated numbers travel packed, and a number,
 * flag or string at its zero value is not sent at all (see `encodeRequest`).
 */

const keypath = (id: number) => ({ id, type: 'uint32', repeated: true, packed: true }) as const;

// --- enums -----------------------------------------------------------------

export const BTCCoin = { BTC: 0, TBTC: 1 } as const;
export const XPubType = { TPUB: 0, XPUB: 1 } as const;
export const MultisigScriptType = { P2WSH: 0, P2WSH_P2SH: 1 } as const;
export const FormatUnit = { DEFAULT: 0, SAT: 1 } as const;
export const RegisterXPubType = { AUTO_ELECTRUM: 0, AUTO_XPUB_TPUB: 1 } as const;
export const BTCOutputType = {
  UNKNOWN: 0,
  P2PKH: 1,
  P2SH: 2,
  P2WPKH: 3,
  P2WSH: 4,
  P2TR: 5,
  OP_RETURN: 6,
} as const;
export const SignNextType = {
  INPUT: 0,
  OUTPUT: 1,
  DONE: 2,
  PREVTX_INIT: 3,
  PREVTX_INPUT: 4,
  PREVTX_OUTPUT: 5,
  HOST_NONCE: 6,
  PAYMENT_REQUEST: 7,
} as const;

// --- common.proto ----------------------------------------------------------

export const XPub: MessageSchema = {
  depth: { id: 1, type: 'bytes' },
  parent_fingerprint: { id: 2, type: 'bytes' },
  child_num: { id: 3, type: 'uint32' },
  chain_code: { id: 4, type: 'bytes' },
  public_key: { id: 5, type: 'bytes' },
};

const PubResponse: MessageSchema = { pub: { id: 1, type: 'string' } };
const RootFingerprintResponse: MessageSchema = { fingerprint: { id: 1, type: 'bytes' } };
const Empty: MessageSchema = {};

// --- antiklepto.proto ------------------------------------------------------

const AntiKleptoHostNonceCommitment: MessageSchema = { commitment: { id: 1, type: 'bytes' } };
const AntiKleptoSignerCommitment: MessageSchema = { commitment: { id: 1, type: 'bytes' } };
const AntiKleptoSignatureRequest: MessageSchema = { host_nonce: { id: 1, type: 'bytes' } };

// --- btc.proto -------------------------------------------------------------

const Multisig: MessageSchema = {
  threshold: { id: 1, type: 'uint32' },
  xpubs: { id: 2, type: XPub, repeated: true },
  our_xpub_index: { id: 3, type: 'uint32' },
  script_type: { id: 4, type: 'enum' },
};

export const BTCScriptConfig: MessageSchema = {
  simple_type: { id: 1, type: 'enum' },
  multisig: { id: 2, type: Multisig },
};

export const BTCScriptConfigWithKeypath: MessageSchema = {
  script_config: { id: 2, type: BTCScriptConfig },
  keypath: keypath(3),
};

const BTCPubRequest: MessageSchema = {
  coin: { id: 1, type: 'enum' },
  keypath: keypath(2),
  xpub_type: { id: 3, type: 'enum' },
  script_config: { id: 4, type: BTCScriptConfig },
  display: { id: 5, type: 'bool' },
};

export const BTCSignInitRequest: MessageSchema = {
  coin: { id: 1, type: 'enum' },
  script_configs: { id: 2, type: BTCScriptConfigWithKeypath, repeated: true },
  version: { id: 4, type: 'uint32' },
  num_inputs: { id: 5, type: 'uint32' },
  num_outputs: { id: 6, type: 'uint32' },
  locktime: { id: 7, type: 'uint32' },
  format_unit: { id: 8, type: 'enum' },
  contains_silent_payment_outputs: { id: 9, type: 'bool' },
  output_script_configs: { id: 10, type: BTCScriptConfigWithKeypath, repeated: true },
};

export const BTCSignNextResponse: MessageSchema = {
  type: { id: 1, type: 'enum' },
  index: { id: 2, type: 'uint32' },
  has_signature: { id: 3, type: 'bool' },
  signature: { id: 4, type: 'bytes' },
  prev_index: { id: 5, type: 'uint32' },
  anti_klepto_signer_commitment: { id: 6, type: AntiKleptoSignerCommitment },
};

// The three prevOut fields really are camelCase in btc.proto.
export const BTCSignInputRequest: MessageSchema = {
  prevOutHash: { id: 1, type: 'bytes' },
  prevOutIndex: { id: 2, type: 'uint32' },
  prevOutValue: { id: 3, type: 'uint64' },
  sequence: { id: 4, type: 'uint32' },
  keypath: keypath(6),
  script_config_index: { id: 7, type: 'uint32' },
  host_nonce_commitment: { id: 8, type: AntiKleptoHostNonceCommitment },
};

export const BTCSignOutputRequest: MessageSchema = {
  ours: { id: 1, type: 'bool' },
  type: { id: 2, type: 'enum' },
  value: { id: 3, type: 'uint64' },
  payload: { id: 4, type: 'bytes' },
  keypath: keypath(5),
  script_config_index: { id: 6, type: 'uint32' },
};

const BTCScriptConfigRegistration: MessageSchema = {
  coin: { id: 1, type: 'enum' },
  script_config: { id: 2, type: BTCScriptConfig },
  keypath: keypath(3),
};

const BTCIsScriptConfigRegisteredRequest: MessageSchema = {
  registration: { id: 1, type: BTCScriptConfigRegistration },
};

const BTCIsScriptConfigRegisteredResponse: MessageSchema = {
  is_registered: { id: 1, type: 'bool' },
};

const BTCRegisterScriptConfigRequest: MessageSchema = {
  registration: { id: 1, type: BTCScriptConfigRegistration },
  name: { id: 2, type: 'string' },
  xpub_type: { id: 3, type: 'enum' },
};

export const BTCPrevTxInitRequest: MessageSchema = {
  version: { id: 1, type: 'uint32' },
  num_inputs: { id: 2, type: 'uint32' },
  num_outputs: { id: 3, type: 'uint32' },
  locktime: { id: 4, type: 'uint32' },
};

export const BTCPrevTxInputRequest: MessageSchema = {
  prev_out_hash: { id: 1, type: 'bytes' },
  prev_out_index: { id: 2, type: 'uint32' },
  signature_script: { id: 3, type: 'bytes' },
  sequence: { id: 4, type: 'uint32' },
};

export const BTCPrevTxOutputRequest: MessageSchema = {
  value: { id: 1, type: 'uint64' },
  pubkey_script: { id: 2, type: 'bytes' },
};

export const BTCRequest: MessageSchema = {
  is_script_config_registered: { id: 1, type: BTCIsScriptConfigRegisteredRequest },
  register_script_config: { id: 2, type: BTCRegisterScriptConfigRequest },
  prevtx_init: { id: 3, type: BTCPrevTxInitRequest },
  prevtx_input: { id: 4, type: BTCPrevTxInputRequest },
  prevtx_output: { id: 5, type: BTCPrevTxOutputRequest },
  antiklepto_signature: { id: 7, type: AntiKleptoSignatureRequest },
};

export const BTCResponse: MessageSchema = {
  success: { id: 1, type: Empty },
  is_script_config_registered: { id: 2, type: BTCIsScriptConfigRegisteredResponse },
  sign_next: { id: 3, type: BTCSignNextResponse },
  antiklepto_signer_commitment: { id: 5, type: AntiKleptoSignerCommitment },
};

// --- bitbox02_system.proto, mnemonic.proto ---------------------------------

const DeviceInfoResponse: MessageSchema = {
  name: { id: 1, type: 'string' },
  initialized: { id: 2, type: 'bool' },
  version: { id: 3, type: 'string' },
  mnemonic_passphrase_enabled: { id: 4, type: 'bool' },
};

/**
 * Seeds a device from words typed on it. The app never sends this — setting a
 * device up is the BitBoxApp's job — but the test suite needs it to seed the
 * simulator, which starts out blank.
 */
const RestoreFromMnemonicRequest: MessageSchema = {
  timestamp: { id: 1, type: 'uint32' },
  timezone_offset: { id: 2, type: 'int32' },
};

// --- hww.proto -------------------------------------------------------------

const ErrorResponse: MessageSchema = {
  code: { id: 1, type: 'int32' },
  message: { id: 2, type: 'string' },
};

export const Request: MessageSchema = {
  device_info: { id: 4, type: Empty },
  btc_pub: { id: 8, type: BTCPubRequest },
  btc_sign_init: { id: 9, type: BTCSignInitRequest },
  btc_sign_input: { id: 10, type: BTCSignInputRequest },
  btc_sign_output: { id: 11, type: BTCSignOutputRequest },
  restore_from_mnemonic: { id: 22, type: RestoreFromMnemonicRequest },
  fingerprint: { id: 24, type: Empty },
  btc: { id: 25, type: BTCRequest },
};

export const Response: MessageSchema = {
  success: { id: 1, type: Empty },
  error: { id: 2, type: ErrorResponse },
  device_info: { id: 4, type: DeviceInfoResponse },
  pub: { id: 5, type: PubResponse },
  btc_sign_next: { id: 6, type: BTCSignNextResponse },
  fingerprint: { id: 12, type: RootFingerprintResponse },
  btc: { id: 13, type: BTCResponse },
};

/** Error codes the firmware reports inside a Response. */
export const ERR_INVALID_INPUT = 101;
export const ERR_GENERIC = 103;
export const ERR_USER_ABORT = 104;
export const ERR_INVALID_STATE = 105;
export const ERR_DISABLED = 106;
export const ERR_DUPLICATE = 107;

// --- encoding --------------------------------------------------------------

/**
 * Fields that are one of several alternatives (a protobuf `oneof`). Which
 * alternative is present is itself the message, so these are sent even when
 * their value is zero — `xpub_type: TPUB` is 0, and leaving it out would ask
 * for nothing at all.
 */
const ALTERNATIVES: ReadonlySet<FieldSpec> = new Set([BTCScriptConfig.simple_type, BTCPubRequest.xpub_type]);

function isZero(value: unknown): boolean {
  if (value === 0 || value === false || value === '') return true;
  return value instanceof Uint8Array && value.length === 0;
}

/**
 * Drops every field that is at its zero value, as proto3 encoders do. The
 * device reads both forms alike; sending the canonical one keeps what goes
 * over the cable byte for byte what the manufacturer's own libraries send.
 */
function canonical(schema: MessageSchema, message: Message): Message {
  const out: Message = {};
  for (const [name, value] of Object.entries(message)) {
    if (value === undefined || value === null) continue;
    const spec = schema[name];
    // Left in place for the encoder to refuse by name.
    if (!spec) {
      out[name] = value;
      continue;
    }
    const nested = typeof spec.type === 'string' ? null : typeof spec.type === 'function' ? spec.type() : spec.type;
    if (spec.repeated) {
      out[name] = nested && Array.isArray(value) ? value.map((item) => canonical(nested, item)) : value;
    } else if (nested) {
      out[name] = canonical(nested, value);
    } else if (ALTERNATIVES.has(spec) || !isZero(value)) {
      out[name] = value;
    }
  }
  return out;
}

export function encodeRequest(request: Message) {
  return encodeMessage(Request, canonical(Request, request));
}

export function decodeResponse(bytes: Uint8Array): Message {
  return decodeMessage(Response, bytes);
}
