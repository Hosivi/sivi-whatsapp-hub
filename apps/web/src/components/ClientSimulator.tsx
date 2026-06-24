import type { FC } from 'react';
import MessageComposer, { type SendStatus } from './MessageComposer';

export interface SessionBubble {
  id: string;
  text: string;
  time: string;
  peru: boolean;
}

interface ClientSimulatorProps {
  phone: string;
  profileName: string;
  draft: string;
  sendStatus: SendStatus;
  offline: boolean;
  sessionBubbles: SessionBubble[];
  onPhoneChange: (v: string) => void;
  onProfileNameChange: (v: string) => void;
  onDraftChange: (v: string) => void;
  onSend: () => void;
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', hour12: false });
}

const ClientSimulator: FC<ClientSimulatorProps> = ({
  phone,
  profileName,
  draft,
  sendStatus,
  offline,
  sessionBubbles,
  onPhoneChange,
  onProfileNameChange,
  onDraftChange,
  onSend,
}) => {
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
      {/* Section header */}
      <div
        style={{ flex: '0 0 auto', padding: '14px 16px', borderBottom: '1px solid var(--divider)' }}
      >
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
            <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
            <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
          </svg>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>
            Simulador de cliente
          </h2>
        </div>
        <p style={{ margin: '4px 0 0 24px', fontSize: 12, color: 'var(--muted)' }}>
          Enviá mensajes como si fueras un cliente de WhatsApp.
        </p>
      </div>

      {/* Form inputs (MessageComposer handles phone/name/warning rows) */}
      <MessageComposer
        phone={phone}
        profileName={profileName}
        draft={draft}
        sendStatus={sendStatus}
        offline={offline}
        onPhoneChange={onPhoneChange}
        onProfileNameChange={onProfileNameChange}
        onDraftChange={onDraftChange}
        onSend={onSend}
      />

      {/* Chat bubble zone */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: 16,
          background: 'var(--inner-bg)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {sessionBubbles.length === 0 ? (
          <div
            style={{
              margin: 'auto',
              textAlign: 'center',
              color: 'var(--faint)',
              fontSize: 12.5,
              maxWidth: 220,
            }}
          >
            <svg
              aria-hidden="true"
              width="34"
              height="34"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--faint)"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ marginBottom: 8, opacity: 0.7 }}
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <div>
              Sin mensajes en esta sesión.
              <br />
              Escribí abajo y tocá enviar.
            </div>
          </div>
        ) : (
          sessionBubbles.map((msg) => {
            const bubbleBg = msg.peru ? 'var(--bubble-bg)' : 'var(--warn-bg)';
            const bubbleBorder = msg.peru ? 'var(--bubble-border)' : 'var(--warn-border)';
            const textColor = msg.peru ? 'var(--bubble-text)' : 'var(--warn-text)';
            return (
              <div
                key={msg.id}
                style={{
                  alignSelf: 'flex-end',
                  maxWidth: '78%',
                  animation: 'bubbleIn .28s ease both',
                }}
              >
                <div
                  style={{
                    background: bubbleBg,
                    border: `1px solid ${bubbleBorder}`,
                    borderRadius: '12px 12px 4px 12px',
                    padding: '7px 11px 5px',
                    fontSize: 13.5,
                    lineHeight: 1.45,
                    color: textColor,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {msg.text}
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: 4,
                    marginTop: 3,
                    paddingRight: 2,
                  }}
                >
                  <span style={{ fontSize: 10.5, color: 'var(--bubble-time)' }}>{msg.time}</span>
                  <span style={{ display: 'inline-flex' }}>
                    {msg.peru ? (
                      <svg aria-hidden="true" width="14" height="9" viewBox="0 0 16 10" fill="none">
                        <path
                          d="M1 5l4 4 10-8"
                          stroke="var(--check)"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M5 5l4 4 10-8"
                          stroke="var(--check)"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : (
                      <svg aria-hidden="true" width="14" height="9" viewBox="0 0 16 10" fill="none">
                        <path
                          d="M1 5l4 4 10-8"
                          stroke="var(--warn-icon)"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
};

export { fmtTime };
export default ClientSimulator;
