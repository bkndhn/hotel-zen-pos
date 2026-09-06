import { supabase } from '@/integrations/supabase/client';

export interface LicenseStatus {
    graceDays?: number;
    isValid: boolean;
    isOffline: boolean;
    graceDaysRemaining: number;
    subscriptionStatus: 'active' | 'trialing' | 'past_due' | 'canceled' | 'grace_period' | 'locked' | 'force_logged_out';
    planName?: string;
    lockReason?: 'clock_tampered' | 'grace_expired' | 'subscription_inactive' | 'force_logout' | null;
    lastVerifiedAt: string | null;
    /** True if super admin has force-logged this client out */
    isForceLoggedOut: boolean;
    forceLogoutReason?: string;
    /** Subscription end date (ISO string) */
    subscriptionEndDate?: string;
    /** Monthly subscription amount in ₹ */
    subscriptionAmount?: number;
    /** Degradation stage: full | warning | limited | locked */
    degradationStage: 'full' | 'warning' | 'limited' | 'locked';
    /** Days until subscription expires (negative = past due) */
    daysUntilExpiry?: number;
}

const STORAGE_KEY = 'zen_pos_license_payload';
const MAX_SEEN_KEY = 'zen_pos_max_timestamp';
const FORCE_LOGOUT_KEY = 'zen_pos_force_logout';
const DEFAULT_GRACE_DAYS = 7;
const NATIVE_LICENSE_SERVER = 'com.zenpos.app.offline-license';

async function mirrorNativeLicense(): Promise<void> {
    try {
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform()) return;
        const { NativeBiometric } = await import('capacitor-native-biometric');
        await NativeBiometric.setCredentials({
            server: NATIVE_LICENSE_SERVER,
            username: localStorage.getItem(MAX_SEEN_KEY) || String(Date.now()),
            password: localStorage.getItem(STORAGE_KEY) || '',
        });
    } catch (error) {
        console.warn('[License] Native secure mirror unavailable:', error);
    }
}

/** Restore the signed-offline anchor before React/auth starts. */
export async function hydrateNativeLicenseAnchor(): Promise<void> {
    try {
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform()) return;
        const { NativeBiometric } = await import('capacitor-native-biometric');
        const stored = await NativeBiometric.getCredentials({ server: NATIVE_LICENSE_SERVER });
        const localPayload = localStorage.getItem(STORAGE_KEY);
        const localMax = Number(localStorage.getItem(MAX_SEEN_KEY) || 0);
        const secureMax = Number(stored.username || 0);
        if (!localPayload && stored.password) localStorage.setItem(STORAGE_KEY, stored.password);
        if (secureMax > localMax) localStorage.setItem(MAX_SEEN_KEY, String(secureMax));
    } catch {
        // First install or device without secure credentials.
    }
}

/** Generate lightweight checksum to detect simple localStorage tampering */
function computeChecksum(data: any): string {
    const raw = `${data.adminId}_${data.status}_${data.lastVerifiedAt}_${data.graceDays || DEFAULT_GRACE_DAYS}_${data.subscriptionEndDate || 'none'}_${data.forceLogout ? 'forced' : 'ok'}_zenpos_hmac_v2`;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
        const char = raw.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash |= 0;
    }
    return hash.toString(36);
}

/** Check system clock anti-tampering */
function verifyClockIntegrity(nowMs: number): boolean {
    try {
        const storedMax = localStorage.getItem(MAX_SEEN_KEY);
        const maxMs = storedMax ? parseInt(storedMax, 10) : 0;

        // If current time is significantly before max seen time (> 10 minutes backward shift), clock was tampered!
        if (maxMs > 0 && nowMs < maxMs - 10 * 60 * 1000) {
            return false;
        }

        // Update max seen timestamp
        if (nowMs > maxMs) {
            localStorage.setItem(MAX_SEEN_KEY, nowMs.toString());
        }
        return true;
    } catch {
        return true;
    }
}

/** Calculate degradation stage based on days past subscription end */
function getDegradationStage(daysPastEnd: number): 'full' | 'warning' | 'limited' | 'locked' {
    if (daysPastEnd <= 0) return 'full';        // Active subscription
    if (daysPastEnd <= 7) return 'warning';      // Grace period: full access + banner
    if (daysPastEnd <= 15) return 'limited';     // Can view data, no new bills
    return 'locked';                              // Read-only, export only
}

