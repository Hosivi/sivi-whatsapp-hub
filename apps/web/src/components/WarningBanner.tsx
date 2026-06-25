import type { FC } from 'react';

const WarningBanner: FC = () => {
  return (
    <div
      style={{
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '9px 12px',
        background: 'var(--warn-bg)',
        border: '1px solid var(--warn-border)',
        borderRadius: 9,
        color: 'var(--warn-text)',
        fontSize: 12,
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
        El último envío <strong style={{ fontWeight: 600 }}>no se persistió</strong> — el número no
        es peruano válido y fue rechazado por{' '}
        <code
          style={{
            fontFamily: 'var(--font-geist-mono), monospace',
            fontSize: 11,
          }}
        >
          normalizePhoneE164
        </code>
        .
      </span>
    </div>
  );
};

export default WarningBanner;
