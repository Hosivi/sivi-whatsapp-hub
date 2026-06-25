import { isPeru } from '@/lib/phone';
import type { FC } from 'react';

export type SendStatus = 'idle' | 'sending' | 'sent';

interface MessageComposerProps {
  phone: string;
  profileName: string;
  draft: string;
  sendStatus: SendStatus;
  offline: boolean;
  onPhoneChange: (v: string) => void;
  onProfileNameChange: (v: string) => void;
  onDraftChange: (v: string) => void;
  onSend: () => void;
}

const MessageComposer: FC<MessageComposerProps> = ({
  phone,
  profileName,
  draft,
  sendStatus,
  offline,
  onPhoneChange,
  onProfileNameChange,
  onDraftChange,
  onSend,
}) => {
  const showPhoneWarn = phone.length > 0 && !isPeru(phone);
  const phoneBorder = showPhoneWarn ? 'var(--warn-input-border)' : 'var(--input-border)';
  const canSend = !offline && sendStatus === 'idle' && draft.trim().length > 0;

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && canSend) {
      onSend();
    }
  };

  return (
    <>
      {/* Phone + profile name row */}
      <div
        style={{
          flex: '0 0 auto',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
          padding: '14px 16px',
          borderBottom: '1px solid var(--divider)',
          background: 'var(--subtle-bg)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label
            htmlFor="composer-phone"
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--fg2)',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            Número del cliente{' '}
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                color: 'var(--muted)',
                background: 'var(--chip-bg)',
                border: '1px solid var(--chip-border)',
                padding: '0 5px',
                borderRadius: 5,
              }}
            >
              E.164 · Perú
            </span>
          </label>
          <input
            id="composer-phone"
            value={phone}
            onChange={(e) => onPhoneChange(e.target.value)}
            placeholder="+51 9XX XXX XXX"
            spellCheck={false}
            style={{
              height: 36,
              width: '100%',
              border: `1px solid ${phoneBorder}`,
              borderRadius: 8,
              padding: '0 11px',
              fontSize: 13,
              fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
              letterSpacing: '.01em',
              color: 'var(--fg)',
              background: 'var(--input-bg)',
              outline: 'none',
            }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label
            htmlFor="composer-profile-name"
            style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg2)' }}
          >
            Nombre del perfil{' '}
            <span style={{ color: 'var(--faint)', fontWeight: 400 }}>(opcional)</span>
          </label>
          <input
            id="composer-profile-name"
            value={profileName}
            onChange={(e) => onProfileNameChange(e.target.value)}
            placeholder="Juan Pérez"
            style={{
              height: 36,
              width: '100%',
              border: '1px solid var(--input-border)',
              borderRadius: 8,
              padding: '0 11px',
              fontSize: 13,
              fontFamily: 'inherit',
              color: 'var(--fg)',
              background: 'var(--input-bg)',
              outline: 'none',
            }}
          />
        </div>
        {/* Phone hint / advisory warning */}
        <div
          style={{
            gridColumn: '1 / -1',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11.5,
            color: showPhoneWarn ? 'var(--warn-icon)' : 'var(--muted)',
          }}
        >
          <svg
            aria-hidden="true"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flex: '0 0 auto' }}
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          {showPhoneWarn
            ? 'Número no peruano — el backend probablemente rechazará la normalización.'
            : 'Formato esperado: +519XXXXXXXX (E.164, Perú)'}
        </div>
      </div>

      {/* Non-Peru phone warning (before send) */}
      {showPhoneWarn && (
        <div
          style={{
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 9,
            padding: '9px 14px',
            background: 'var(--warn-bg)',
            borderTop: '1px solid var(--warn-border)',
            color: 'var(--warn-text)',
            fontSize: 11.5,
            lineHeight: 1.4,
          }}
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--warn-icon)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flex: '0 0 auto', marginTop: 1 }}
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>
            <strong style={{ fontWeight: 600 }}>Número no peruano.</strong>{' '}
            <code
              style={{
                fontFamily: 'var(--font-geist-mono), monospace',
                fontSize: 11,
                background: 'var(--warn-code-bg)',
                padding: '0 3px',
                borderRadius: 3,
              }}
            >
              normalizePhoneE164
            </code>{' '}
            lo rechaza en silencio — este mensaje{' '}
            <strong style={{ fontWeight: 600 }}>no se persistirá</strong> en el Hub.
          </span>
        </div>
      )}

      {/* Composer row */}
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: 12,
          borderTop: '1px solid var(--divider)',
          background: 'var(--card-bg)',
        }}
      >
        <input
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={handleKey}
          disabled={offline}
          placeholder={offline ? 'Sin conexión — backend no disponible' : 'Escribí un mensaje…'}
          style={{
            flex: 1,
            height: 38,
            border: '1px solid var(--input-border)',
            borderRadius: 9,
            padding: '0 13px',
            fontSize: 13.5,
            fontFamily: 'inherit',
            color: 'var(--fg)',
            background: offline ? 'var(--inner-bg)' : 'var(--input-bg)',
            outline: 'none',
          }}
        />

        {/* Send button — 4 states */}
        {sendStatus === 'sending' && (
          <button
            type="button"
            disabled
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              height: 38,
              padding: '0 15px',
              border: 'none',
              borderRadius: 9,
              fontFamily: 'inherit',
              fontSize: 13.5,
              fontWeight: 600,
              color: 'var(--on-green)',
              background: 'var(--green-send)',
              cursor: 'default',
              whiteSpace: 'nowrap',
            }}
          >
            <svg
              aria-hidden="true"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--on-green)"
              strokeWidth="2.2"
              strokeLinecap="round"
              style={{ animation: 'spin .8s linear infinite' }}
            >
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            Enviando…
          </button>
        )}

        {sendStatus === 'sent' && (
          <button
            type="button"
            disabled
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              height: 38,
              padding: '0 15px',
              border: 'none',
              borderRadius: 9,
              fontFamily: 'inherit',
              fontSize: 13.5,
              fontWeight: 600,
              color: 'var(--on-green)',
              background: 'var(--green-sent)',
              cursor: 'default',
              whiteSpace: 'nowrap',
            }}
          >
            <svg
              aria-hidden="true"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--on-green)"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Enviado
          </button>
        )}

        {sendStatus === 'idle' && canSend && (
          <button
            type="button"
            onClick={onSend}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              height: 38,
              padding: '0 15px',
              border: 'none',
              borderRadius: 9,
              fontFamily: 'inherit',
              fontSize: 13.5,
              fontWeight: 600,
              color: 'var(--on-green)',
              background: 'var(--green)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            <svg
              aria-hidden="true"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--on-green)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
            Enviar mensaje
          </button>
        )}

        {sendStatus === 'idle' && !canSend && (
          <button
            type="button"
            disabled
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              height: 38,
              padding: '0 15px',
              border: 'none',
              borderRadius: 9,
              fontFamily: 'inherit',
              fontSize: 13.5,
              fontWeight: 600,
              color: 'var(--faint)',
              background: 'var(--chip-bg)',
              cursor: 'not-allowed',
              whiteSpace: 'nowrap',
            }}
          >
            <svg
              aria-hidden="true"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--faint)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
            Enviar mensaje
          </button>
        )}
      </div>
    </>
  );
};

export default MessageComposer;
