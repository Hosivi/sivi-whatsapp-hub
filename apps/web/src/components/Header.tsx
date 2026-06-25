import type { FC } from 'react';

interface HeaderProps {
  theme: 'light' | 'kanagawa';
  onThemeToggle: () => void;
  offline: boolean;
  tenantId: string;
}

const Header: FC<HeaderProps> = ({ theme, onThemeToggle, offline, tenantId }) => {
  const isLight = theme === 'light';
  const shortTenant = tenantId ? `${tenantId.slice(0, 8)}…` : 'sin-tenant';

  return (
    <header
      style={{
        flex: '0 0 auto',
        height: 56,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '0 18px',
        background: 'var(--header-bg)',
        borderBottom: '1px solid var(--card-border)',
        transition: 'background-color .25s, border-color .25s',
      }}
    >
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
        <div
          style={{
            flex: '0 0 auto',
            width: 30,
            height: 30,
            borderRadius: 8,
            background: 'var(--green)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg
            aria-hidden="true"
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--on-green)"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15, minWidth: 0 }}>
          <span
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              letterSpacing: '-0.01em',
              whiteSpace: 'nowrap',
            }}
          >
            WhatsApp Inbound <span style={{ color: 'var(--faint)', fontWeight: 400 }}>·</span>{' '}
            Consola de prueba
          </span>
          <span style={{ fontSize: 11, color: 'var(--faint)', whiteSpace: 'nowrap' }}>
            Herramienta interna de verificación
          </span>
        </div>
        <span
          style={{
            flex: '0 0 auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            background: 'var(--danger)',
            color: '#fff',
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: '.06em',
            padding: '3px 8px',
            borderRadius: 6,
            textTransform: 'uppercase',
            marginLeft: 4,
          }}
        >
          <svg
            aria-hidden="true"
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#fff"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          Solo dev
        </span>
      </div>

      <div style={{ flex: 1 }} />

      {/* Theme toggle */}
      <button
        type="button"
        onClick={onThemeToggle}
        title="Cambiar tema (Claro / Kanagawa)"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          background: 'var(--card-bg)',
          border: '1px solid var(--card-border)',
          borderRadius: 8,
          cursor: 'pointer',
          color: 'var(--fg2)',
        }}
      >
        {isLight ? (
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
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        ) : (
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
            <circle cx="12" cy="12" r="4.2" />
            <path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8" />
          </svg>
        )}
      </button>

      {/* Connection status indicator */}
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          height: 32,
          padding: '0 11px',
          background: 'var(--card-bg)',
          border: '1px solid var(--card-border)',
          borderRadius: 8,
          fontSize: 12.5,
          fontWeight: 500,
          color: 'var(--fg2)',
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: offline ? 'var(--dot-off)' : 'var(--dot-on)',
          }}
        />
        {offline ? 'Sin conexión' : 'Conectado'}
      </div>

      {/* Tenant badge */}
      <div
        title={`Tenant: ${tenantId}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          height: 32,
          padding: '0 11px',
          background: 'var(--subtle-bg)',
          border: '1px solid var(--card-border)',
          borderRadius: 8,
          fontSize: 12.5,
          color: 'var(--fg2)',
          cursor: 'default',
        }}
      >
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--muted)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 21h18" />
          <path d="M5 21V7l8-4v18" />
          <path d="M19 21V11l-6-4" />
          <path d="M9 9v.01" />
          <path d="M9 12v.01" />
          <path d="M9 15v.01" />
          <path d="M9 18v.01" />
        </svg>
        <span
          style={{
            fontWeight: 500,
            color: 'var(--fg)',
            fontFamily: 'var(--font-geist-mono), monospace',
            fontSize: 11,
          }}
        >
          {shortTenant}
        </span>
      </div>
    </header>
  );
};

export default Header;
