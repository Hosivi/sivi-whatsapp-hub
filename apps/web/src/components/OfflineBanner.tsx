import type { FC } from 'react';

interface OfflineBannerProps {
  onRetry: () => void;
}

const OfflineBanner: FC<OfflineBannerProps> = ({ onRetry }) => {
  return (
    <div
      style={{
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 18px',
        background: 'var(--danger-bg)',
        borderBottom: '1px solid var(--danger-border)',
        color: 'var(--danger-text)',
        fontSize: 12.5,
      }}
    >
      <svg
        aria-hidden="true"
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--danger)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flex: '0 0 auto' }}
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>
        <strong style={{ fontWeight: 600 }}>Sin conexión con el backend.</strong> No se pudo
        alcanzar el servidor — verificá que esté corriendo y que CORS permita este origen. Los
        envíos están deshabilitados.
      </span>
      <div style={{ flex: 1 }} />
      <button
        type="button"
        onClick={onRetry}
        style={{
          flex: '0 0 auto',
          height: 26,
          padding: '0 11px',
          background: 'var(--card-bg)',
          border: '1px solid var(--danger-border)',
          borderRadius: 7,
          fontFamily: 'inherit',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--danger-text)',
          cursor: 'pointer',
        }}
      >
        Reintentar
      </button>
    </div>
  );
};

export default OfflineBanner;