/** Save verified subscription license payload to local storage */
export function cacheVerifiedLicense(adminId: string, subscriptionData: {
    status?: string;
    planName?: string;
    endDate?: string;
    forceLogout?: boolean;
    forceLogoutReason?: string;
    subscriptionAmount?: number;
    graceDays?: number;
}): void {
    const now = new Date().toISOString();
    const payload = {
        adminId,
        status: subscriptionData.status || 'active',
        planName: subscriptionData.planName || 'Pro',
        endDate: subscriptionData.endDate || null,
        subscriptionEndDate: subscriptionData.endDate || null,
        lastVerifiedAt: now,
        // Product policy is fixed: reconnect within seven days of verification.
        graceDays: DEFAULT_GRACE_DAYS,
        forceLogout: subscriptionData.forceLogout || false,
        forceLogoutReason: subscriptionData.forceLogoutReason || null,
        subscriptionAmount: subscriptionData.subscriptionAmount || 999,
    };

    const checksum = computeChecksum(payload);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...payload, checksum }));
    localStorage.setItem(MAX_SEEN_KEY, Date.now().toString());
    void mirrorNativeLicense();

    // Also store force logout state separately for quick access
    if (subscriptionData.forceLogout) {
        localStorage.setItem(FORCE_LOGOUT_KEY, JSON.stringify({
            forced: true,
            reason: subscriptionData.forceLogoutReason || 'Account suspended',
            at: now,
        }));
    } else {
        localStorage.removeItem(FORCE_LOGOUT_KEY);
    }
}

/** Check if force logout was cached (survives even if main license is cleared) */
export function isForceLogoutCached(): { forced: boolean; reason: string } {
    try {
        const raw = localStorage.getItem(FORCE_LOGOUT_KEY);
        if (!raw) return { forced: false, reason: '' };
        const parsed = JSON.parse(raw);
        return { forced: !!parsed.forced, reason: parsed.reason || 'Account suspended' };
    } catch {
        return { forced: false, reason: '' };
    }
}

/** Clear all license data and force logout state — used when super admin lifts the ban */
export function clearForceLogout(): void {
    localStorage.removeItem(FORCE_LOGOUT_KEY);
}

/** Clear all license data for complete reset (used during sign out) */
export function clearAllLicenseData(): void {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(FORCE_LOGOUT_KEY);
    void (async () => {
        try {
            const { Capacitor } = await import('@capacitor/core');
            if (!Capacitor.isNativePlatform()) return;
            const { NativeBiometric } = await import('capacitor-native-biometric');
            await NativeBiometric.deleteCredentials({ server: NATIVE_LICENSE_SERVER });
        } catch {
            // No native secure record to clear.
        }
    })();
    // Don't clear MAX_SEEN_KEY — keep clock tamper protection
}

