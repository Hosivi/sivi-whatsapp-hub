import type { MessageDTO } from '@/lib/api';
import type { FC } from 'react';

interface MessageCardProps {
  message: MessageDTO;
}

function initialsOf(name: string | null, phone: string): string {
  if (!name || name.trim() === '') {
    return phone.slice(-2).toUpperCase();
  }
  const words = name.trim().split(/\s+/);
  const first = words[0]?.[0] ?? '';
  const second = words[1]?.[0] ?? '';
  return (first + second).toUpperCase() || '#';
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('es-PE', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return iso;
  }
}

const MessageCard: FC<MessageCardProps> = ({ message }) => {
  const initials = initialsOf(message.name, message.phone);
  const displayName = message.name ?? message.phone;
  const time = fmtTime(message.receivedAt);

  return (
    <div
      style={{
        flex: '0 0 auto',
        background: 'var(--card-bg)',
        border: '1px solid var(--card-border)',
        borderRadius: 11,
        padding: 13,
        animation: 'cardIn .9s ease both',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 9 }}>
        <div
          style={{
            flex: '0 0 auto',
            width: 34,
            height: 34,
            borderRadius: '50%',
            background: 'var(--avatar-bg)',
            color: 'var(--avatar-text)',
            fontSize: 13,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {initials}
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              color: 'var(--fg)',
              lineHeight: 1.2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {displayName}
          </div>
          <div
            style={{
              fontSize: 11.5,
              fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
              color: 'var(--muted)',
              lineHeight: 1.3,
            }}
          >
            {message.phone}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <span
          style={{
            flex: '0 0 auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            background: 'var(--ok-bg)',
            color: 'var(--ok-text)',
            border: '1px solid var(--ok-border)',
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: 20,
          }}
        >
          <svg
            aria-hidden="true"
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--ok-text)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Persistido
        </span>
      </div>

      {/* Message text */}
      <div
        style={{
          fontSize: 13.5,
          lineHeight: 1.5,
          color: 'var(--fg)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          marginBottom: 11,
        }}
      >
        {message.text ?? ''}
      </div>

      {/* Footer row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          paddingTop: 9,
          borderTop: '1px solid var(--divider)',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            fontWeight: 500,
            color: 'var(--chip-text)',
            background: 'var(--chip-bg)',
            border: '1px solid var(--chip-border)',
            padding: '1px 7px',
            borderRadius: 5,
          }}
        >
          <svg
            aria-hidden="true"
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--muted)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 7V4h16v3" />
            <path d="M9 20h6" />
            <path d="M12 4v16" />
          </svg>
          {message.type}
        </span>
        <span
          title={message.wamid}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            maxWidth: 170,
            fontSize: 11,
            fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
            color: 'var(--faint)',
            cursor: 'help',
            overflow: 'hidden',
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {message.wamid}
          </span>
        </span>
        <div style={{ flex: 1 }} />
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            color: 'var(--faint)',
            whiteSpace: 'nowrap',
          }}
        >
          <svg
            aria-hidden="true"
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--faint)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          {time}
        </span>
      </div>
    </div>
  );
};

export default MessageCard;
