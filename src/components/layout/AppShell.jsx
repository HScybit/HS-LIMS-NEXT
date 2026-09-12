'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import AppIcon from '../ui/AppIcon.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import { showToast } from '../ui/toast.jsx';
import { apiRequest, notifySessionChange } from '../../lib/api-client.js';
import { PageHeaderContext } from './PageHeader.jsx';
import { useNavigationGuard } from './NavigationGuard.jsx';
import CustomCssInjector from '../report-assets/CustomCssInjector.jsx';

export default function AppShell({ identity, children }) {
  const router = useRouter();
  const navigationGuard = useNavigationGuard();
  const pathname = usePathname();
  const isDesigner = /^\/master_template_management\/[a-f\d-]+$/i.test(pathname);
  const isCoa = /^\/samples\/[a-f\d-]+\/coa$/i.test(pathname);
  const pageLabel = pathname.includes('/data_sheets/') ? 'Add Results' : pathname.includes('/test_requests/') ? 'Test Request'
    : pathname.startsWith('/samples') ? 'Samples' : pathname.startsWith('/master_template_management') ? 'Master Templates'
      : pathname === '/header_management' ? 'Headers' : pathname === '/footer_management' ? 'Footers'
        : pathname.startsWith('/watermark_report') ? 'Watermark Report'
        : pathname === '/custom_css' ? 'Custom CSS'
        : pathname.startsWith('/test_parameters') ? 'Test Parameters'
        : pathname.startsWith('/method_of_analysis') ? 'Method of Analysis'
        : pathname.startsWith('/products') ? 'Products'
        : pathname === '/organization_settings' || pathname.startsWith('/administration/') ? 'Organization Settings' : 'My Account';
  const [collapsed, setCollapsed] = useState(false);
  const [hoverExpanded, setHoverExpanded] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [headerTarget, setHeaderTarget] = useState(null);
  const menu = useRef(null);

  useEffect(() => {
    let active = true;
    let pending = false;
    let refreshRequested = false;
    const controller = new AbortController();
    const expected = JSON.stringify(identity);
    async function refreshIdentity() {
      if (document.visibilityState === 'hidden') return;
      if (pending) { refreshRequested = true; return; }
      pending = true;
      try {
        const result = await apiRequest('/api/auth/session', { signal: controller.signal });
        // A different identity must discard all prior client state, including cached scientific values.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        if (active && result.identity.userId !== identity.userId) { window.location.assign('/me'); return; }
        if (active && JSON.stringify(result.identity) !== expected) router.refresh();
      } catch (error) {
        if (active && error.status === 401) { router.replace('/login'); router.refresh(); }
      } finally {
        pending = false;
        if (refreshRequested && active) { refreshRequested = false; void refreshIdentity(); }
      }
    }
    const interval = window.setInterval(refreshIdentity, 20_000);
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel('sampleify_session') : null;
    if (channel) channel.onmessage = refreshIdentity;
    document.addEventListener('visibilitychange', refreshIdentity);
    window.addEventListener('focus', refreshIdentity);
    // A tab can finish hydration after a logout broadcast or focus event.
    void refreshIdentity();
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(interval);
      channel?.close();
      document.removeEventListener('visibilitychange', refreshIdentity);
      window.removeEventListener('focus', refreshIdentity);
    };
  }, [identity, router]);

  useEffect(() => {
    function dismiss(event) {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      if (event.type === 'keydown' || !menu.current?.contains(event.target)) setMenuOpen(false);
      if (event.type === 'keydown') setMobileOpen(false);
    }
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismiss);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', dismiss); };
  }, []);

  async function logout() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await navigationGuard.prepareLeave(async () => {
        await apiRequest('/api/auth/logout', { method: 'POST', body: {} });
        notifySessionChange();
        router.replace('/login');
        router.refresh();
      });
    } catch (error) {
      if (error.status === 401) { router.replace('/login'); router.refresh(); }
      else showToast(error.message, 'error');
    } finally { setSigningOut(false); }
  }

  function navigation(mobile = false) {
    return <aside className={`lims-sidebar d-flex flex-column ${!mobile && collapsed ? 'is-collapsed' : ''}`}>
      <div className="sidebar-brand d-flex align-items-center border-bottom">
        <Link href="/dashboard" className="brand-block d-flex align-items-center" onClick={() => setMobileOpen(false)}>
          <img alt="Sampleify LIMS logo" src="/images/dcpl.png" className="brand-mark" />
          <div className="brand-copy"><div>Sampleify LIMS</div></div>
        </Link>
      </div>
      <div className="sidebar-nav flex-grow-1">
        {identity.permissions.some((permission) => ['masters.read', 'masters.manage'].includes(permission)) ? <section className="sidebar-section"><div className="sidebar-label"><span>Master Data</span></div><div className="d-grid gap-1"><Link href="/test_parameters" className={`sidebar-link btn text-start ${pathname.startsWith('/test_parameters') ? 'is-active' : ''}`} aria-label="Test Parameters" onClick={() => setMobileOpen(false)}><span className="smplfy-sidebar-link-icon" aria-hidden="true"><AppIcon name="list" size={20} /></span><span className="hide-menu">Test Parameters</span></Link><Link href="/method_of_analysis" className={`sidebar-link btn text-start ${pathname.startsWith('/method_of_analysis') ? 'is-active' : ''}`} aria-label="Method of Analysis" onClick={() => setMobileOpen(false)}><span className="smplfy-sidebar-link-icon" aria-hidden="true"><AppIcon name="list" size={20} /></span><span className="hide-menu">Method of Analysis</span></Link><Link href="/products" className={`sidebar-link btn text-start ${pathname.startsWith('/products') ? 'is-active' : ''}`} aria-label="Products" onClick={() => setMobileOpen(false)}><span className="smplfy-sidebar-link-icon" aria-hidden="true"><AppIcon name="list" size={20} /></span><span className="hide-menu">Products</span></Link></div></section> : null}
        {identity.permissions.some((permission) => ['samples.read', 'samples.create'].includes(permission)) ? <section className="sidebar-section"><div className="sidebar-label"><span>Samples</span></div><div className="d-grid gap-1"><Link href={identity.permissions.includes('samples.read') ? '/samples' : '/samples/new'} className={`sidebar-link btn text-start ${pathname.startsWith('/samples') ? 'is-active' : ''}`} aria-label="Samples" onClick={() => setMobileOpen(false)}><span className="smplfy-sidebar-link-icon" aria-hidden="true"><AppIcon name="fa-flask" size={20} /></span><span className="hide-menu">Samples</span></Link></div></section> : null}
        {identity.permissions.includes('templates.read') ? <section className="sidebar-section"><div className="sidebar-label"><span>Templates</span></div><div className="d-grid gap-1"><Link href="/master_template_management" className={`sidebar-link btn text-start ${pathname.startsWith('/master_template_management') ? 'is-active' : ''}`} aria-label="Master Templates" onClick={() => setMobileOpen(false)}><span className="smplfy-sidebar-link-icon" aria-hidden="true"><AppIcon name="file-text" size={20} /></span><span className="hide-menu">Master Templates</span></Link></div></section> : null}
        {identity.permissions.some((permission) => ['settings.read', 'settings.manage'].includes(permission)) ? <section className="sidebar-section"><div className="sidebar-label"><span>Administration</span></div><div className="d-grid gap-1"><Link href="/organization_settings" className={`sidebar-link btn text-start ${pathname === '/organization_settings' || pathname.startsWith('/administration/') ? 'is-active' : ''}`} aria-label="Organization Settings" onClick={() => setMobileOpen(false)}><span className="smplfy-sidebar-link-icon" aria-hidden="true"><AppIcon name="settings" size={20} /></span><span className="hide-menu">Organization Settings</span></Link></div></section> : null}
        <section className="sidebar-section"><div className="sidebar-label"><span>Account</span></div>
          <div className="d-grid gap-1"><Link href="/me" className={`sidebar-link btn text-start ${pathname === '/me' ? 'is-active' : ''}`} aria-label="My Profile" onClick={() => setMobileOpen(false)}>
            <span className="smplfy-sidebar-link-icon" aria-hidden="true"><AppIcon name="user" size={20} /></span><span className="hide-menu">My Profile</span>
          </Link></div>
        </section>
      </div>
      <div className="sidebar-footer"><button type="button" className="sidebar-logout-btn" aria-label="Log out" onClick={logout} disabled={signingOut}>
        <span className="sidebar-logout-btn__icon"><AppIcon name="logout" /></span><span className="sidebar-logout-btn__label hide-menu">Log out</span>
      </button></div>
    </aside>;
  }

  return <PageHeaderContext.Provider value={headerTarget}><div className={`lims-app ${isDesigner ? 'lims-app--template-designer' : ''} ${isCoa ? 'lims-app--coa-report' : ''}`}>
    <CustomCssInjector enabled={!isDesigner} organizationId={identity.organizationId} />
    <div className={`sidebar-backdrop ${mobileOpen ? 'is-visible' : ''}`} onClick={() => setMobileOpen(false)} aria-hidden="true" />
    <div className={`sidebar-shell sidebar-shell-mobile ${mobileOpen ? 'is-open' : ''}`} inert={!mobileOpen}>{navigation(true)}</div>
    <div className={`sidebar-shell sidebar-shell-desktop ${collapsed ? 'is-collapsed' : ''} ${hoverExpanded ? 'is-hover-expanded' : ''}`}
      onMouseEnter={() => setHoverExpanded(collapsed)} onMouseLeave={() => setHoverExpanded(false)}>{navigation()}</div>
    <div className="lims-main">
      <header className="global-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between gx-0">
        <div className="col header-breadcrumb-col"><div className="header-breadcrumb-shell d-flex align-items-center">
          <div className="header-nav-toggle-wrap"><button className="header-nav-toggle btn" aria-label={mobileOpen ? 'Close navigation' : collapsed ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={mobileOpen || !collapsed}
            onClick={() => { if (window.matchMedia('(max-width: 991.98px)').matches) setMobileOpen((value) => !value); else setCollapsed((value) => !value); }}><AppIcon name={mobileOpen ? 'close' : 'menu'} /></button></div>
          <div className="header-breadcrumb d-flex align-items-center"><Link href="/dashboard" className="header-home btn d-flex align-items-center" aria-label="Go to Dashboard"><AppIcon name="home" /></Link>
            <span className="smplfy-header-breadcrumb-divider">{'>'}</span><span className="smplfy-header-breadcrumb-text is-current" aria-current="page">{pageLabel}</span>
          </div>
        </div></div>
        <div className="col-auto"><div className="d-flex align-items-center gap-2"><div className="header-profile-shell" ref={menu}>
          <SecondaryButton size="large" tone="neutral" leftIcon="user" className="header-profile" aria-expanded={menuOpen} aria-haspopup="true" aria-label="User profile" onClick={() => setMenuOpen((value) => !value)}>{identity.displayName}</SecondaryButton>
          {menuOpen ? <div className="user-dropdown" role="menu">
            <div className="user-dropdown__profile"><span className="header-user-avatar header-user-avatar--lg" aria-hidden="true"><AppIcon name="user" size={18} /></span><div className="user-dropdown__info"><div className="user-dropdown__name">{identity.displayName}</div><div className="user-dropdown__role">{identity.roles.join(', ')}</div><div className="user-dropdown__username">{identity.username}</div></div></div>
            <div className="user-dropdown__divider" />
            <Link href="/me" role="menuitem" className="user-dropdown__item" onClick={() => setMenuOpen(false)}><span className="user-dropdown__item-icon"><AppIcon name="user" /></span><span><span className="user-dropdown__item-label">My Profile</span><span className="user-dropdown__item-sub">Account and security settings</span></span></Link>
            <div className="user-dropdown__divider" />
            <button type="button" role="menuitem" className="user-dropdown__item user-dropdown__item--danger" onClick={logout} disabled={signingOut}><span className="user-dropdown__item-icon"><AppIcon name="logout" /></span><span className="user-dropdown__item-label">Log out</span></button>
          </div> : null}
        </div></div></div>
      </div></div></header>
      <div className="lims-page-header-slot" ref={setHeaderTarget} />
      <div className="lims-main-content">{children}</div>
    </div>
  </div></PageHeaderContext.Provider>;
}
