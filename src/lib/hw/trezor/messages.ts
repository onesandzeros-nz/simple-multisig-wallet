import { MessageSchema } from '../protobuf';

/**
 * The Trezor messages this app sends and reads, written out from the .proto
 * files in trezor-firmware (common/protob). Trezor speaks proto2, so repeated
 * numbers travel one tag per element — never `packed`.
 *
 * Only the fields this driver touches are declared. A field left out here is
 * simply skipped on the way in, and can never be sent on the way out.
 */

/** Wire ids, from the MessageType enum in messages.proto. */
export const MessageType = {
  Initialize: 0,
  Success: 2,
  Failure: 3,
  GetPublicKey: 11,
  PublicKey: 12,
  SignTx: 15,
  Features: 17,
  PinMatrixRequest: 18,
  PinMatrixAck: 19,
  Cancel: 20,
  TxRequest: 21,
  TxAck: 22,
  ButtonRequest: 26,
  ButtonAck: 27,
  PassphraseRequest: 41,
  PassphraseAck: 42,
  /** Firmware before the 2020 passphrase redesign; answered so an old device fails cleanly. */
  Deprecated_PassphraseStateRequest: 77,
  Deprecated_PassphraseStateAck: 78,
  EndSession: 83,
} as const;

export function messageName(type: number): string {
  const hit = Object.entries(MessageType).find(([, id]) => id === type);
  return hit ? hit[0] : `message ${type}`;
}

export const FailureType = {
  UnexpectedMessage: 1,
  ButtonExpected: 2,
  DataError: 3,
  ActionCancelled: 4,
  PinExpected: 5,
  PinCancelled: 6,
  PinInvalid: 7,
  InvalidSignature: 8,
  ProcessError: 9,
  NotEnoughFunds: 10,
  NotInitialized: 11,
  PinMismatch: 12,
  WipeCodeMismatch: 13,
  InvalidSession: 14,
  Busy: 15,
  /** What a device that only speaks the newer encrypted protocol answers to anything sent the old way. */
  InvalidProtocol: 17,
  FirmwareError: 99,
} as const;

export const ButtonRequestType = {
  FeeOverThreshold: 2,
  ConfirmOutput: 3,
  SignTx: 8,
  Address: 10,
  PublicKey: 11,
  UnknownDerivationPath: 15,
  Warning: 18,
  PassphraseEntry: 19,
  PinEntry: 20,
} as const;

export const InputScriptType = {
  SPENDADDRESS: 0,
  SPENDWITNESS: 3,
} as const;

export const OutputScriptType = {
  PAYTOADDRESS: 0,
  PAYTOOPRETURN: 3,
  PAYTOWITNESS: 4,
} as const;

export const MultisigPubkeysOrder = {
  PRESERVED: 0,
  LEXICOGRAPHIC: 1,
} as const;

export const RequestType = {
  TXINPUT: 0,
  TXOUTPUT: 1,
  TXMETA: 2,
  TXFINISHED: 3,
  TXEXTRADATA: 4,
} as const;

/** Features.capabilities entry: the device has its own keyboard for a passphrase. */
export const CAPABILITY_PASSPHRASE_ENTRY = 17;

// ---------------------------------------------------------------------------
// messages-common.proto
// ---------------------------------------------------------------------------

export const Success: MessageSchema = {
  message: { id: 1, type: 'string' },
};

export const Failure: MessageSchema = {
  code: { id: 1, type: 'enum' },
  message: { id: 2, type: 'string' },
};

export const ButtonRequest: MessageSchema = {
  code: { id: 1, type: 'enum' },
  pages: { id: 2, type: 'uint32' },
  name: { id: 4, type: 'string' },
};

export const PinMatrixRequest: MessageSchema = {
  type: { id: 1, type: 'enum' },
};

export const PinMatrixAck: MessageSchema = {
  pin: { id: 1, type: 'string' },
};

export const PassphraseRequest: MessageSchema = {
  /** Firmware before 2.3.0: the device will ask for the passphrase itself. */
  _on_device: { id: 1, type: 'bool' },
};

export const PassphraseAck: MessageSchema = {
  passphrase: { id: 1, type: 'string' },
  on_device: { id: 3, type: 'bool' },
};

export const HDNodeType: MessageSchema = {
  depth: { id: 1, type: 'uint32' },
  fingerprint: { id: 2, type: 'uint32' },
  child_num: { id: 3, type: 'uint32' },
  chain_code: { id: 4, type: 'bytes' },
  public_key: { id: 6, type: 'bytes' },
};

/** For the messages that carry nothing: ButtonAck, Cancel, EndSession, GetFeatures. */
export const Empty: MessageSchema = {};

// ---------------------------------------------------------------------------
// messages-management.proto
// ---------------------------------------------------------------------------

export const Initialize: MessageSchema = {
  session_id: { id: 1, type: 'bytes' },
};

