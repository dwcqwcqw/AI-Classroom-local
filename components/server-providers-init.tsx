'use client';

import { useEffect } from 'react';
import { useSettingsStore } from '@/lib/store/settings';

/**
 * Fetches server-configured providers on mount and merges into settings store.
 * Renders nothing — purely a side-effect component.
 */
export function ServerProvidersInit() {
  const fetchServerProviders = useSettingsStore((state) => state.fetchServerProviders);

  useEffect(() => {
    const refresh = () => void fetchServerProviders();
    refresh();
    window.addEventListener('openmaic:access-granted', refresh);
    return () => window.removeEventListener('openmaic:access-granted', refresh);
  }, [fetchServerProviders]);

  return null;
}
