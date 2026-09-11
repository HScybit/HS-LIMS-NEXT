'use client';

import { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';

export const PageHeaderContext = createContext(null);

export default function PageHeader({ children }) {
  const target = useContext(PageHeaderContext);
  return target ? createPortal(children, target) : null;
}