export const Features: MessageSchema = {
  vendor: { id: 1, type: 'string' },
  major_version: { id: 2, type: 'uint32' },
  minor_version: { id: 3, type: 'uint32' },
  patch_version: { id: 4, type: 'uint32' },
  bootloader_mode: { id: 5, type: 'bool' },
  pin_protection: { id: 7, type: 'bool' },
  passphrase_protection: { id: 8, type: 'bool' },
  label: { id: 10, type: 'string' },
  initialized: { id: 12, type: 'bool' },
  unlocked: { id: 16, type: 'bool' },
  firmware_present: { id: 18, type: 'bool' },
  model: { id: 21, type: 'string' },
  capabilities: { id: 30, type: 'enum', repeated: true },
  session_id: { id: 35, type: 'bytes' },
  passphrase_always_on_device: { id: 36, type: 'bool' },
  internal_model: { id: 44, type: 'string' },
};

// ---------------------------------------------------------------------------
// messages-bitcoin.proto
// ---------------------------------------------------------------------------

export const GetPublicKey: MessageSchema = {
  address_n: { id: 1, type: 'uint32', repeated: true },
  show_display: { id: 3, type: 'bool' },
  coin_name: { id: 4, type: 'string' },
  script_type: { id: 5, type: 'enum' },
};

export const PublicKey: MessageSchema = {
  node: { id: 1, type: HDNodeType },
  xpub: { id: 2, type: 'string' },
  root_fingerprint: { id: 3, type: 'uint32' },
};

export const MultisigRedeemScriptType: MessageSchema = {
  signatures: { id: 2, type: 'bytes', repeated: true },
  m: { id: 3, type: 'uint32' },
  nodes: { id: 4, type: HDNodeType, repeated: true },
  address_n: { id: 5, type: 'uint32', repeated: true },
  pubkeys_order: { id: 6, type: 'enum' },
};

export const SignTx: MessageSchema = {
  outputs_count: { id: 1, type: 'uint32' },
  inputs_count: { id: 2, type: 'uint32' },
  coin_name: { id: 3, type: 'string' },
  version: { id: 4, type: 'uint32' },
  lock_time: { id: 5, type: 'uint32' },
  serialize: { id: 13, type: 'bool' },
};

export const TxRequestDetailsType: MessageSchema = {
  request_index: { id: 1, type: 'uint32' },
  tx_hash: { id: 2, type: 'bytes' },
  extra_data_len: { id: 3, type: 'uint32' },
  extra_data_offset: { id: 4, type: 'uint32' },
};

export const TxRequestSerializedType: MessageSchema = {
  signature_index: { id: 1, type: 'uint32' },
  signature: { id: 2, type: 'bytes' },
  serialized_tx: { id: 3, type: 'bytes' },
};

export const TxRequest: MessageSchema = {
  request_type: { id: 1, type: 'enum' },
  details: { id: 2, type: TxRequestDetailsType },
  serialized: { id: 3, type: TxRequestSerializedType },
};

export const TxInputType: MessageSchema = {
  address_n: { id: 1, type: 'uint32', repeated: true },
  prev_hash: { id: 2, type: 'bytes' },
  prev_index: { id: 3, type: 'uint32' },
  script_sig: { id: 4, type: 'bytes' },
  sequence: { id: 5, type: 'uint32' },
  script_type: { id: 6, type: 'enum' },
  multisig: { id: 7, type: MultisigRedeemScriptType },
  amount: { id: 8, type: 'uint64' },
};

export const TxOutputBinType: MessageSchema = {
  amount: { id: 1, type: 'uint64' },
  script_pubkey: { id: 2, type: 'bytes' },
};

export const TxOutputType: MessageSchema = {
  address: { id: 1, type: 'string' },
  address_n: { id: 2, type: 'uint32', repeated: true },
  amount: { id: 3, type: 'uint64' },
  script_type: { id: 4, type: 'enum' },
  multisig: { id: 5, type: MultisigRedeemScriptType },
  op_return_data: { id: 6, type: 'bytes' },
};

export const TransactionType: MessageSchema = {
  version: { id: 1, type: 'uint32' },
  inputs: { id: 2, type: TxInputType, repeated: true },
  bin_outputs: { id: 3, type: TxOutputBinType, repeated: true },
  lock_time: { id: 4, type: 'uint32' },
  outputs: { id: 5, type: TxOutputType, repeated: true },
  inputs_cnt: { id: 6, type: 'uint32' },
  outputs_cnt: { id: 7, type: 'uint32' },
  extra_data_len: { id: 9, type: 'uint32' },
};

export const TxAck: MessageSchema = {
  tx: { id: 1, type: TransactionType },
};

/** Which schema decodes each message the device can send us. */
export const INCOMING: Record<number, MessageSchema> = {
  [MessageType.Success]: Success,
  [MessageType.Failure]: Failure,
  [MessageType.PublicKey]: PublicKey,
  [MessageType.Features]: Features,
  [MessageType.PinMatrixRequest]: PinMatrixRequest,
  [MessageType.TxRequest]: TxRequest,
  [MessageType.ButtonRequest]: ButtonRequest,
  [MessageType.PassphraseRequest]: PassphraseRequest,
  [MessageType.Deprecated_PassphraseStateRequest]: Empty,
};
