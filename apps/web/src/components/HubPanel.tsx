import type { MessageDTO } from '@/lib/api';
import { isPeru } from '@/lib/phone';
import type { FC } from 'react';
import MessageCard from './MessageCard';
import WarningBanner from './WarningBanner';

interface HubPanelProps {
  messages: MessageDTO[];
  loading: boolean;
  notPersisted: boolean;
  autoOn: boolean;
  onAutoToggle: () => void;
  onRefresh: () => void;
  // Outbound composer props
  outboundTo: string;
  outboundText: string;
  outboundSendStatus: 'idle' | 'sending' | 'sent';
  outboundError: string | null;
  onOutboundToChange: (v: string) => void;
  onOutboundTextChange: (v: string) => void;
  onOutboundSend: () => void;
}

const SkeletonCard: FC = () => (
  <div
    style={{
      flex: '0 0 auto',
      background: 'var(--card-bg)',
      border: '1px solid var(--card-border)',
      borderRadius: 11,
      padding: 13,
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 11 }}>
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: '50%',
          background:
            'linear-gradient(90deg, var(--skel-a) 0, var(--skel-b) 50%, var(--skel-a) 100%)',
          backgroundSize: '450px 100%',
          animation: 'shimmer 1.4s infinite linear',
        }}
      />
      <div
        style={{
          height: 11,
          width: '38%',
          borderRadius: 5,
          background:
            'linear-gradient(90deg, var(--skel-a) 0, var(--skel-b) 50%, var(--skel-a) 100%)',
          backgroundSize: '450px 100%',
          animation: 'shimmer 1.4s infinite linear',
        }}
      />
      <div style={{ flex: 1 }} />
      <div
        style={{
          height: 18,
          width: 70,
          borderRadius: 20,
          background:
            'linear-gradient(90deg, var(--skel-a) 0, var(--skel-b) 50%, var(--skel-a) 100%)',
          backgroundSize: '450px 100%',
          animation: 'shimmer 1.4s infinite linear',
        }}
      />
    </div>
    <div
      style={{
        height: 10,
        width: '90%',
        borderRadius: 5,
        marginBottom: 7,
        background:
          'linear-gradient(90deg, var(--skel-a) 0, var(--skel-b) 50%, var(--skel-a) 100%)',
        backgroundSize: '450px 100%',
        animation: 'shimmer 1.4s infinite linear',
      }}
    />
    <div
      style={{
        height: 10,
        width: '60%',
        borderRadius: 5,
        background:
          'linear-gradient(90deg, var(--skel-a) 0, var(--skel-b) 50%, var(--skel-a) 100%)',
        backgroundSize: '450px 100%',
        animation: 'shimmer 1.4s infinite linear',
      }}
    />
  </div>
);

