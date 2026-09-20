import { redirect } from 'next/navigation';
import { currentIdentity } from '@/auth/http.js';
import Profile from '@/components/auth/Profile.jsx';

export const metadata = { title: 'My Account' };
export default async function ProfilePage() {
  const identity = await currentIdentity();
  if (!identity) redirect('/login');
  return <Profile key={`${identity.userId}:${identity.revision}`} identity={identity} />;
}
