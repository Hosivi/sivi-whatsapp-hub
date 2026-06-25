'use client';

import ClientSimulator, { fmtTime, type SessionBubble } from '@/components/ClientSimulator';
import Header from '@/components/Header';
import HubPanel from '@/components/HubPanel';
import OfflineBanner from '@/components/OfflineBanner';
import {
  type MessageDTO,
  SendOutboundError,
  getMessages,
  postWebhook,
  sendOutbound,
  signWebhook,
} from '@/lib/api';
import { isPeru } from '@/lib/phone';
import { useCallback, useEffect, useRef, useState } from 'react';

type SendStatus = 'idle' | 'sending' | 'sent';
type OutboundSendStatus = 'idle' | 'sending' | 'sent';
type Theme = 'light' | 'kanagawa';

// ---------------------------------------------------------------------------
// Error code → Spanish message map for outbound send errors
// ---------------------------------------------------------------------------
const OUTBOUND_ERROR_MESSAGES: Record<string, string> = {
  NO_ACTIVE_ACCOUNT: 'No hay una cuenta de WhatsApp activa configurada.',
  OUTBOUND_NOT_CONFIGURED: 'La cuenta no tiene token configurado para envíos.',
  MULTIPLE_ACTIVE_ACCOUNTS: 'Hay más de una cuenta activa. Contactá al soporte.',
  INVALID_RECIPIENT: 'El número no es válido para recibir mensajes de WhatsApp.',
  WINDOW_CLOSED: 'La ventana de 24 h expiró. Solo podés responder dentro de la ventana activa.',
  VALIDATION_ERROR: 'El número o el texto no son válidos. Revisá los campos.',
  META_API_ERROR: 'Error al comunicarse con Meta. Intentá de nuevo.',
  // The message was already sent to Meta but failed to persist locally. Resending
  // would deliver a duplicate to the recipient — warn the user explicitly not to retry.
  INTERNAL_ERROR:
    'El mensaje se envió pero hubo un problema al registrarlo. No reenvíes; verificá en el panel.',
  NETWORK_ERROR: 'No se pudo conectar con el servidor. Verificá tu conexión.',
};

const defaultTenantId =
  process.env.NEXT_PUBLIC_DEFAULT_TENANT_ID ?? '00000000-0000-0000-0000-000000000001';