const HubPanel: FC<HubPanelProps> = ({
  messages,
  loading,
  notPersisted,
  autoOn,
  onAutoToggle,
  onRefresh,
  outboundTo,
  outboundText,
  outboundSendStatus,
  outboundError,
  onOutboundToChange,
  onOutboundTextChange,
  onOutboundSend,
}) => {
  const autoTrack = autoOn ? 'var(--green)' : 'var(--toggle-off)';
  const autoKnobLeft = autoOn ? '14px' : '2px';

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--card-bg)',
        border: '1px solid var(--card-border)',
        borderRadius: 12,
        overflow: 'hidden',
        transition: 'background-color .25s, border-color .25s',
      }}
    >
      {/* Header */}
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 16px',
          borderBottom: '1px solid var(--divider)',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--fg)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            </svg>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>
              Recibido por el Hub
            </h2>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--chip-text)',
                background: 'var(--chip-bg)',
                border: '1px solid var(--chip-border)',
                padding: '1px 7px',
                borderRadius: 20,
              }}
            >
              {messages.length}
            </span>
          </div>
          <p style={{ margin: '4px 0 0 24px', fontSize: 12, color: 'var(--muted)' }}>
            Mensajes persistidos · la verdad de la base de datos.
          </p>
        </div>

        <div style={{ flex: 1 }} />

        {/* Auto-poll toggle */}
        <button
          type="button"
          onClick={onAutoToggle}
          title="Auto-actualizar por polling"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            height: 30,
            padding: '0 9px 0 11px',
            background: autoOn
              ? 'color-mix(in srgb, var(--green) 12%, transparent)'
              : 'var(--card-bg)',
            border: `1px solid ${autoOn ? 'var(--green)' : 'var(--card-border)'}`,
            borderRadius: 8,
            fontFamily: 'inherit',
            fontSize: 12,
            fontWeight: 500,
            color: autoOn ? 'var(--green)' : 'var(--fg2)',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Auto
          <span
            style={{
              width: 28,
              height: 16,
              borderRadius: 20,
              background: autoTrack,
              position: 'relative',
              transition: 'background .15s',
              flex: '0 0 auto',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 2,
                left: autoKnobLeft,
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: '#fff',
                boxShadow: '0 1px 2px rgba(0,0,0,.25)',
                transition: 'left .15s',
              }}
            />
          </span>
        </button>

        {/* Manual refresh */}
        <button
          type="button"
          onClick={onRefresh}
          title="Refrescar (polling)"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            background: 'var(--card-bg)',
            border: '1px solid var(--card-border)',
            borderRadius: 8,
            cursor: 'pointer',
            color: 'var(--fg2)',
          }}
        >
          <svg
            aria-hidden="true"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: 14,
          background: 'var(--subtle-bg)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {/* Not-persisted warning */}
        {notPersisted && <WarningBanner />}

        {/* Loading skeletons */}
        {loading && (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        )}

        {/* Empty state */}
        {!loading && messages.length === 0 && (
          <div style={{ margin: 'auto', textAlign: 'center', padding: '30px 20px', maxWidth: 280 }}>
            <div
              style={{
                width: 64,
                height: 64,
                margin: '0 auto 14px',
                borderRadius: 16,
                background: 'var(--chip-bg)',
                border: '1px solid var(--chip-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg
                aria-hidden="true"
                width="30"
                height="30"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--faint)"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M22 12h-6l-2 3h-4l-2-3H2" />
                <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
              </svg>
            </div>
            <h3 style={{ margin: '0 0 5px', fontSize: 14, fontWeight: 600, color: 'var(--fg2)' }}>
              Todavía no llegó ningún mensaje
            </h3>
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--faint)', lineHeight: 1.5 }}>
              Enviá uno desde la izquierda. Cuando el Hub lo persista, aparecerá acá.
            </p>
          </div>
        )}

        {/* Message cards */}
        {!loading && messages.map((msg) => <MessageCard key={msg.wamid} message={msg} />)}
      </div>

      {/* Outbound reply bar */}
      <div
        style={{
          flex: '0 0 auto',
          borderTop: '2px solid var(--divider)',
          padding: '14px 16px',
          background: 'var(--card-bg)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--muted)',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            marginBottom: 2,
          }}
        >
          Enviar mensaje
        </div>

        {/* To input */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <input
            type="text"
            placeholder="Destinatario (+519...)"
            value={outboundTo}
            onChange={(e) => onOutboundToChange(e.target.value)}
            style={{
              height: 32,
              padding: '0 10px',
              border: '1px solid var(--card-border)',
              borderRadius: 7,
              background: 'var(--subtle-bg)',
              color: 'var(--fg)',
              fontSize: 13,
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />
          {outboundTo.length > 0 && !isPeru(outboundTo) && (
            <p
              style={{
                margin: 0,
                fontSize: 11.5,
                color: 'var(--warning, #d97706)',
                lineHeight: 1.4,
              }}
            >
              El número no parece ser peruano (+519XXXXXXXX). El backend lo rechazará si no es
              válido.
            </p>
          )}
        </div>

        {/* Text input */}
        <input
          type="text"
          placeholder="Texto del mensaje"
          value={outboundText}
          onChange={(e) => onOutboundTextChange(e.target.value)}
          style={{
            height: 32,
            padding: '0 10px',
            border: '1px solid var(--card-border)',
            borderRadius: 7,
            background: 'var(--subtle-bg)',
            color: 'var(--fg)',
            fontSize: 13,
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />

        {/* Send button */}
        <button
          type="button"
          onClick={onOutboundSend}
          disabled={outboundSendStatus !== 'idle'}
          style={{
            height: 34,
            padding: '0 16px',
            background:
              outboundSendStatus === 'sent'
                ? 'color-mix(in srgb, var(--green) 15%, transparent)'
                : 'color-mix(in srgb, var(--blue, #3b82f6) 15%, transparent)',
            border: `1px solid ${outboundSendStatus === 'sent' ? 'var(--green)' : 'var(--blue, #3b82f6)'}`,
            borderRadius: 7,
            color: outboundSendStatus === 'sent' ? 'var(--green)' : 'var(--blue, #3b82f6)',
            fontSize: 13,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: outboundSendStatus !== 'idle' ? 'default' : 'pointer',
            opacity: outboundSendStatus !== 'idle' ? 0.7 : 1,
            transition: 'background .15s, border-color .15s, color .15s',
          }}
        >
          {outboundSendStatus === 'sending'
            ? 'Enviando…'
            : outboundSendStatus === 'sent'
              ? 'Enviado ✓'
              : 'Enviar'}
        </button>

        {/* Inline error */}
        {outboundError !== null && (
          <p
            style={{
              margin: 0,
              fontSize: 12,
              color: 'var(--error, #dc2626)',
              lineHeight: 1.4,
            }}
          >
            {outboundError}
          </p>
        )}
      </div>
    </section>
  );
};

export default HubPanel;
