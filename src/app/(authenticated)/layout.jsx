import { redirect } from 'next/navigation';
import { currentIdentity } from '@/auth/http.js';
import AppShell from '@/components/layout/AppShell.jsx';

export default async function AuthenticatedLayout({ children }) {
  const identity = await currentIdentity();
  if (!identity) redirect('/login');
  return <AppShell identity={identity}>{children}</AppShell>;
}