export default function DevConsolePage() {
  // --- Form state ---
  const [phone, setPhone] = useState('');
  const [profileName, setProfileName] = useState('');
  const [draft, setDraft] = useState('');

  // --- Send state (inbound simulator) ---
  const [sendStatus, setSendStatus] = useState<SendStatus>('idle');

  // --- Outbound send state ---
  const [outboundTo, setOutboundTo] = useState('');
  const [outboundText, setOutboundText] = useState('');
  const [outboundSendStatus, setOutboundSendStatus] = useState<OutboundSendStatus>('idle');
  const [outboundError, setOutboundError] = useState<string | null>(null);

  // --- Hub (right panel) state ---
  const [hub, setHub] = useState<MessageDTO[]>([]);
  const [hubLoading, setHubLoading] = useState(false);
  const [notPersisted, setNotPersisted] = useState(false);

  // --- Session bubbles (left panel) ---
  const [sessionBubbles, setSessionBubbles] = useState<SessionBubble[]>([]);

  // --- App-level state ---
  const [offline, setOffline] = useState(false);
  const [autoOn, setAutoOn] = useState(true);
  const [theme, setTheme] = useState<Theme>('light');

  // Auto-poll interval ref
  const autoIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- Poll function ---
  const poll = useCallback(async () => {
    setHubLoading(true);
    try {
      const messages = await getMessages(defaultTenantId);
      setHub(messages);
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      setHubLoading(false);
    }
  }, []);

  // --- Auto-poll setup ---
  useEffect(() => {
    if (autoOn) {
      autoIntervalRef.current = setInterval(poll, 5000);
    } else {
      if (autoIntervalRef.current !== null) {
        clearInterval(autoIntervalRef.current);
        autoIntervalRef.current = null;
      }
    }
    return () => {
      if (autoIntervalRef.current !== null) {
        clearInterval(autoIntervalRef.current);
        autoIntervalRef.current = null;
      }
    };
  }, [autoOn, poll]);

  // --- Theme toggle ---
  const handleThemeToggle = () => {
    setTheme((prev) => {
      const next = prev === 'light' ? 'kanagawa' : 'light';
      document.documentElement.dataset.theme = next === 'kanagawa' ? 'kanagawa' : '';
      return next;
    });
  };

  // --- Send flow ---
  const handleSend = async () => {
    if (offline || sendStatus !== 'idle' || draft.trim().length === 0) return;

    // Capture the draft before any state mutations so we can restore it on failure.
    const currentDraft = draft;

    // Optimistic bubble — added before the fetch, removed on failure.
    const bubbleId = `${Date.now()}-${Math.random()}`;
    const bubble: SessionBubble = {
      id: bubbleId,
      text: currentDraft,
      time: fmtTime(new Date()),
      peru: isPeru(phone),
    };
    setSessionBubbles((prev) => [...prev, bubble]);
    setSendStatus('sending');

    try {
      // Step 1: get signed payload from proxy
      const { payload, signatureHeader } = await signWebhook(
        phone || '+51999000000',
        profileName || undefined,
        currentDraft,
      );

      // Step 2: post the canonical payload string verbatim — MUST NOT re-serialize
      await postWebhook(payload, signatureHeader);

      // Both fetches succeeded — clear the draft only now.
      setDraft('');
      setOffline(false);
    } catch {
      // Remove the optimistic bubble so no false "sent" bubble is shown.
      setSessionBubbles((prev) => prev.filter((b) => b.id !== bubbleId));
      // Restore the draft so the user doesn't lose their text.
      setDraft(currentDraft);
      setOffline(true);
      setSendStatus('idle');
      return;
    }

    // Step 3: sent state for 700 ms, then idle
    setSendStatus('sent');
    setTimeout(() => {
      setSendStatus('idle');
    }, 700);

    // Step 4: poll once after send
    const currentPhone = phone || '+51999000000';
    setHubLoading(true);
    try {
      const messages = await getMessages(defaultTenantId);
      setHub(messages);
      setOffline(false);

      // Show not-persisted banner if phone is not Peru
      if (!isPeru(currentPhone)) {
        setNotPersisted(true);
        setTimeout(() => setNotPersisted(false), 4000);
      }
    } catch {
      setOffline(true);
    } finally {
      setHubLoading(false);
    }
  };

  // --- Retry (reconnect) ---
  const handleRetry = () => {
    setOffline(false);
    void poll();
  };

  // --- Auto-toggle ---
  const handleAutoToggle = () => {
    setAutoOn((prev) => !prev);
  };

  // --- Outbound send flow ---
  const handleOutboundSend = async () => {
    if (outboundSendStatus !== 'idle') return;

    setOutboundSendStatus('sending');
    setOutboundError(null);

    try {
      await sendOutbound(defaultTenantId, outboundTo, outboundText);
      setOutboundError(null);
      // Clear the text on success so the user can't accidentally resend the same
      // message (mirrors handleSend clearing the draft). Keep outboundTo for reply context.
      setOutboundText('');
      setOutboundSendStatus('sent');
      // Trigger poll immediately so the outbound card appears
      void poll();
      setTimeout(() => {
        setOutboundSendStatus('idle');
      }, 1500);
    } catch (e) {
      const code = e instanceof SendOutboundError ? e.code : 'UNKNOWN';
      setOutboundError(
        OUTBOUND_ERROR_MESSAGES[code] ?? 'Ocurrió un error inesperado. Intentá de nuevo.',
      );
      setOutboundSendStatus('idle');
    }
  };

  return (
    <div
      data-theme={theme === 'kanagawa' ? 'kanagawa' : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: 'var(--app-bg)',
        color: 'var(--fg)',
        fontFamily:
          'var(--font-geist), Geist, Geist Fallback, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
        WebkitFontSmoothing: 'antialiased',
        transition: 'background-color .25s, color .25s',
      }}
    >
      <Header
        theme={theme}
        onThemeToggle={handleThemeToggle}
        offline={offline}
        tenantId={defaultTenantId}
      />

      {offline && <OfflineBanner onRetry={handleRetry} />}

      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(380px, 1fr) minmax(440px, 1.18fr)',
          gap: 18,
          padding: 18,
        }}
      >
        <ClientSimulator
          phone={phone}
          profileName={profileName}
          draft={draft}
          sendStatus={sendStatus}
          offline={offline}
          sessionBubbles={sessionBubbles}
          onPhoneChange={setPhone}
          onProfileNameChange={setProfileName}
          onDraftChange={setDraft}
          onSend={() => void handleSend()}
        />

        <HubPanel
          messages={hub}
          loading={hubLoading}
          notPersisted={notPersisted}
          autoOn={autoOn}
          onAutoToggle={handleAutoToggle}
          onRefresh={() => void poll()}
          outboundTo={outboundTo}
          outboundText={outboundText}
          outboundSendStatus={outboundSendStatus}
          outboundError={outboundError}
          onOutboundToChange={setOutboundTo}
          onOutboundTextChange={setOutboundText}
          onOutboundSend={() => void handleOutboundSend()}
        />
      </main>
    </div>
  );
}
