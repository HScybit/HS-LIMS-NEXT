import 'bootstrap/dist/css/bootstrap.min.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@/styles/design-system.scss';
import '@/styles/base.scss';
import '@/styles/custom.scss';
import '@/styles/form-controls.scss';
import '@/styles/checkbox.scss';
import '@/styles/header.scss';
import '@/styles/me-page.scss';
import NavigationGuard from '@/components/layout/NavigationGuard.jsx';

export const metadata = {
  title: { default: 'Sampleify LIMS', template: '%s | Sampleify LIMS' },
  description: 'Sampleify Laboratory Information Management System',
};

export default function RootLayout({ children }) {
  return <html lang="en"><body><div id="react-target"><NavigationGuard>{children}</NavigationGuard></div></body></html>;
}
