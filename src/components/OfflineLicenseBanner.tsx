import React, { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { checkOfflineLicenseStatus, syncSubscriptionLicense, type LicenseStatus } from '@/utils/offlineLicenseManager';
import { AlertTriangle, Lock, ShieldCheck, Wifi, RefreshCw, CreditCard, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useNavigate, Link } from 'react-router-dom';

export const OfflineLicenseBanner: React.FC = () => {
    const { adminProfileId, profile } = useAuth();
    const [license, setLicense] = useState<LicenseStatus>(() => checkOfflineLicenseStatus());
    const [syncing, setSyncing] = useState(false);

    useEffect(() => {
        if (adminProfileId) {
            syncSubscriptionLicense(adminProfileId).then(setLicense);
        }

        const handleOnline = () => {
            if (adminProfileId) {
                setSyncing(true);
                syncSubscriptionLicense(adminProfileId).then(l => {
                    setLicense(l);
                    setSyncing(false);
                });
            }
        };

        const handleOffline = () => {
            setLicense(checkOfflineLicenseStatus());
        };

        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        // Check license status periodically (every 5 minutes)
        const interval = setInterval(() => {
            setLicense(checkOfflineLicenseStatus());
        }, 5 * 60 * 1000);

        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
            clearInterval(interval);
        };
    }, [adminProfileId]);

    const handleManualSync = async () => {
        if (!adminProfileId) return;
        setSyncing(true);
        const l = await syncSubscriptionLicense(adminProfileId);
        setLicense(l);
        setSyncing(false);
    };

    // Skip banners for super admins
    if (profile?.role === 'super_admin') return null;

    // If online and fully valid with no warnings, render no banner
    const graceDays = license.graceDays ?? 7;
    const offlineDaysLeft = license.graceDaysRemaining;
    const verificationDueSoon = license.isValid && offlineDaysLeft <= 3;
    if (!license.isOffline && license.isValid && license.degradationStage === 'full' && !verificationDueSoon) return null;


    // Force Logout Banner
    if (license.isForceLoggedOut) {
        return (
            <div className="bg-red-600 text-white px-4 py-3 shadow-lg flex flex-col md:flex-row items-center justify-between gap-3 text-sm z-50 sticky top-0">
                <div className="flex items-center gap-2.5">
                    <Shield className="w-5 h-5 shrink-0 animate-pulse" />
                    <div>
                        <span className="font-bold uppercase tracking-wider text-xs bg-red-800 px-2 py-0.5 rounded mr-2">
                            Account Suspended
                        </span>
                        <span>{license.forceLogoutReason || 'Your account has been suspended by the administrator.'}</span>
                    </div>
                </div>
            </div>
        );
    }

    // Subscription Expiry Warning (warning stage — <7 days remaining)
    if (license.degradationStage === 'warning' && license.daysUntilExpiry !== undefined) {
        return (
            <div className="bg-amber-500/20 border-b border-amber-500/30 text-amber-900 dark:text-amber-300 px-4 py-2.5 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs font-medium z-40 sticky top-0">
                <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                    <span>
                        Subscription expires in <strong>{license.daysUntilExpiry} day{license.daysUntilExpiry !== 1 ? 's' : ''}</strong>. Renew now to avoid service interruption.
                    </span>
                </div>
                {profile?.role === 'admin' && (
                    <a
                        href="/renew"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 text-white rounded-lg text-xs font-bold hover:bg-amber-700 transition-colors shrink-0"
                    >
                        <CreditCard className="w-3 h-3" />
                        Renew Now
                    </a>
                )}
            </div>
        );
    }

    // Limited mode banner (15 days past expiry — view-only, no new bills)
    if (license.degradationStage === 'limited') {
        return (
            <div className="bg-orange-600 text-white px-4 py-3 shadow-lg flex flex-col md:flex-row items-center justify-between gap-3 text-sm z-50 sticky top-0">
                <div className="flex items-center gap-2.5">
                    <AlertTriangle className="w-5 h-5 shrink-0" />
                    <div>
                        <span className="font-bold uppercase tracking-wider text-xs bg-orange-800 px-2 py-0.5 rounded mr-2">
                            Limited Mode
                        </span>
                        <span>Your subscription has expired. You can view data but cannot create new bills. Please renew your subscription.</span>
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {profile?.role === 'admin' && (
                        <Link
                            to="/renew"
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white text-orange-700 rounded-lg text-xs font-bold hover:bg-orange-50 transition-colors"
                        >
                            <CreditCard className="w-3 h-3" />
                            Renew Now
                        </Link>
                    )}
                </div>
            </div>
        );
    }

    // Lockout Mode: Grace period expired, clock tampered, or subscription inactive
    if (!license.isValid) {
        return (
            <div className="bg-red-600 text-white px-4 py-3 shadow-lg flex flex-col md:flex-row items-center justify-between gap-3 text-sm z-50 sticky top-0">
                <div className="flex items-center gap-2.5">
                    <Lock className="w-5 h-5 shrink-0 animate-bounce" />
                    <div>
                        <span className="font-bold uppercase tracking-wider text-xs bg-red-800 px-2 py-0.5 rounded mr-2">
                            License Lockout
                        </span>
                        {license.lockReason === 'clock_tampered' ? (
                            <span>System clock discrepancy detected. Please connect to internet to restore license.</span>
                        ) : license.lockReason === 'grace_expired' ? (
                            <span>7-Day Offline Grace Period Expired. Please connect to internet to verify active subscription.</span>
                        ) : license.lockReason === 'subscription_inactive' ? (
                            <span>Subscription expired. Please renew your plan to continue using ZenPOS.</span>
                        ) : (
                            <span>Subscription inactive. Connect online to renew SaaS plan.</span>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {profile?.role === 'admin' && (
                        <Link
                            to="/renew"
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white text-red-700 rounded-lg text-xs font-bold hover:bg-red-50 transition-colors"
                        >
                            <CreditCard className="w-3 h-3" />
                            Renew Now
                        </Link>
                    )}
                    <Button
                        size="sm"
                        onClick={handleManualSync}
                        disabled={syncing}
                        className="bg-white text-red-700 hover:bg-red-50 font-bold shrink-0 shadow-sm"
                    >
                        <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
                        Verify License Online
                    </Button>
                </div>
            </div>
        );
    }

    // Offline Grace Period Active (Valid offline)
    if (license.isOffline) {
        return (
            <div className="bg-amber-500/15 border-b border-amber-500/30 text-amber-900 dark:text-amber-300 px-4 py-2 flex items-center justify-between text-xs font-medium">
                <div className="flex items-center gap-2">
                    <Wifi className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                    <span>
                        Offline Mode Active — <strong>SaaS License Valid for {license.graceDaysRemaining} more days offline</strong>
                    </span>
                </div>
                <Badge variant="outline" className="border-amber-500/40 text-amber-800 dark:text-amber-300 text-[10px]">
                    Auto-syncs when reconnected
                </Badge>
            </div>
        );
    }

    return null;
};
