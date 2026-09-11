import { redirect } from 'next/navigation';

// Until the module landing slice is delivered, the authenticated entry is the real account page.
export default function DashboardEntry() { redirect('/me'); }
