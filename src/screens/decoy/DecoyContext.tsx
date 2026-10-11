import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { DecoyState, refreshIdle } from '../../lib/decoy/conversations';
import { loadDecoy, saveDecoy } from '../../lib/decoy/decoyStore';
import { loadAttempts, loadPinRecord, saveAttempts } from '../../lib/securityMode';
import { PinRecord } from '../../lib/securityPin';

interface DecoyShape {
  state: DecoyState | null;
  /** Apply a pure update to the inbox and persist it. */
  update: (fn: (s: DecoyState) => DecoyState) => void;
  pinRecord: PinRecord | null;
  attempts: number;
  setAttempts: (n: number) => Promise<void>;
  /** The right PIN was sent: hand back to the wallet. */
  onUnlock: () => void;
  /** Too many wrong PINs: erase everything. */
  onWipe: () => Promise<void>;
}

const Ctx = createContext<DecoyShape | null>(null);

export function DecoyProvider({
  onUnlock,
  onWipe,
  children,
}: {
  onUnlock: () => void;
  onWipe: () => Promise<void>;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<DecoyState | null>(null);
  const stateRef = useRef<DecoyState | null>(null);
  const [pinRecord, setPinRecord] = useState<PinRecord | null>(null);
  const [attempts, setAttemptsState] = useState(0);

  useEffect(() => {
    (async () => {
      const now = Date.now();
      const [inbox, pin, tries] = await Promise.all([loadDecoy(now), loadPinRecord(), loadAttempts()]);
      const refreshed = refreshIdle(inbox, now);
      if (refreshed !== inbox) await saveDecoy(refreshed);
      stateRef.current = refreshed;
      setState(refreshed);
      setPinRecord(pin);
      setAttemptsState(tries);
    })();
  }, []);

  const update = useCallback((fn: (s: DecoyState) => DecoyState) => {
    if (!stateRef.current) return;
    const next = fn(stateRef.current);
    stateRef.current = next;
    setState(next);
    saveDecoy(next).catch(() => {});
  }, []);

  const setAttempts = useCallback(async (n: number) => {
    setAttemptsState(n);
    await saveAttempts(n);
  }, []);

  return (
    <Ctx.Provider value={{ state, update, pinRecord, attempts, setAttempts, onUnlock, onWipe }}>
      {children}
    </Ctx.Provider>
  );
}

export function useDecoy(): DecoyShape {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useDecoy must be used inside DecoyProvider');
  return ctx;
}
