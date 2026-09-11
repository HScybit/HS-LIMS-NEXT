'use client';

import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { installHistoryGuard } from '../../lib/navigation-history.js';

const NavigationGuardContext = createContext(null);

export default function NavigationGuard({ children }) {
  const guard = useRef(null);
  const navigation = useMemo(() => ({
    register(next) {
      guard.current = next;
      return () => { if (guard.current === next) guard.current = null; };
    },
    hasPending: () => Boolean(guard.current?.hasPending()),
    prepareLeave: async (action = async () => {}) => {
      if (guard.current) return guard.current.prepareLeave(action);
      await action(); return true;
    },
  }), []);
  useEffect(() => installHistoryGuard(window, navigation), [navigation]);
  return <NavigationGuardContext.Provider value={navigation}>{children}</NavigationGuardContext.Provider>;
}

export const useNavigationGuard = () => useContext(NavigationGuardContext);
