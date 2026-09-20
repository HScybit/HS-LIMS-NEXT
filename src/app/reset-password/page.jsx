import ResetPassword from '@/components/auth/ResetPassword.jsx';

export const metadata = { title: 'Reset password' };
export default async function ResetPasswordPage({ searchParams }) {
  const { token } = await searchParams;
  return <ResetPassword token={typeof token === 'string' ? token : ''} />;
}
