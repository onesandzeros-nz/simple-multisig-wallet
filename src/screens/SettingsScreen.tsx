import React from 'react';
import { Switch, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation';
import { Screen, Card, Button, SectionTitle, Label, Input, Row, Divider } from '../components/ui';
import { colors } from '../theme';
import { effectiveRelays, useStore } from '../lib/store';
import {
  BackendConfig,
  DEFAULT_ELECTRUM_PORT,
  DEFAULT_ELECTRUM_TLS_PORT,
  PUBLIC_SERVERS,
  backendLabel,
  effectiveBackend,
  looksPrivateHost,
  publicServerById,
  testBackend,
} from '../lib/chain';
import { DEFAULT_RELAYS, MAX_RELAYS } from '../lib/nostr/protocol';
import { useRelayStatus } from '../lib/nostr/useRelayStatus';
import { NAME_INPUT_CHARS, NAME_PURPOSE } from '../lib/naming';

export default function SettingsScreen() {
  const { settings, updateSettings } = useStore();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  // The form edits the user's own server; the public pick lives separately.
  const own = settings.ownBackend;
  const active = effectiveBackend(settings);
  const [kind, setKind] = React.useState<'esplora' | 'electrum'>(own?.kind ?? 'esplora');
  const [url, setUrl] = React.useState(own?.kind === 'esplora' ? (own.url ?? '') : '');
  const [host, setHost] = React.useState(own?.kind === 'electrum' ? own.host : '');
  // A fresh Electrum config defaults to TLS on its standard port — the safer
  // starting point — rather than plaintext 50001.
  const [port, setPort] = React.useState(
    own?.kind === 'electrum' ? String(own.port) : String(DEFAULT_ELECTRUM_TLS_PORT)
  );
  const [tls, setTls] = React.useState(own?.kind === 'electrum' ? own.tls : true);
  // Showing the own-server form is a screen-local choice: with nothing
  // saved yet, the public server keeps serving until the form is saved.
  const [publicServer, setPublicServer] = React.useState(!settings.useOwnServer);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ ok: boolean; message: string } | null>(null);
  const [newRelay, setNewRelay] = React.useState('');
  const [nameDraft, setNameDraft] = React.useState(settings.userName ?? '');
  const [savingName, setSavingName] = React.useState(false);
  const trimmedName = nameDraft.trim();
  const nameDirty = trimmedName !== '' && trimmedName !== (settings.userName ?? '').trim();

  const saveName = async () => {
    setSavingName(true);
    try {
      await updateSettings({ userName: trimmedName });
      setNameDraft(trimmedName);
    } finally {
      setSavingName(false);
    }
  };

  const togglePublicServer = async (v: boolean) => {
    setPublicServer(v);
    setTestResult(null);
    // Either direction takes effect at once when there is an own server to
    // switch to; otherwise the form appears and Save does the switch.
    if (v) await updateSettings({ useOwnServer: false });
    else if (own) await updateSettings({ useOwnServer: true });
  };

  const choosePublicServer = async (id: string) => {
    setTestResult(null);
    await updateSettings({ publicServerId: id, useOwnServer: false });
  };

  const relaysInUse = effectiveRelays(settings);
  const relayInput = newRelay.trim().replace(/\/+$/, '');
  const relayOk = relayInput === '' || /^wss?:\/\/.+/i.test(relayInput);
  const relayDuplicate = relaysInUse.includes(relayInput);
  // Each relay is a connection held open by every group: the same cap as an invite.
  const relayFull = settings.relays.length >= MAX_RELAYS;

  const addRelay = () => {
    if (!relayInput || !relayOk || relayDuplicate || relayFull) return;
    updateSettings({ relays: [...settings.relays, relayInput] });
    setNewRelay('');
  };

  const removeRelay = (url: string) => {
    updateSettings({ relays: settings.relays.filter((r) => r !== url) });
  };

  const { status: relayStatus, refresh: refreshRelayStatus } = useRelayStatus(relaysInUse);

  const normalised = url.trim().replace(/\/+$/, '');
  const urlOk = normalised === '' || /^https?:\/\/.+/.test(normalised);
  const hostOk = /^[A-Za-z0-9.:_-]+$/.test(host.trim()) && host.trim().length > 0;
  const portNumber = parseInt(port, 10);
  const portOk = Number.isInteger(portNumber) && portNumber > 0 && portNumber <= 65535;

  const draft: BackendConfig =
    kind === 'esplora'
      ? { kind: 'esplora', url: normalised === '' ? null : normalised }
      : { kind: 'electrum', host: host.trim(), port: portNumber, tls };
  const draftOk = kind === 'esplora' ? urlOk && normalised !== '' : hostOk && portOk;
  const dirty = !publicServer && (!own || !settings.useOwnServer || JSON.stringify(draft) !== JSON.stringify(own));

  const save = async () => {
    setTestResult(null);
    await updateSettings({ ownBackend: draft, useOwnServer: true });
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const height = await testBackend(draft);
      setTestResult({ ok: true, message: `Connected — block height ${height.toLocaleString()}.` });
    } catch (e: any) {
      setTestResult({ ok: false, message: e.message ?? String(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Screen>
      <SectionTitle>About</SectionTitle>
      <Card>
        <Row
          icon="shield-checkmark-outline"
          title="Simple Multisig"
          subtitle="Standard multisig · works with Sparrow, Coldcard and Specter"
        />
        <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 4 }}>
          Keys never leave this phone's secure storage. The server below only ever sees public
          addresses and signed transactions.
        </Text>
      </Card>

      <SectionTitle>Your name</SectionTitle>
      <Card>
        <Input
          placeholder="e.g. Rob"
          value={nameDraft}
          onChangeText={setNameDraft}
          maxLength={NAME_INPUT_CHARS}
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={() => {
            if (nameDirty) saveName();
          }}
        />
        <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 8 }}>{NAME_PURPOSE}</Text>
        {!(settings.userName ?? '').trim() && (
          <Text style={{ color: colors.inkFaint, fontSize: 12, lineHeight: 17, marginTop: 6 }}>
            Not set yet. Until it is, cosigners see the name of your key instead.
          </Text>
        )}
        <Button
          title="Save name"
          icon="checkmark-outline"
          variant="secondary"
          onPress={saveName}
          loading={savingName}
          disabled={!nameDirty}
        />
      </Card>

      <SectionTitle>Security</SectionTitle>
      <Card>
        <Row
          icon="eye-off-outline"
          title="Security mode"
          subtitle={settings.securityMode ? 'On — the app opens as "SMS"' : 'Off — disguise the app as a messaging app'}
          onPress={() => navigation.navigate('SecurityMode')}
        />
      </Card>

      <SectionTitle>Appearance</SectionTitle>
      <Card>
        <Row
          icon="moon-outline"
          title="Dark mode"
          trailing={
            <Switch
              value={settings.darkMode}
              onValueChange={(v) => updateSettings({ darkMode: v })}
              trackColor={{ false: colors.chipBg, true: colors.accent }}
              thumbColor={colors.card}
            />
          }
        />
      </Card>

      <SectionTitle>Network</SectionTitle>
      <Card>
        <Row
          icon="flask-outline"
          title="Testnet mode"
          subtitle={settings.testnet ? 'Test coins, no real value' : 'Mainnet — real bitcoin'}
          trailing={
            <Switch
              value={settings.testnet}
              onValueChange={(v) => updateSettings({ testnet: v })}
              trackColor={{ false: colors.chipBg, true: colors.warning }}
              thumbColor={colors.card}
            />
          }
        />
        <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 6 }}>
          Applies to keys, wallets and groups you create from now on. Wallets you already have keep
          the network they were built on, and both kinds can sit side by side in the list.
        </Text>
        {settings.testnet && (
          <Text style={{ color: colors.warning, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
            Your server must serve testnet too. A mempool.space-compatible URL handles both, but an
            Electrum server does not — mainnet electrs listens on 50001 and a testnet index is a
            separate server, usually on 60001.
          </Text>
        )}
      </Card>

      <SectionTitle>Blockchain provider</SectionTitle>
      <Card>
        <Row
          icon="globe-outline"
          title="Public"
          subtitle={
            publicServer
              ? `${publicServerById(settings.publicServerId).name} — works out of the box`
              : own
                ? 'Off — using your own server below'
                : 'Off — save your own server below to switch'
          }
          trailing={
            <Switch
              value={publicServer}
              onValueChange={togglePublicServer}
              trackColor={{ false: colors.chipBg, true: colors.accent }}
              thumbColor={colors.card}
            />
          }
        />
        <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 4 }}>
          Balances, coins, fees and broadcasts all go through one server. Turn this off to point
          the app at your own node for better privacy — nobody else then learns which addresses
          you look up.
        </Text>

        {publicServer && (
          <View style={{ marginTop: 8 }}>
            {PUBLIC_SERVERS.map((p, i) => {
              const selected = p.id === settings.publicServerId;
              const kindLabel = p.backend.kind === 'electrum' ? 'Electrum' : 'HTTP';
              return (
                <View key={p.id}>
                  {i > 0 && <Divider />}
                  <TouchableOpacity onPress={() => choosePublicServer(p.id)} activeOpacity={0.7}>
                    <Row
                      icon={selected ? 'radio-button-on' : 'radio-button-off'}
                      title={p.name}
                      subtitle={`${p.operator} · ${kindLabel}${p.testnet ? '' : ' · mainnet only'}`}
                    />
                  </TouchableOpacity>
                </View>
              );
            })}
            {settings.testnet && !publicServerById(settings.publicServerId).testnet && (
              <Text style={{ color: colors.warning, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
                This server has no testnet index — testnet wallets will not sync while it is
                selected.
              </Text>
            )}
          </View>
        )}

        {!publicServer && (
          <>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
          {(['esplora', 'electrum'] as const).map((k) => {
            const active = kind === k;
            return (
              <TouchableOpacity
                key={k}
                onPress={() => {
                  setKind(k);
                  setTestResult(null);
                }}
                activeOpacity={0.7}
                style={{
                  flex: 1,
                  paddingVertical: 10,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: active ? colors.ink : colors.line,
                  backgroundColor: active ? colors.ink : colors.card,
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: '600', color: active ? colors.onPrimary : colors.ink }}>
                  {k === 'esplora' ? 'mempool / Esplora' : 'Electrum'}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {kind === 'esplora' ? (
          <>
            <Label>Server URL</Label>
            <Input
              placeholder="https://umbrel.local:3006"
              value={url}
              onChangeText={(v) => {
                setUrl(v);
                setTestResult(null);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <Text style={{ color: colors.inkFaint, fontSize: 12, marginTop: 6 }}>
              Any mempool.space or Esplora-compatible instance, e.g. one served by your own node.
            </Text>
            {!urlOk && (
              <Text style={{ color: colors.danger, fontSize: 13, marginTop: 6 }}>
                The URL should start with http:// or https://
              </Text>
            )}
            {urlOk && /^http:\/\//i.test(normalised) && (
              <Text style={{ color: colors.warning, fontSize: 13, marginTop: 6, lineHeight: 18 }}>
                Plain HTTP is unencrypted — fine over Tailscale, a VPN or your own LAN, but anyone
                on the path could see which addresses you look up.
              </Text>
            )}
          </>
        ) : (
          <>
            <Label>Host</Label>
            <Input
              placeholder="umbrel.local"
              value={host}
              onChangeText={(v) => {
                setHost(v);
                setTestResult(null);
              }}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Label>Port</Label>
                <Input
                  placeholder={String(DEFAULT_ELECTRUM_PORT)}
                  value={port}
                  onChangeText={(v) => {
                    setPort(v);
                    setTestResult(null);
                  }}
                  keyboardType="number-pad"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Label>Encrypted (TLS)</Label>
                <TouchableOpacity
                  onPress={() => {
                    setTls(!tls);
                    setTestResult(null);
                  }}
                  activeOpacity={0.7}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    paddingVertical: 13,
                  }}
                >
                  <Ionicons
                    name={tls ? 'checkbox-outline' : 'square-outline'}
                    size={22}
                    color={tls ? colors.success : colors.inkSoft}
                  />
                  <Text style={{ color: colors.ink, fontSize: 14 }}>{tls ? 'On' : 'Off'}</Text>
                </TouchableOpacity>
              </View>
            </View>
            <Text style={{ color: colors.inkFaint, fontSize: 12, marginTop: 6 }}>
              electrs, Fulcrum or ElectrumX. Umbrel serves plain TCP on {DEFAULT_ELECTRUM_PORT} and
              TLS on {DEFAULT_ELECTRUM_TLS_PORT}.
            </Text>
            {!tls && (
              <Text style={{ color: colors.warning, fontSize: 13, marginTop: 6, lineHeight: 18 }}>
                Plain TCP is unencrypted — only use it over Tailscale, a VPN or your own LAN. Anyone
                on the path could otherwise see your addresses or feed you false balances and fees.
              </Text>
            )}
            {tls && (
              <Text style={{ color: colors.inkFaint, fontSize: 12, marginTop: 6, lineHeight: 18 }}>
                TLS encrypts the connection and checks the certificate chain, but the app cannot verify
                an Electrum server's hostname. Use Electrum for a server you run on a network you
                control (LAN, Tailscale, VPN, Tor). For a server on the open internet, use the mempool /
                Esplora option over HTTPS instead — the app does verify an HTTPS hostname.
              </Text>
            )}
            {tls && hostOk && !looksPrivateHost(host) && (
              <Text style={{ color: colors.warning, fontSize: 13, marginTop: 6, lineHeight: 18 }}>
                This looks like a server on the open internet. Someone between you and it could present
                a different valid certificate and the app would not notice. If it offers a mempool /
                Esplora API over HTTPS, use that instead.
              </Text>
            )}
            {host.trim() !== '' && !hostOk && (
              <Text style={{ color: colors.danger, fontSize: 13, marginTop: 6 }}>
                Enter a hostname or IP address, without http://
              </Text>
            )}
            {!portOk && (
              <Text style={{ color: colors.danger, fontSize: 13, marginTop: 6 }}>
                The port should be a number between 1 and 65535.
              </Text>
            )}
          </>
        )}

        {testResult && (
          <Text style={{ color: testResult.ok ? colors.success : colors.danger, fontSize: 13, marginTop: 10, lineHeight: 18 }}>
            {testResult.message}
          </Text>
        )}
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
          <View style={{ flex: 1 }}>
            <Button title="Test" icon="pulse-outline" variant="secondary" onPress={test} loading={testing} disabled={!draftOk} />
          </View>
          <View style={{ flex: 1 }}>
            <Button title="Save" icon="checkmark-outline" onPress={save} disabled={!draftOk || !dirty} />
          </View>
        </View>
          </>
        )}
        <Text style={{ color: colors.inkFaint, fontSize: 12, marginTop: 8 }}>
          Currently using {backendLabel(active)}
          {dirty ? ' (unsaved changes)' : ''}
        </Text>
      </Card>

      <SectionTitle>Nostr relays</SectionTitle>
      <Card>
        <Row
          icon="globe-outline"
          title="Public"
          subtitle={
            settings.publicRelays
              ? 'Built-in public relays, plus any you add'
              : 'Off — only relays you add below'
          }
          trailing={
            <Switch
              value={settings.publicRelays}
              onValueChange={(v) => updateSettings({ publicRelays: v })}
              trackColor={{ false: colors.chipBg, true: colors.accent }}
              thumbColor={colors.card}
            />
          }
        />
        <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 4 }}>
          Group coordination goes through these relays. More relays means better reach; every
          message is encrypted, so a relay only sees ciphertext. Groups you are already in connect
          to these as well as the relays from their invite.
        </Text>
        {relaysInUse.map((r, i) => {
          const builtIn = settings.publicRelays && DEFAULT_RELAYS.includes(r) && !settings.relays.includes(r);
          return (
          <View key={r}>
            {i > 0 && <Divider />}
            <Row
              icon="radio-outline"
              title={r.replace(/^wss?:\/\//i, '')}
              subtitle={
                relayStatus[r] === 'connected'
                  ? builtIn ? 'Connected · built-in' : 'Connected'
                  : relayStatus[r] === 'unreachable'
                    ? 'Not responding'
                    : 'Connecting…'
              }
              trailing={
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor:
                        relayStatus[r] === 'connected'
                          ? colors.success
                          : relayStatus[r] === 'unreachable'
                            ? colors.danger
                            : colors.inkFaint,
                    }}
                  />
                  {!builtIn && (
                    <Button title="Remove" variant="danger" compact onPress={() => removeRelay(r)} />
                  )}
                </View>
              }
            />
          </View>
          );
        })}
        {relaysInUse.length > 0 && (
          <Button
            title="Recheck connections"
            icon="refresh-outline"
            variant="secondary"
            onPress={refreshRelayStatus}
          />
        )}
        {!settings.publicRelays && settings.relays.length === 0 && (
          <Text style={{ color: colors.warning, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
            No relays — group coordination cannot work. Add your own relay below, or turn public
            relays back on.
          </Text>
        )}
        <Label>Add a relay</Label>
        <Input
          placeholder="wss://relay.example.com"
          value={newRelay}
          onChangeText={setNewRelay}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          onSubmitEditing={addRelay}
        />
        {!relayOk && (
          <Text style={{ color: colors.danger, fontSize: 13, marginTop: 6 }}>
            A relay address starts with wss:// (or ws:// on a local network).
          </Text>
        )}
        {relayInput !== '' && relayDuplicate && (
          <Text style={{ color: colors.warning, fontSize: 13, marginTop: 6 }}>
            That relay is already in the list.
          </Text>
        )}
        {relayFull && (
          <Text style={{ color: colors.warning, fontSize: 13, marginTop: 6 }}>
            That is as many relays as the app keeps open ({MAX_RELAYS}). Remove one to add another.
          </Text>
        )}
        <Button
          title="Add relay"
          icon="add-outline"
          variant="secondary"
          onPress={addRelay}
          disabled={!relayInput || !relayOk || relayDuplicate || relayFull}
        />
      </Card>

    </Screen>
  );
}
