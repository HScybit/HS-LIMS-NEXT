import React from 'react';

export const AppLoader = ({ message = 'Loading…', fullPage = false }) => {
  const content = (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 16,
      padding: 48,
      fontFamily: 'Inter, sans-serif',
    }}>
      <div style={{ position: 'relative', width: 40, height: 40 }}>
        <svg
          viewBox="0 0 40 40"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{ width: 40, height: 40, animation: 'apploader-spin 0.9s linear infinite' }}
        >
          <circle
            cx="20" cy="20" r="16"
            stroke="var(--border-card, #e6e8eb)"
            strokeWidth="3"
          />
          <path
            d="M20 4 a16 16 0 0 1 16 16"
            stroke="var(--brand-blue, #1379f0)"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
        <style>{`
          @keyframes apploader-spin {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
          }
        `}</style>
      </div>

      <span style={{
        fontSize: 13,
        fontWeight: 500,
        color: 'var(--text-tertiary, #6d737e)',
        letterSpacing: '0.01em',
      }}>
        {message}
      </span>
    </div>
  );

  if (fullPage) {
    return (
      <div style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--page-bg, #f5f6f7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
      }}>
        {content}
      </div>
    );
  }

  return content;
};
