import type { AiUsageDTO, MessageAuthor, MessageDTO } from '@/lib/api';
import type { FC } from 'react';
import { describeAuthor, formatAiUsage } from './message-meta';

interface MessageCardProps {
  message: MessageDTO;
}

interface AuthorPalette {
  cardBg: string;
  cardBorder: string;
  /** Left accent stripe; null keeps a plain card (customer messages). */
  accent: string | null;
  avatarBg: string;
  avatarFg: string;
  badgeBg: string;
  badgeFg: string;
  badgeBorder: string;
}

const AUTHOR_PALETTES: Record<MessageAuthor, AuthorPalette> = {
  customer: {
    cardBg: 'var(--card-bg)',
    cardBorder: 'var(--card-border)',
    accent: null,
    avatarBg: 'var(--avatar-bg)',
    avatarFg: 'var(--avatar-text)',
    badgeBg: 'var(--chip-bg)',
    badgeFg: 'var(--chip-text)',
    badgeBorder: 'var(--chip-border)',
  },
  ai: {
    cardBg: 'var(--ai-bg)',
    cardBorder: 'var(--ai-border)',
    accent: 'var(--ai-accent)',
    avatarBg: 'var(--ai-badge-bg)',
    avatarFg: 'var(--ai-text)',
    badgeBg: 'var(--ai-badge-bg)',
    badgeFg: 'var(--ai-text)',
    badgeBorder: 'var(--ai-border)',
  },
  operator: {
    cardBg: 'var(--card-bg)',
    cardBorder: 'var(--card-border)',
    accent: 'var(--op-accent)',
    avatarBg: 'var(--op-badge-bg)',
    avatarFg: 'var(--op-text)',
    badgeBg: 'var(--op-badge-bg)',
    badgeFg: 'var(--op-text)',
    badgeBorder: 'var(--op-border)',
  },
};

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

/** Icon that identifies the author independently of color. */
const AuthorIcon: FC<{ kind: MessageAuthor; size: number }> = ({ kind, size }) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {kind === 'ai' && (
      <>
        <path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z" />
        <path d="M20 3v4" />
        <path d="M22 5h-4" />
      </>
    )}
    {kind === 'operator' && (
      <>
        <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </>
    )}
    {kind === 'customer' && (
      <>
        <path d="M17 7 7 17" />
        <path d="M17 17H7V7" />
      </>
    )}
  </svg>
);

const usageChipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '1px 7px',
  borderRadius: 5,
  background: 'var(--ai-badge-bg)',
  border: '1px solid var(--ai-border)',
  color: 'var(--ai-text)',
  fontWeight: 500,
} as const;

/** Provider/model, tokens and latency of an AI reply. */
const AiUsageRow: FC<{ ai: AiUsageDTO }> = ({ ai }) => {
  const usage = formatAiUsage(ai);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '6px 10px',
        marginBottom: 11,
        padding: '7px 9px',
        borderRadius: 8,
        border: '1px dashed var(--ai-border)',
        fontSize: 11.5,
        lineHeight: 1.4,
        color: 'var(--fg2)',
      }}
    >
      <span
        title="Proveedor · modelo que respondió"
        style={{
          ...usageChipStyle,
          fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
        }}
      >
        {usage.model}
      </span>
      <span title="Tokens totales de la respuesta (todas las llamadas al modelo)">
        <strong style={{ color: 'var(--fg)', fontWeight: 600 }}>{usage.tokens}</strong>
        <span style={{ marginLeft: 6 }}>{usage.breakdown}</span>
      </span>
      <span title="Latencia total de la respuesta">{usage.latency}</span>
      {usage.fallbackNote !== null && (
        <span title="Modelos anteriores de la cadena que fallaron" style={usageChipStyle}>
          {usage.fallbackNote}
        </span>
      )}
      {usage.toolsNote !== null && (
        <span title="Herramientas que invocó la IA" style={usageChipStyle}>
          {usage.toolsNote}
        </span>
      )}
    </div>
  );
};

const MessageCard: FC<MessageCardProps> = ({ message }) => {
  const author = describeAuthor(message);
  const palette = AUTHOR_PALETTES[author.kind];
  const time = fmtTime(message.receivedAt);
  const ai = author.kind === 'ai' ? (message.ai ?? null) : null;

  return (
    <div
      style={{
        flex: '0 0 auto',
        background: palette.cardBg,
        borderStyle: 'solid',
        borderWidth: palette.accent ? '1px 1px 1px 4px' : 1,
        borderColor: palette.accent
          ? `${palette.cardBorder} ${palette.cardBorder} ${palette.cardBorder} ${palette.accent}`
          : palette.cardBorder,
        borderRadius: 11,
        padding: 13,
        animation: 'cardIn .9s ease both',
      }}
    >
      {/* Header row — the AUTHOR of the message (outbound name/phone are the recipient) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 9 }}>
        <div
          style={{
            flex: '0 0 auto',
            width: 34,
            height: 34,
            borderRadius: '50%',
            background: palette.avatarBg,
            color: palette.avatarFg,
            fontSize: 13,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {author.kind === 'customer' ? (
            initialsOf(message.name, message.phone)
          ) : (
            <AuthorIcon kind={author.kind} size={17} />
          )}
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
            {author.title}
          </div>
          {author.subtitle !== null && (
            <div
              style={{
                fontSize: 11.5,
                fontFamily:
                  author.kind === 'customer'
                    ? 'var(--font-geist-mono), ui-monospace, monospace'
                    : 'inherit',
                color: 'var(--muted)',
                lineHeight: 1.3,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {author.subtitle}
            </div>
          )}
        </div>
        <div style={{ flex: 1 }} />
        {/* Author badge — text + icon, never color alone */}
        <span
          title={author.hint}
          style={{
            flex: '0 0 auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: 20,
            background: palette.badgeBg,
            color: palette.badgeFg,
            border: `1px solid ${palette.badgeBorder}`,
          }}
        >
          <AuthorIcon kind={author.kind} size={11} />
          {author.badge}
        </span>
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

      {/* AI usage — only for AI replies that reported it */}
      {ai !== null && <AiUsageRow ai={ai} />}

      {/* Footer row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          paddingTop: 9,
          borderTop: `1px solid ${author.kind === 'ai' ? 'var(--ai-border)' : 'var(--divider)'}`,
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