/** Check current offline license status */
export function checkOfflineLicenseStatus(): LicenseStatus {
    const nowMs = Date.now();

    // 0. Check force logout (highest priority — persists across sessions)
    const forceLogoutState = isForceLogoutCached();
    if (forceLogoutState.forced) {
        return {
            isValid: false,
            isOffline: !navigator.onLine,
            graceDaysRemaining: 0,
            subscriptionStatus: 'force_logged_out',
            lockReason: 'force_logout',
            lastVerifiedAt: null,
            isForceLoggedOut: true,
            forceLogoutReason: forceLogoutState.reason,
            degradationStage: 'locked',
        };
    }

    // 1. Clock tamper check
    if (!verifyClockIntegrity(nowMs)) {
        return {
            isValid: false,
            isOffline: !navigator.onLine,
            graceDaysRemaining: 0,
            subscriptionStatus: 'locked',
            lockReason: 'clock_tampered',
            lastVerifiedAt: null,
            isForceLoggedOut: false,
            degradationStage: 'locked',
        };
    }

    // 2. Read cached license payload
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
        // If no payload cached yet, allow initial grace window if offline, else prompt online verify
        return {
            isValid: navigator.onLine,
            isOffline: !navigator.onLine,
            graceDaysRemaining: DEFAULT_GRACE_DAYS,
            subscriptionStatus: navigator.onLine ? 'active' : 'grace_period',
            lockReason: navigator.onLine ? null : 'grace_expired',
            lastVerifiedAt: null,
            isForceLoggedOut: false,
            degradationStage: navigator.onLine ? 'full' : 'warning',
        };
    }

    try {
        const payload = JSON.parse(raw);
        const { checksum, ...cleanPayload } = payload;

        // Verify checksum
        if (checksum !== computeChecksum(cleanPayload)) {
            return {
                isValid: false,
                isOffline: !navigator.onLine,
                graceDaysRemaining: 0,
                subscriptionStatus: 'locked',
                lockReason: 'clock_tampered',
                lastVerifiedAt: cleanPayload.lastVerifiedAt || null,
                isForceLoggedOut: false,
                degradationStage: 'locked',
            };
        }

        // Check force logout from payload
        if (cleanPayload.forceLogout) {
            return {
                isValid: false,
                isOffline: !navigator.onLine,
                graceDaysRemaining: 0,
                subscriptionStatus: 'force_logged_out',
                lockReason: 'force_logout',
                lastVerifiedAt: cleanPayload.lastVerifiedAt,
                isForceLoggedOut: true,
                forceLogoutReason: cleanPayload.forceLogoutReason || 'Account suspended',
                degradationStage: 'locked',
            };
        }

        const lastVerifiedMs = new Date(cleanPayload.lastVerifiedAt).getTime();
        const elapsedDays = Math.floor((nowMs - lastVerifiedMs) / (1000 * 60 * 60 * 24));
        const graceDays = cleanPayload.graceDays || DEFAULT_GRACE_DAYS;
        const graceDaysRemaining = Math.max(0, graceDays - elapsedDays);

        const isOffline = !navigator.onLine;

        // Check if subscription status is active/trialing
        const isActiveStatus = cleanPayload.status === 'active' || cleanPayload.status === 'trialing' || cleanPayload.status === 'grace_period';

        // Calculate days until subscription end
        let daysUntilExpiry: number | undefined;
        let daysPastEnd = 0;
        if (cleanPayload.subscriptionEndDate) {
            const endMs = new Date(cleanPayload.subscriptionEndDate).getTime();
            daysUntilExpiry = Math.ceil((endMs - nowMs) / (1000 * 60 * 60 * 24));
            if (daysUntilExpiry < 0) {
                daysPastEnd = Math.abs(daysUntilExpiry);
            }
        }

        if (!isActiveStatus) {
            const stage = getDegradationStage(daysPastEnd || 999);
            return {
                isValid: stage === 'warning', // Warning stage still allows usage
                isOffline,
                graceDaysRemaining: 0,
                subscriptionStatus: cleanPayload.status,
                lockReason: 'subscription_inactive',
                lastVerifiedAt: cleanPayload.lastVerifiedAt,
                isForceLoggedOut: false,
                subscriptionEndDate: cleanPayload.subscriptionEndDate,
                subscriptionAmount: cleanPayload.subscriptionAmount,
                degradationStage: stage,
                daysUntilExpiry,
            };
        }

        // Hard offline expiry: more than `graceDays` (7) since the last successful
        // server verification. Applies whether or not the device *thinks* it is
        // online — only a real successful verification resets the clock.
        if (elapsedDays > graceDays) {
            return {
                isValid: false,
                isOffline,
                graceDays,
                graceDaysRemaining: 0,
                subscriptionStatus: 'locked',
                lockReason: 'grace_expired',
                lastVerifiedAt: cleanPayload.lastVerifiedAt,
                isForceLoggedOut: false,
                degradationStage: 'locked',
                daysUntilExpiry,
            };
        }


        // Determine degradation stage from subscription end date
        const stage = getDegradationStage(daysPastEnd);

        return {
            isValid: stage !== 'locked',
            isOffline,
            graceDaysRemaining,
            subscriptionStatus: cleanPayload.status,
            planName: cleanPayload.planName,
            lockReason: null,
            lastVerifiedAt: cleanPayload.lastVerifiedAt,
            isForceLoggedOut: false,
            subscriptionEndDate: cleanPayload.subscriptionEndDate,
            subscriptionAmount: cleanPayload.subscriptionAmount,
            degradationStage: stage,
            daysUntilExpiry,
        };
    } catch {
        return {
            isValid: navigator.onLine,
            isOffline: !navigator.onLine,
            graceDaysRemaining: 0,
            subscriptionStatus: 'locked',
            lockReason: 'grace_expired',
            lastVerifiedAt: null,
            isForceLoggedOut: false,
            degradationStage: navigator.onLine ? 'full' : 'locked',
        };
    }
}

/** Verify subscription status with backend API when online */
export async function syncSubscriptionLicense(adminId: string): Promise<LicenseStatus> {
    if (!navigator.onLine || !adminId) {
        return checkOfflineLicenseStatus();
    }

    try {
        // Fetch subscription data + force_logout status from profiles
        const { data: profileData, error: profileError } = await (supabase as any)
            .from('profiles')
            .select('subscription_plan, subscription_status, subscription_end_date, subscription_amount, force_logout, force_logout_reason, client_permissions')
            .eq('id', adminId)
            .maybeSingle();
            
        if (profileError) throw profileError;

        // Subscription data lives on profiles (no separate subscriptions table)
        const status = profileData?.subscription_status || 'active';
        const planName = profileData?.subscription_plan || 'Pro';
        const endDate = profileData?.subscription_end_date || null;
        const forceLogout = profileData?.force_logout || false;
        const forceLogoutReason = profileData?.force_logout_reason || null;
        const subscriptionAmount = profileData?.subscription_amount || 999;

        cacheVerifiedLicense(adminId, {
            status,
            planName,
            endDate,
            forceLogout,
            forceLogoutReason,
            subscriptionAmount,
            graceDays: DEFAULT_GRACE_DAYS,
        });

        return checkOfflineLicenseStatus();
    } catch (e) {
        console.warn('Could not sync online license, checking cached offline status:', e);
        return checkOfflineLicenseStatus();
    }
}

