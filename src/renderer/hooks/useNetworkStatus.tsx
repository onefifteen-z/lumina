import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

export interface NetworkStatus {
  /** True when the browser reports no network connectivity */
  isOffline: boolean;
  /** True when the LLM service is available (online + configured) */
  isLLMAvailable: boolean;
  /** Manually trigger an LLM availability re-check */
  recheckLLM: () => void;
}

const NetworkStatusContext = createContext<NetworkStatus>({
  isOffline: false,
  isLLMAvailable: false,
  recheckLLM: () => { },
});

export const useNetworkStatus = () => useContext(NetworkStatusContext);

export const NetworkStatusProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [isLLMAvailable, setIsLLMAvailable] = useState(false);

  const checkLLM = useCallback(async () => {
    try {
      const available = await window.api.isLLMAvailable();
      setIsLLMAvailable(available);
    } catch {
      setIsLLMAvailable(false);
    }
  }, []);

  useEffect(() => {
    const handleOffline = () => {
      setIsOffline(true);
      setIsLLMAvailable(false);
    };

    const handleOnline = () => {
      setIsOffline(false);
      checkLLM();
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    // Initial LLM check
    if (navigator.onLine) {
      checkLLM();
    }

    // Periodic LLM availability polling (every 30s)
    const interval = setInterval(() => {
      if (navigator.onLine) {
        checkLLM();
      }
    }, 30_000);

    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      clearInterval(interval);
    };
  }, [checkLLM]);

  return (
    <NetworkStatusContext.Provider value={{ isOffline, isLLMAvailable, recheckLLM: checkLLM }}>
      {children}
    </NetworkStatusContext.Provider>
  );
};
