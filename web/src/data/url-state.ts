import { useCallback, useState } from "react";

/**
 * A value kept in the page's query string, so a copied link opens the page as
 * it was left (a filter, a search, the open test). Changes replace the current
 * history entry rather than adding one, so Back still leaves the page.
 */
export function useSearchParam(name: string): [string | null, (value: string | null) => void] {
  const [value, setValue] = useState(() => new URLSearchParams(window.location.search).get(name));
  const update = useCallback(
    (next: string | null) => {
      setValue(next);
      const url = new URL(window.location.href);
      if (next) url.searchParams.set(name, next);
      else url.searchParams.delete(name);
      window.history.replaceState(window.history.state, "", url);
    },
    [name],
  );
  return [value, update];
}
