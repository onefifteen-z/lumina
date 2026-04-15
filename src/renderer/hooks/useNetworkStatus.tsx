import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

export interface NetworkStatus {
  /** True when the browser reports no network connectivity */
  isOffline: boolean;
  /** True when the LLM service is available (online + configured) */
  isLLMAvailable: boolean;
}

const NetworkStatusContext = createContext<NetworkStatus>({
  isOffline: false,
  isLLMAvailable: false,
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

    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [checkLLM]);

  return (
    <NetworkStatusContext.Provider value={{ isOffline, isLLMAvailable }}>
      {children}
    </NetworkStatusContext.Provider>
  );
};
