import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Tiny typed `localStorage` hook. Reads once on mount, writes lazily.
 * Falls back to the initial value if storage is unavailable (SSR, private mode).
 */
export const useLocalStorage = <T>(
  key: string,
  initial: T,
  validate?: (value: unknown) => value is T,
): [T, (value: T | ((prev: T) => T)) => void] => {
  const isFirstLoad = useRef(true);
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initial;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return initial;
      const parsed: unknown = JSON.parse(raw);
      if (validate && !validate(parsed)) return initial;
      return parsed as T;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    if (isFirstLoad.current) {
      isFirstLoad.current = false;
      return;
    }
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Quota exceeded or storage disabled — silently ignore.
    }
  }, [key, value]);

  const set = useCallback((next: T | ((prev: T) => T)) => {
    setValue((prev) => (typeof next === 'function' ? (next as (p: T) => T)(prev) : next));
  }, []);

  return [value, set];
};
