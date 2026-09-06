
import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Navigate, useLocation, useNavigate, Link } from 'react-router-dom';
import { BottomNavigation } from './BottomNavigation';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

import { SyncStatusBar } from './SyncStatusBar';
import { OfflineLicenseBanner } from './OfflineLicenseBanner';
import OfflineStatusBanner from './OfflineStatusBanner';
import { useSwipeBack } from '@/hooks/useSwipeBack';

import { PullToRefresh } from './PullToRefresh';
import { syncSubscriptionLicense, checkOfflineLicenseStatus, clearAllLicenseData, type LicenseStatus } from '@/utils/offlineLicenseManager';
import { supabase } from '@/integrations/supabase/client';
import { Shield, LogOut, CreditCard, Bell } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface LayoutProps {
  children: React.ReactNode;
}

/** 6 hours in milliseconds — heartbeat interval for license checks */
const LICENSE_HEARTBEAT_MS = 6 * 60 * 60 * 1000;

function getRelativeExpiryString(endDateStr?: string | null, daysRemaining?: number): string {
  if (!endDateStr) {
    if (daysRemaining !== undefined && daysRemaining > 0) {
      return `Active Subscription (${daysRemaining} days remaining)`;
    }
    return 'Lifetime Access / Perpetual License';
  }
  const endDate = new Date(endDateStr);
  const now = new Date();
  const diffMs = endDate.getTime() - now.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  const absDays = Math.abs(diffDays);

  const formattedDate = endDate.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  if (diffDays >= 0) {
    if (diffDays === 0) return `Expires today (${formattedDate})`;
    if (diffDays === 1) return `Expires tomorrow (${formattedDate})`;
    if (diffDays < 30) return `Expires in ${diffDays} days (${formattedDate})`;
    if (diffDays < 365) {
      const months = Math.floor(diffDays / 30);
      return `Expires in ${months} month${months > 1 ? 's' : ''} (${formattedDate})`;
    }
    const years = (diffDays / 365).toFixed(1);
    return `Expires in ${years} year${+years > 1 ? 's' : ''} (${formattedDate})`;
  } else {
    if (absDays === 1) return `Expired 1 day ago (${formattedDate})`;
    if (absDays < 30) return `Expired ${absDays} days ago (${formattedDate})`;
    if (absDays < 365) {
      const months = Math.floor(absDays / 30);
      return `Expired ${months} month${months > 1 ? 's' : ''} ago (${formattedDate})`;
    }
    const years = Math.floor(absDays / 365);
    const remMonths = Math.floor((absDays % 365) / 30);
    const relStr = remMonths > 0 ? `${years} yr ${remMonths} mo ago` : `${years} yr${years > 1 ? 's' : ''} ago`;
    return `Expired ${relStr} (${formattedDate})`;
  }
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const { user, profile, loading, adminProfileId } = useAuth();
  const { toast } = useToast();
  const location = useLocation();
  const [licenseState, setLicenseState] = useState<LicenseStatus | null>(null);

  // Native-feel: swipe from left edge to go back
  useSwipeBack();

  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(() => {
    return localStorage.getItem('hotel_pos_sidebar_collapsed') === 'true';
  });

  // License heartbeat — checks license every 6 hours when online
  const checkLicense = useCallback(async () => {
    const adminId = profile?.role === 'admin' ? profile.id : (profile?.admin_id || adminProfileId);
    if (!adminId) return;

    if (navigator.onLine) {
      const result = await syncSubscriptionLicense(adminId);
      setLicenseState(result);
    } else {
      const result = checkOfflineLicenseStatus();
      setLicenseState(result);
    }
  }, [profile, adminProfileId]);

  useEffect(() => {
    if (!user || !profile) return;
    // Skip license check for super admins
    if (profile.role === 'super_admin') return;

    // Initial license check
    checkLicense();

    // Set up periodic heartbeat
    const heartbeat = setInterval(checkLicense, LICENSE_HEARTBEAT_MS);

    // Also check when app comes back online
    const handleOnline = () => {
      checkLicense();
    };
    window.addEventListener('online', handleOnline);

    return () => {
      clearInterval(heartbeat);
      window.removeEventListener('online', handleOnline);
    };
  }, [user?.id, profile?.id, checkLicense]);

  // Listen for Super Admin Expiry Push Reminders & trigger System / Android PWA Notifications
  useEffect(() => {
    if (!profile || !adminProfileId || profile.role === 'super_admin') return;

    // Request Notification permission if default
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    const channelName = `subscription-notifications-${adminProfileId}`;
    const pushChannel = supabase.channel(channelName);

    pushChannel
      .on('broadcast', { event: 'expiry_push_reminder' }, (payload) => {
        const { title, body, url } = payload.payload || {};
        if (!title || !body) return;

        // 1. Trigger Native System / Android PWA Status Bar Notification
        if ('serviceWorker' in navigator && Notification.permission === 'granted') {
          navigator.serviceWorker.ready.then((reg) => {
            reg.showNotification(title, {
              body,
              icon: '/brand/logo.png',
              badge: '/brand/logo.png',
              vibrate: [200, 100, 200, 100, 200],
              tag: 'zenpos-expiry-push',
              renotify: true,
              data: { url: url || '/renew' },
            } as NotificationOptions);

          }).catch(() => {
            new Notification(title, { body, icon: '/brand/logo.png' });
          });
        } else if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(title, { body, icon: '/brand/logo.png' });
        }

        // 2. High-visibility Toast Notification
        toast({
          title,
          description: body,
          variant: 'destructive',
          action: (
            <Link
              to={url || '/renew'}
              className="px-3 py-1 bg-white text-red-700 font-bold rounded-lg text-xs hover:bg-slate-100 shrink-0"
            >
              Renew Now
            </Link>
          ),
        });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(pushChannel);
    };
  }, [profile, adminProfileId, toast]);

  // Don't show navigation on auth page
  if (location.pathname === '/auth') {
    return <>{children}</>;
  }

  // Show loading only while auth is being initialized
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  // After loading is complete, check authentication
  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  if (!profile) {
    return <Navigate to="/auth" replace />;
  }

  if (profile.status !== 'active') {
    return <Navigate to="/auth" replace />;
  }

  const toggleSidebar = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    localStorage.setItem('hotel_pos_sidebar_collapsed', next ? 'true' : 'false');
  };

  // Full-screen lockout overlay when license is invalid (not for super admins)
  const showLockout = licenseState && !licenseState.isValid &&
    licenseState.degradationStage === 'locked' &&
    profile.role !== 'super_admin' &&
    location.pathname !== '/renew';

  const handleSignOut = async () => {
    clearAllLicenseData();
    await supabase.auth.signOut();
  };

  // User is properly authenticated with active profile
  return (
    <div className="h-screen h-[100dvh] bg-background flex w-full max-w-[100vw] overflow-hidden">
      <Sidebar collapsed={sidebarCollapsed} />

      <div className="flex flex-col flex-1 w-full min-w-0">
        <Header onToggleSidebar={toggleSidebar} sidebarCollapsed={sidebarCollapsed} />

        {/* Offline network status — shows when device is offline or has pending syncs */}
        <OfflineStatusBanner />

        {/* Offline SaaS License & Sync — silent when online */}
        <OfflineLicenseBanner />
        <SyncStatusBar />

        {showLockout ? (
          /* Full-screen lockout overlay */
          <main className="flex-1 relative w-full overflow-auto flex items-center justify-center p-4">
            <div className="max-w-md w-full text-center space-y-6 bg-card border rounded-2xl p-6 sm:p-8 shadow-xl">
              <div className="mx-auto w-20 h-20 rounded-full bg-red-100 dark:bg-red-950 flex items-center justify-center">
                <Shield className="w-10 h-10 text-red-500 animate-pulse" />
              </div>
              <div className="space-y-2">
                <h2 className="text-2xl font-bold text-foreground">
                  {licenseState.lockReason === 'force_logout'
                    ? 'Account Suspended'
                    : licenseState.lockReason === 'clock_tampered'
                      ? 'Clock Tampering Detected'
                      : licenseState.lockReason === 'grace_expired'
                        ? 'Offline Period Expired'

                        : 'Subscription Expired'}
                </h2>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  {licenseState.lockReason === 'force_logout'
                    ? (licenseState.forceLogoutReason || 'Your account has been suspended by the administrator.')
                    : licenseState.lockReason === 'clock_tampered'
                      ? 'System clock has been set backwards. Connect to the internet to re-verify your license.'
                      : licenseState.lockReason === 'grace_expired'
                        ? 'Your device has been offline for too long. Connect to the internet to verify your subscription.'
                        : 'Your subscription has expired. Please renew to continue using ZenPOS.'}
                </p>
              </div>

              {/* Subscription Expiration Details Card */}
              <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-2 text-xs text-left">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground font-medium">Subscription Status:</span>
                  <span className="font-bold text-red-600 dark:text-red-400 uppercase">EXPIRED</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground font-medium">Expired Date:</span>
                  <span className="font-bold text-slate-900 dark:text-slate-100">
                    {licenseState.subscriptionEndDate ? new Date(licenseState.subscriptionEndDate).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }) : 'Expired'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground font-medium">Elapsed Period:</span>
                  <span className="font-bold text-orange-600 dark:text-orange-400">
                    {getRelativeExpiryString(licenseState.subscriptionEndDate)}
                  </span>
                </div>
                {licenseState.planName && (
                  <div className="flex items-center justify-between pt-1 border-t">
                    <span className="text-muted-foreground font-medium">Registered Plan:</span>
                    <span className="font-bold text-primary capitalize">{licenseState.planName}</span>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-3">
                {profile.role === 'admin' && (
                  <Link
                    to="/renew"
                    className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-primary text-primary-foreground rounded-xl font-bold text-sm shadow-lg hover:opacity-90 transition-opacity"
                  >
                    <CreditCard className="w-4 h-4" />
                    Renew Subscription / Make Payment
                  </Link>
                )}
                <button
                  onClick={handleSignOut}
                  className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-muted text-muted-foreground rounded-xl font-medium text-sm hover:bg-muted/80 transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  Sign Out
                </button>
              </div>
            </div>
          </main>
        ) : (
          <>
            <main
              className="flex-1 relative w-full overflow-hidden"
              style={{ paddingBottom: 'max(68px, calc(58px + env(safe-area-inset-bottom, 0px)))' }}
            >
              <PullToRefresh>
                <div key={location.pathname} className="page-transition-enter">
                  {children}
                </div>
              </PullToRefresh>
            </main>

            <BottomNavigation />
          </>
        )}
      </div>
    </div>
  );
};
