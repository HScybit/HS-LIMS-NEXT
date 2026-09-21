'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import AppIcon from '../ui/AppIcon.jsx';
import { showToast } from '../ui/toast.jsx';
import { apiRequest, notifySessionChange } from '../../lib/api-client.js';
import { PageHeaderContext } from './PageHeader.jsx';
import { useNavigationGuard } from './NavigationGuard.jsx';
import CustomCssInjector from '../report-assets/CustomCssInjector.jsx';

// Base list routes for master/reference data: the app's own src/masters/ entities plus
// Materials, Instruments, Checklists, Workflow Master, Master Templates, Roles and Users. The
// sidebar defaults to expanded on exactly these listing pages and collapsed everywhere else
// (samples, dashboard, organization settings, detail/edit/new sub-pages, etc.).
const MASTER_LISTING_ROUTES = new Set([
  '/test_parameters', '/method_of_analysis', '/products', '/sample_categories', '/decision_rules',
  '/customer_masters', '/vendor_masters', '/service_agreements', '/material_categories',
  '/unit_management', '/lab_management', '/project_fields',
  '/materials', '/equipments', '/checklists', '/workflow_management', '/master_template_management',
  '/role_management', '/user_management',
]);

export default function AppShell({ identity, children }) {
  const router = useRouter();
  const navigationGuard = useNavigationGuard();
  const pathname = usePathname();
  const isDesigner = /^\/master_template_management\/[a-f\d-]+$/i.test(pathname);
  const isCoa = /^\/samples\/[a-f\d-]+\/coa$/i.test(pathname);
  const isRoleManagement = pathname.startsWith('/role_management') || pathname.startsWith('/administration/roles');
  const pageLabel = pathname.includes('/data_sheets/') ? 'Add Results' : pathname.includes('/test_requests/') ? 'Test Request'
    : pathname.startsWith('/samples') ? 'Samples' : pathname.startsWith('/master_template_management') ? 'Master Templates'
      : pathname === '/header_management' ? 'Headers' : pathname === '/footer_management' ? 'Footers'
        : pathname.startsWith('/watermark_report') ? 'Watermark Report'
        : pathname === '/custom_css' ? 'Custom CSS'
        : pathname.startsWith('/test_parameters') ? 'Test Parameters'
        : pathname.startsWith('/method_of_analysis') ? 'Method of Analysis'
        : pathname.startsWith('/material_categories') ? 'Material Categories'
        : pathname.startsWith('/materials') ? 'Materials'
        : pathname.startsWith('/vendor_masters') ? 'Vendors'
        : pathname.startsWith('/service_agreements') ? 'Service Agreements'
        : pathname.startsWith('/equipments') ? 'Instruments'
        : pathname.startsWith('/customer_masters') ? 'Customer Masters'
        : pathname.startsWith('/products') ? 'Products'
        : pathname.startsWith('/sample_categories') ? 'Sample Categories'
        : pathname.startsWith('/decision_rules') ? 'Decision Rules'
        : pathname.startsWith('/project_fields') ? 'Custom Fields'
        : pathname.startsWith('/bulk_uploads') ? 'Bulk Uploads'
        : pathname.startsWith('/checklists') ? 'Checklists'
        : pathname.startsWith('/workflow_management') ? 'Workflow Master'
        : isRoleManagement ? 'Role Master'
        : pathname.startsWith('/unit_management') ? 'Units'
        : pathname.startsWith('/nabl_certificates') ? 'NABL Certifications'
        : pathname.startsWith('/lab_management') ? 'Labs'
        : pathname.startsWith('/user_management') ? 'User Management'
        : pathname.startsWith('/administration/organizations') ? 'Organizations'
        : pathname.startsWith('/administration/users') ? 'Users'
        : pathname === '/organization_settings' || pathname.startsWith('/administration/') ? 'Organization Settings' : 'My Account';
  const [collapsed, setCollapsed] = useState(() => !MASTER_LISTING_ROUTES.has(pathname));
  const [collapsedForPathname, setCollapsedForPathname] = useState(pathname);
  if (pathname !== collapsedForPathname) {
    setCollapsedForPathname(pathname);
    setCollapsed(!MASTER_LISTING_ROUTES.has(pathname));
  }
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
        {/* Sidebar sections below mirror Meteor's sidebarModules.js and PERN's App.jsx navigation exactly: one
            section per module (Instrument/Service Agreements/Customer Master/Vendor Master/Inventory/LIMS), each
            with only its own dedicated record link. Neither source app puts Products/Parameters/MoA/Sample
            Categories/Decision Rules/Custom Fields/Checklists/Workflow/Templates/Organization Settings/User/Role/
            Lab/Unit Management directly in the sidebar — both reach every one of those through the Admin Hub only. */}
        {identity.masterModules?.instrument ? <section className="sidebar-section"><div className="sidebar-label"><span>Instrument</span></div><div className="d-grid gap-1"><Link href="/equipments" className={`sidebar-link btn text-start ${pathname.startsWith('/equipments') ? 'is-active' : ''}`} aria-label="Instrument Management" onClick={() => setMobileOpen(false)}><span className="smplfy-sidebar-link-icon" aria-hidden="true"><AppIcon name="activity" size={20} /></span><span className="hide-menu">Instrument Management</span></Link></div></section> : null}
        {identity.masterModules?.service_agreements ? <section className="sidebar-section"><div className="sidebar-label"><span>Service Agreements</span></div><div className="d-grid gap-1"><Link href="/service_agreements" className={`sidebar-link btn text-start ${pathname.startsWith('/service_agreements') ? 'is-active' : ''}`} aria-label="Service Agreements" onClick={() => setMobileOpen(false)}><span className="smplfy-sidebar-link-icon" aria-hidden="true"><AppIcon name="list" size={20} /></span><span className="hide-menu">Service Agreements</span></Link></div></section> : null}
        {identity.masterModules?.customer ? <section className="sidebar-section"><div className="sidebar-label"><span>Customer Master</span></div><div className="d-grid gap-1"><Link href="/customer_masters" className={`sidebar-link btn text-start ${pathname.startsWith('/customer_masters') ? 'is-active' : ''}`} aria-label="Customer Masters" onClick={() => setMobileOpen(false)}><span className="smplfy-sidebar-link-icon" aria-hidden="true"><AppIcon name="list" size={20} /></span><span className="hide-menu">Customer Masters</span></Link></div></section> : null}
        {identity.masterModules?.vendor ? <section className="sidebar-section"><div className="sidebar-label"><span>Vendor Master</span></div><div className="d-grid gap-1"><Link href="/vendor_masters" className={`sidebar-link btn text-start ${pathname.startsWith('/vendor_masters') ? 'is-active' : ''}`} aria-label="Vendors" onClick={() => setMobileOpen(false)}><span className="smplfy-sidebar-link-icon" aria-hidden="true"><AppIcon name="list" size={20} /></span><span className="hide-menu">Vendors</span></Link></div></section> : null}
        {identity.masterModules?.inventory ? <section className="sidebar-section"><div className="sidebar-label"><span>Inventory</span></div><div className="d-grid gap-1">
          <Link href="/materials" className={`sidebar-link btn text-start ${pathname.startsWith('/materials') ? 'is-active' : ''}`} aria-label="Materials" onClick={() => setMobileOpen(false)}><span className="smplfy-sidebar-link-icon" aria-hidden="true"><AppIcon name="materials" size={20} /></span><span className="hide-menu">Materials</span></Link>
          <Link href="/material_categories" className={`sidebar-link btn text-start ${pathname.startsWith('/material_categories') ? 'is-active' : ''}`} aria-label="Material Categories" onClick={() => setMobileOpen(false)}><span className="smplfy-sidebar-link-icon" aria-hidden="true"><AppIcon name="list" size={20} /></span><span className="hide-menu">Material Categories</span></Link>
        </div></section> : null}
        {identity.permissions.some((permission) => ['samples.read', 'samples.create'].includes(permission)) ? <section className="sidebar-section"><div className="sidebar-label"><span>LIMS</span></div><div className="d-grid gap-1"><Link href={identity.permissions.includes('samples.read') ? '/samples' : '/samples/new'} className={`sidebar-link btn text-start ${pathname.startsWith('/samples') ? 'is-active' : ''}`} aria-label="Samples" onClick={() => setMobileOpen(false)}><span className="smplfy-sidebar-link-icon" aria-hidden="true"><AppIcon name="fa-flask" size={20} /></span><span className="hide-menu">All Samples</span></Link></div></section> : null}
        {identity.permissions.some((permission) => ['settings.read', 'settings.manage', 'roles.read', 'roles.manage', 'users.read', 'users.manage', 'checklists.read', 'checklists.manage', 'workflows.read', 'workflows.manage', 'compliance.read', 'compliance.manage'].includes(permission)) || identity.isPlatformAdministrator ? <section className="sidebar-section"><div className="sidebar-label"><span>Administration</span></div><div className="d-grid gap-1">
          <Link href="/admin_hub" target="_blank" rel="noopener noreferrer" className="sidebar-link btn text-start" aria-label="Admin Hub" onClick={() => setMobileOpen(false)}><span className="smplfy-sidebar-link-icon" aria-hidden="true"><AppIcon name="admin-hub" size={20} /></span><span className="hide-menu">Admin Hub</span></Link>
          {identity.isPlatformAdministrator ? <Link href="/administration/organizations" className={`sidebar-link btn text-start ${pathname.startsWith('/administration/organizations') ? 'is-active' : ''}`} aria-label="Organizations" onClick={() => setMobileOpen(false)}><span className="smplfy-sidebar-link-icon" aria-hidden="true"><AppIcon name="list" size={20} /></span><span className="hide-menu">Organizations</span></Link> : null}
          {identity.isPlatformAdministrator ? <Link href="/administration/users" className={`sidebar-link btn text-start ${pathname.startsWith('/administration/users') ? 'is-active' : ''}`} aria-label="Users" onClick={() => setMobileOpen(false)}><span className="smplfy-sidebar-link-icon" aria-hidden="true"><AppIcon name="user" size={20} /></span><span className="hide-menu">Users</span></Link> : null}
        </div></section> : null}
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

  return <PageHeaderContext.Provider value={headerTarget}><div className={`lims-app ${isDesigner ? 'lims-app--template-designer is-sidebar-hidden' : ''} ${isCoa ? 'lims-app--coa-report' : ''}`}>
    <CustomCssInjector enabled={!isDesigner} organizationId={identity.organizationId} />
    {!isDesigner ? <>
      <div className={`sidebar-backdrop ${mobileOpen ? 'is-visible' : ''}`} onClick={() => setMobileOpen(false)} aria-hidden="true" />
      <div className={`sidebar-shell sidebar-shell-mobile ${mobileOpen ? 'is-open' : ''}`} inert={!mobileOpen}>{navigation(true)}</div>
      <div className={`sidebar-shell sidebar-shell-desktop ${collapsed ? 'is-collapsed' : ''} ${hoverExpanded ? 'is-hover-expanded' : ''}`}
        onMouseEnter={() => setHoverExpanded(collapsed)} onMouseLeave={() => setHoverExpanded(false)}>{navigation()}</div>
    </> : null}
    <div className="lims-main">
      <header className="global-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between gx-0">
        <div className="col header-breadcrumb-col"><div className="header-breadcrumb-shell d-flex align-items-center">
          {!isDesigner ? <div className="header-nav-toggle-wrap"><button className="header-nav-toggle btn" aria-label={mobileOpen ? 'Close navigation' : collapsed ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={mobileOpen || !collapsed}
            onClick={() => { if (window.matchMedia('(max-width: 991.98px)').matches) setMobileOpen((value) => !value); else setCollapsed((value) => !value); }}><AppIcon name={mobileOpen ? 'close' : 'menu'} /></button></div> : null}
          <div className="header-breadcrumb d-flex align-items-center"><Link href="/dashboard" className="header-home btn d-flex align-items-center" aria-label="Go to Dashboard"><AppIcon name="home" /></Link>
            <span className="smplfy-header-breadcrumb-divider">{'>'}</span><span className="smplfy-header-breadcrumb-text is-current" aria-current="page">{pageLabel}</span>
          </div>
        </div></div>
        <div className="col-auto"><div className="d-flex align-items-center gap-2"><div className="header-profile-shell" ref={menu}>
          <button type="button" className="smplfy-btn btn btn-outline-secondary btn-lg header-profile" aria-expanded={menuOpen} aria-haspopup="true" aria-label="User profile" onClick={() => setMenuOpen((value) => !value)}><AppIcon name="user" /><span className="d-none d-sm-inline">{identity.displayName}</span></button>
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
