import { walletConfigFile, walletDescriptor, deriveAddress } from './bitcoin';
import { GroupBackup, groupBackupLines } from './groupBackup';
import { MultisigWallet } from './types';

/**
 * Backup formats for a wallet. Both contain public keys only — enough to
 * watch the wallet and rebuild it for signing, never enough to spend. A group
 * wallet's backup also carries the group invite (see groupBackup.ts).
 */

/** Filesystem-safe stem for the exported file names. */
export function exportBaseName(wallet: MultisigWallet): string {
  const safe = wallet.name.replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-');
  return `${safe || 'multisig'}-${wallet.m}of${wallet.n}`;
}

/**
 * Text file Sparrow (and Coldcard, Specter, Nunchuk) import directly.
 * The descriptor is included as a comment so nothing is lost if the
 * reader prefers descriptors.
 */
export function walletBackupFile(wallet: MultisigWallet, group?: GroupBackup | null): string {
  return [
    `# ${wallet.name} — ${wallet.m} of ${wallet.n} multisig backup`,
    `# Public keys only. This cannot spend funds on its own.`,
    `# Descriptor: ${walletDescriptor(wallet)}`,
    ...(group ? groupBackupLines(group) : []),
    '',
    walletConfigFile(wallet),
  ].join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Printable backup: the descriptor as a QR code this app can scan back in,
 * plus every cosigner in plain text so the wallet is recoverable by hand, and
 * for a group wallet the group invite. `qrSvgs` are pre-rendered because SVG
 * generation is async.
 */
export function backupPdfHtml(
  wallet: MultisigWallet,
  qrSvgs: { descriptor: string; cosigners: string[]; group?: string },
  createdAt: string,
  group?: GroupBackup | null
): string {
  const descriptor = walletDescriptor(wallet);
  const addresses = [0, 1, 2].map((i) => deriveAddress(wallet, 0, i).address);

  const cosignerBlocks = wallet.cosigners
    .map(
      (c, i) => `
      <div class="cosigner">
        <div class="qr">${qrSvgs.cosigners[i] ?? ''}</div>
        <div class="details">
          <h3>${escapeHtml(c.name)}</h3>
          <div class="row"><span>Fingerprint</span><code>${escapeHtml(c.fingerprint)}</code></div>
          <div class="row"><span>Path</span><code>${escapeHtml(c.path)}</code></div>
          <div class="row"><span>Account xpub</span><code class="wrap">${escapeHtml(c.xpub)}</code></div>
        </div>
      </div>`
    )
    .join('');

  // A separate QR, not folded into the wallet one: that has to stay a plain
  // descriptor so Sparrow and the rest can scan it.
  const groupBlock = group
    ? `
  <h2>Rejoin the group</h2>
  <div class="cosigner">
    <div class="qr">${qrSvgs.group ?? ''}</div>
    <div class="details">
      <div class="row"><span>Identity key</span><code>${escapeHtml(group.identityFingerprint ?? 'unknown')}</code></div>
      <ul>
        <li>After restoring the wallet: open it → Manage → Join this wallet's group → scan this code.</li>
        <li>Restore the recovery phrase of the identity key above first. The group recognises this
          phone by it; with any other key you arrive as a stranger and have to be let in.</li>
        <li>This code opens only the group's handshake — not its messages, and never the funds.</li>
      </ul>
    </div>
  </div>`
    : '';

  return `
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #15171A; margin: 0; padding: 32px; }
    h1 { font-size: 22px; margin: 0 0 2px; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #6E7482;
         margin: 26px 0 10px; border-bottom: 1px solid #E7E9ED; padding-bottom: 6px; }
    h3 { font-size: 14px; margin: 0 0 6px; }
    .sub { color: #6E7482; font-size: 13px; margin-bottom: 4px; }
    .warn { background: #FCF4EA; border: 1px solid #E8D5B5; border-radius: 8px;
            padding: 10px 12px; font-size: 12px; color: #7A5320; margin-top: 14px; }
    code { font-family: Menlo, Consolas, monospace; font-size: 11px; }
    .wrap { word-break: break-all; }
    .main-qr { text-align: center; margin: 14px 0 8px; }
    .main-qr svg { width: 230px; height: 230px; }
    .descriptor { background: #F3F4F6; border-radius: 8px; padding: 10px;
                  font-family: Menlo, Consolas, monospace; font-size: 10px; word-break: break-all; }
    .cosigner { display: flex; gap: 14px; align-items: flex-start; page-break-inside: avoid;
                border-bottom: 1px solid #E7E9ED; padding: 12px 0; }
    .cosigner .qr svg { width: 110px; height: 110px; }
    .details { flex: 1; }
    .row { display: flex; gap: 8px; font-size: 12px; margin-bottom: 3px; }
    .row span { color: #6E7482; min-width: 88px; }
    ul { margin: 6px 0 0 18px; padding: 0; font-size: 12px; color: #6E7482; }
    li { margin-bottom: 3px; }
  </style>

  <h1>${escapeHtml(wallet.name)}</h1>
  <div class="sub">${wallet.m} of ${wallet.n} multisig · P2WSH native segwit · ${wallet.network}</div>
  <div class="sub">Backup created ${escapeHtml(createdAt)}</div>

  <div class="warn">
    <strong>Public keys only.</strong> Anyone holding this page can see the wallet's balance and
    history, but cannot spend from it. Spending still needs ${wallet.m} of the ${wallet.n} private
    keys, which are not printed here. Keep your recovery phrases separately — you need both this
    page and your keys to recover the wallet.${
      group
        ? ' The group code lets its holder ask to join the group, which the coordinator has to allow.'
        : ''
    }
  </div>

  <h2>Scan to restore</h2>
  <div class="main-qr">${qrSvgs.descriptor}</div>
  <div class="descriptor">${escapeHtml(descriptor)}</div>

  <h2>Cosigners</h2>
  ${cosignerBlocks}
  ${groupBlock}

  <h2>First addresses</h2>
  <ul>${addresses.map((a) => `<li><code>${escapeHtml(a)}</code></li>`).join('')}</ul>

  <h2>How to restore</h2>
  <ul>
    <li>In Simple Multisig: Wallets → + → Import existing wallet → Scan QR, or paste the descriptor.</li>${
      group ? "\n    <li>Then rejoin the group from the wallet, as described under Rejoin the group.</li>" : ''
    }
    <li>In Sparrow: File → New Wallet → Edit Policy → paste the descriptor above.</li>
    <li>Any wallet supporting wsh(sortedmulti(...)) descriptors will accept it.</li>
  </ul>
  `;
}
