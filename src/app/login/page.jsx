import { redirect } from 'next/navigation';
import { currentIdentity } from '@/auth/http.js';
import Login from '@/components/auth/Login.jsx';

export const metadata = { title: 'Sign in' };
export default async function LoginPage() {
  if (await currentIdentity()) redirect('/me');
  return <Login />;
}
