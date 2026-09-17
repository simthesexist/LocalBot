// Top-of-chat error banner.

import type { ErrorEvent } from '../../shared/types';

export interface ErrorBannerProps {
  variant?: 'error' | 'daemon';
  message: string;
  retryable?: boolean;
  category?: ErrorEvent['category'];
  onDismiss: () => void;
  onRetry: () => void;
  onUpdateKey: () => void;
}

export function ErrorBanner({
  variant = 'error',
  message,
  retryable,
  category,
  onDismiss,
  onRetry,
  onUpdateKey,
}: ErrorBannerProps) {
  if (variant === 'daemon') {
    return (
      <div className="banner banner-info" role="status">
        <span>{message}</span>
      </div>
    );
  }

  const showRetry = retryable === true;
  const showUpdateKey = category === 'auth';

  return (
    <div className="banner banner-error" role="alert">
      <span className="banner-message">{message}</span>
      <div className="banner-actions">
        {showUpdateKey && (
          <button type="button" className="banner-button" onClick={onUpdateKey}>
            Update key
          </button>
        )}
        {showRetry && !showUpdateKey && (
          <button type="button" className="banner-button" onClick={onRetry}>
            Retry
          </button>
        )}
        <button
          type="button"
          className="banner-dismiss"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
    </div>
  );
}
