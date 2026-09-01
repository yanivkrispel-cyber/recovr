import { EmptyState } from './EmptyState';
import { Button } from './Button';

interface QueryErrorProps {
  title?: string;
  body?: string;
  retryLabel?: string;
  onRetry: () => void;
}

/**
 * The standard "we couldn't load this — try again" state (T-21). Callers pass
 * localized strings; the defaults are a Hebrew fallback.
 */
export function QueryError({
  title = 'לא הצלחנו לטעון',
  body = 'בדוק את החיבור ונסה שוב.',
  retryLabel = 'נסה שוב',
  onRetry,
}: QueryErrorProps) {
  return (
    <EmptyState
      title={title}
      body={body}
      action={
        <Button size="sm" onClick={onRetry}>
          {retryLabel}
        </Button>
      }
    />
  );
}
