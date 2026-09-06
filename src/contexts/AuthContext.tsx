import { getAppBaseUrl } from '@/utils/urlUtils';
import * as Sentry from '@sentry/react';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { Profile, UserStatus, UserRole } from '@/types/user';
import { seedAdminDefaults } from '@/utils/seedAdminDefaults';
import { syncSubscriptionLicense, cacheVerifiedLicense, clearAllLicenseData, isForceLogoutCached } from '@/utils/offlineLicenseManager';
import { startLicenseScheduler, verifyLicenseForLogin, clearLoginBlock } from '@/utils/licenseScheduler';
import { logSecurityEvent, auditFireAndForget, fetchSecurityEpoch } from '@/utils/auditLog';
import {
  markSessionStart,
  clearSessionSecurityState,
  isSessionExpiredByAge,
  storeSecurityEpoch,
  hasSecurityEpochChanged,
  revokeSession,
  EPOCH_CHECK_INTERVAL_MS,
} from '@/utils/sessionSecurity';


// Simple obfuscation for cached profile data (defense-in-depth against casual tampering)
const encodeProfileCache = (profile: Profile): string => {
  try {
    return btoa(encodeURIComponent(JSON.stringify(profile)));
  } catch {
    return JSON.stringify(profile);
  }
};

const decodeProfileCache = (cached: string): Profile | null => {
  try {
    // Try obfuscated format first
    return JSON.parse(decodeURIComponent(atob(cached)));
  } catch {
    try {
      // Fallback: try plain JSON (for backward compat with existing caches)
      return JSON.parse(cached);
    } catch {
      return null;
    }
  }
};

const isDev = import.meta.env.DEV;
const devLog = (...args: any[]) => { if (isDev) console.log(...args); };


interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  adminProfileId: string | null;
  adminAuthUid: string | null;
  signUp: (
    email: string,
    password: string,
    name: string,
    role?: string,
    hotelName?: string,
    adminId?: string,
    extras?: { mobileNumber?: string; shopName?: string; address?: string; captchaToken?: string }
  ) => Promise<{ error: any; user?: any }>;
  signIn: (email: string, password: string, captchaToken?: string) => Promise<{ error: any }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

import { safeLocalStorage } from '@/utils/storageUtils';

const getInitialProfileState = (): { profile: Profile | null; adminProfileId: string | null; adminAuthUid: string | null } => {
  try {
    const keys = safeLocalStorage.getAllKeys();
    for (const key of keys) {
      if (key && key.startsWith('profile_')) {
        const cachedStr = safeLocalStorage.getItem(key);
        if (cachedStr) {
          const prof = decodeProfileCache(cachedStr);
          if (prof && prof.user_id) {
            const adminPId = prof.role === 'admin' ? prof.id : (prof.admin_id || null);
            const adminAUid = prof.role === 'admin' ? prof.user_id : (safeLocalStorage.getItem(`adminAuthUid_${prof.admin_id}`) || null);
            return { profile: prof, adminProfileId: adminPId, adminAuthUid: adminAUid };
          }
        }
      }
    }
  } catch (e) {
    console.warn('[Auth] Error restoring initial cached profile:', e);
  }
  return { profile: null, adminProfileId: null, adminAuthUid: null };
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const initialAuth = getInitialProfileState();
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(initialAuth.profile);
  const [loading, setLoading] = useState(true);
  const [adminProfileId, setAdminProfileId] = useState<string | null>(initialAuth.adminProfileId);
  const [adminAuthUid, setAdminAuthUid] = useState<string | null>(initialAuth.adminAuthUid);

  const resolveAdminIds = async (userProfile: Profile | null) => {
    if (!userProfile) return { adminProfileId: null, adminAuthUid: null };
    
    let resolvedAdminProfileId: string | null = null;
    let resolvedAdminAuthUid: string | null = null;

    if (userProfile.role === 'admin') {
      resolvedAdminProfileId = userProfile.id;
      resolvedAdminAuthUid = userProfile.user_id;
    } else {
      resolvedAdminProfileId = userProfile.admin_id || null;
      if (userProfile.admin_id) {
        try {
          const cachedAdminStr = safeLocalStorage.getItem(`adminAuthUid_${userProfile.admin_id}`);
          if (cachedAdminStr) {
            resolvedAdminAuthUid = cachedAdminStr;
          } else {
            const { data } = await supabase.from('profiles').select('user_id').eq('id', userProfile.admin_id).maybeSingle();
            if (data?.user_id) {
              resolvedAdminAuthUid = data.user_id;
              safeLocalStorage.setItem(`adminAuthUid_${userProfile.admin_id}`, data.user_id);
            }
          }
        } catch (e) {
          console.error('Failed to resolve adminAuthUid', e);
        }
      }
    }
    return { adminProfileId: resolvedAdminProfileId, adminAuthUid: resolvedAdminAuthUid };
  };

  const createBasicProfile = (user: User): Profile => {
    // SECURITY: Never trust user_metadata for role — always default to 'user'
    // The actual role is fetched from the database (profiles table)
    return {
      id: user.id,
      user_id: user.id,
      name: user.user_metadata?.name || user.email?.split('@')[0] || 'User',
      role: 'user' as UserRole,
      hotel_name: user.user_metadata?.hotel_name,
      status: 'active' as UserStatus,
      admin_id: user.user_metadata?.admin_id
    };
  };

  const fetchOrCreateProfile = async (user: User): Promise<Profile> => {
    try {
      devLog('Fetching profile for user:', user.id);

      // 1. Try to get from localStorage first (fastest & works offline)
      const cachedProfileStr = safeLocalStorage.getItem(`profile_${user.id}`);
      let cachedProfile: Profile | null = null;

      if (cachedProfileStr) {
        try {
          cachedProfile = decodeProfileCache(cachedProfileStr);
          // If we have a cached profile, we can return it immediately if we're offline
          // or we can use it as a fallback if the network request fails
          if (!navigator.onLine && cachedProfile) {
            devLog('Using cached profile (offline)');
            return cachedProfile;
          }
        } catch (e) {
          console.error('Error parsing cached profile:', e);
        }
      }

      // 2. Try to fetch existing profile from Supabase with a timeout
      const profilePromise = supabase
        .from('profiles')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Profile fetch timeout')), 5000)
      );

      let existingProfile = null;
      let fetchError = null;

      try {
        const result: any = await Promise.race([
          profilePromise,
          timeoutPromise
        ]);
        existingProfile = result.data;
        fetchError = result.error;
      } catch (e) {
        devLog('Network request failed or timed out');
        // If network fails and we have cache, RETURN CACHE
        if (cachedProfile) {
          devLog('Network failed, using cached profile');
          return cachedProfile;
        }
      }

      if (!fetchError && existingProfile) {
        devLog('Found existing profile');

        // For sub-users, fetch parent admin's hotel name if not set
        let hotelName = existingProfile.hotel_name;
        if (!hotelName && existingProfile.admin_id && existingProfile.role === 'user') {
          try {
            const { data: adminData } = await supabase
              .from('profiles')
              .select('hotel_name')
              .eq('id', existingProfile.admin_id)
              .single();
            if (adminData?.hotel_name) {
              hotelName = adminData.hotel_name;
              devLog('Inherited hotel name from admin');
            }
          } catch (e) {
            devLog('Could not fetch admin hotel name');
          }
        }

        // Load client permissions (admins fetch from their own profile, sub-users inherit from parent admin)
        let clientPermissions = undefined;
        if (existingProfile.role === 'user' && existingProfile.admin_id) {
          try {
            const { data: adminData } = await supabase
              .from('profiles')
              .select('client_permissions')
              .eq('id', existingProfile.admin_id)
              .single();
            if (adminData) {
              clientPermissions = (adminData as any).client_permissions || undefined;
            }
          } catch (e) {
            devLog('Could not fetch admin client permissions');
          }
        } else {
          clientPermissions = (existingProfile as any).client_permissions || undefined;
        }

        const profile: Profile = {
          id: existingProfile.id,
          user_id: existingProfile.user_id,
          name: existingProfile.name || 'User',
          role: existingProfile.role as UserRole,
          hotel_name: hotelName || undefined,
          status: existingProfile.status as UserStatus,
          admin_id: existingProfile.admin_id || undefined,
          client_permissions: clientPermissions
        };
        // Update cache
        safeLocalStorage.setItem(`profile_${user.id}`, encodeProfileCache(profile));
        
        // Seed default data for new admins (fire and forget)
        if (profile.role === 'admin' && profile.status === 'active') {
          seedAdminDefaults(profile.id).catch(() => {});
        }
        
        return profile;
      }

      // 3. If no profile exists in DB, try to create one
      // (Only if we are online/connected, otherwise we might just return basic profile)
      devLog('No profile found, attempting to create...');
      try {
        const profileData = {
          user_id: user.id,
          name: user.user_metadata?.name || user.email?.split('@')[0] || 'User',
          // Security: clients may never self-assign an elevated role.
          // Admin profiles are created server-side by the signup trigger only.
          role: 'user' as UserRole,
          hotel_name: user.user_metadata?.hotel_name || null,
          status: 'active' as UserStatus,
          admin_id: user.user_metadata?.admin_id || null
        };

        const createPromise = supabase
          .from('profiles')
          .insert([profileData])
          .select()
          .single();

        const createTimeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Profile creation timeout')), 3000)
        );

        const { data, error } = await Promise.race([
          createPromise,
          createTimeoutPromise
        ]) as any;

        if (!error && data) {
          devLog('Profile created successfully');
          const newProfile: Profile = {
            id: data.id,
            user_id: data.user_id,
            name: data.name,
            role: data.role as UserRole,
            hotel_name: data.hotel_name,
            status: data.status as UserStatus,
            admin_id: data.admin_id || undefined
          };
          safeLocalStorage.setItem(`profile_${user.id}`, encodeProfileCache(newProfile));
          return newProfile;
        }
      } catch (createError) {
        devLog('Profile creation failed, using basic profile');
      }

      // 4. Fallback: If everything failed (no cache, no DB, no creation), use basic metadata
      devLog('Returning basic profile from metadata');
      const basicProfile = createBasicProfile(user);
      // Even cache this basic profile so next time we load faster
      safeLocalStorage.setItem(`profile_${user.id}`, encodeProfileCache(basicProfile));
      return basicProfile;

    } catch (error) {
      devLog('Error in fetchOrCreateProfile');
      // Last resort
      return createBasicProfile(user);
    }
  };

  useEffect(() => {
    devLog('AuthProvider initializing...');

    let mounted = true;

    // Ensure loading never gets stuck for more than 3 seconds (faster failsafe)
    const failsafeTimeout = setTimeout(() => {
      if (mounted && loading) {
        devLog('Failsafe timeout - setting loading to false');
        setLoading(false);
      }
    }, 3000);

    const handleAuthStateChange = async (event: string, newSession: Session | null) => {
      devLog('Auth state changed:', event);

      if (!mounted) return;

      try {
        setSession(newSession);
        setUser(newSession?.user || null);

        if (newSession?.user) {
          devLog('User found, fetching/creating profile...');

          // Use setTimeout to avoid blocking the auth state change
          setTimeout(async () => {
            if (!mounted) return;

            try {
              const userProfile = await fetchOrCreateProfile(newSession.user);

              if (mounted) {
                const { adminProfileId: pId, adminAuthUid: aId } = await resolveAdminIds(userProfile);
                if (mounted) {
                  setAdminProfileId(pId);
                  setAdminAuthUid(aId);
                  setProfile(userProfile);
                  Sentry.setUser({
                    id: userProfile.user_id,
                    username: userProfile.name || undefined,
                    segment: userProfile.role,
                  });
                  Sentry.setTag('admin_id', pId || userProfile.id);
                  Sentry.setTag('user_role', userProfile.role);
                  devLog('Profile and Admin IDs set');
                }
              }
            } catch (profileError) {
              devLog('Profile handling error');
              if (mounted) {
                // Set a basic profile if all else fails
                const basicProfile = createBasicProfile(newSession.user);
                const { adminProfileId: pId, adminAuthUid: aId } = await resolveAdminIds(basicProfile);
                if (mounted) {
                  setAdminProfileId(pId);
                  setAdminAuthUid(aId);
                  setProfile(basicProfile);
                }
              }
            } finally {
              if (mounted) {
                setLoading(false);
                clearTimeout(failsafeTimeout);
              }
            }
          }, 50); // Reduced from 100ms
        } else {
          if (mounted) {
            setAdminProfileId(null);
            setAdminAuthUid(null);
            setProfile(null);
            setLoading(false);
            clearTimeout(failsafeTimeout);
          }
        }
      } catch (error) {
        devLog('Error in auth state change handler');
        if (mounted) {
          setAdminProfileId(null);
          setAdminAuthUid(null);
          setProfile(null);
          setLoading(false);
          clearTimeout(failsafeTimeout);
        }
      }
    };

    // Set up auth state listener
    const { data: { subscription } } = supabase.auth.onAuthStateChange(handleAuthStateChange);

    // Initialize auth state with faster timeout
    const initAuth = async () => {
      try {
        devLog('Getting initial session...');

        // Faster timeout for session fetch
        const sessionPromise = supabase.auth.getSession();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Session fetch timeout')), 15000)
        );

        const { data: { session: initialSession } } = await Promise.race([
          sessionPromise,
          timeoutPromise
        ]) as any;

        devLog('Initial session retrieved');

        if (mounted) {
          await handleAuthStateChange('INITIAL', initialSession);
        }
      } catch (error) {
        devLog('Auth initialization error');
        if (mounted) {
          setLoading(false);
          clearTimeout(failsafeTimeout);
        }
      }
    };

    // Faster initialization timeout
    const initializationTimeout = setTimeout(() => {
      if (mounted && loading) {
        devLog('Initialization timeout, proceeding without session');
        setLoading(false);
        clearTimeout(failsafeTimeout);
      }
    }, 16000);

    initAuth();

    return () => {
      mounted = false;
      subscription.unsubscribe();
      clearTimeout(initializationTimeout);
      clearTimeout(failsafeTimeout);
    };
  }, []);

  // Inactivity auto-logout for shared POS terminals (30 min)
  useEffect(() => {
    if (!user || !profile) return;
    // User requested to disable inactivity auto-logout: "keep logged in until user manual or force log out"
    // Previously we had a 30-min auto logout for sub-users here.
    return () => {};
  }, [user, profile]);

  // SECURITY: session watchdog — absolute max session age + automatic revocation
  // whenever the server-side security epoch changes (role/status/tenant change).
  useEffect(() => {
    if (!user) return;

    let cancelled = false;

    const check = async () => {
      if (cancelled || document.visibilityState === 'hidden') return;

      if (isSessionExpiredByAge()) {
        await revokeSession('absolute_session_lifetime_exceeded');
        return;
      }

      if (await hasSecurityEpochChanged()) {
        await revokeSession('role_or_permission_change');
      }
    };

    void check();
    const interval = setInterval(check, EPOCH_CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', check);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', check);
    };
  }, [user]);



  // Real-time subscription to detect pause and force logout
  useEffect(() => {
    if (!user || !profile) return;

    devLog('[AuthContext] Setting up realtime subscription for force logout...');

    // Subscribe to profile changes with a unique channel name
    const channel = supabase
      .channel(`force-logout-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles'
        },
        async (payload) => {
          const updatedProfile = payload.new as any;
          const oldProfile = payload.old as any;

          devLog('[AuthContext] Profile update received');

          // Check if this update affects the current user
          const isCurrentUser = updatedProfile.user_id === user.id;
          const isCurrentUserAdmin = profile.admin_id && updatedProfile.id === profile.admin_id;

          if (isCurrentUser || isCurrentUserAdmin) {
            devLog('[AuthContext] Relevant update detected');

            // If current user was paused/deleted, force logout
            if (isCurrentUser && (updatedProfile.status === 'paused' || updatedProfile.status === 'deleted')) {
              devLog('[AuthContext] Current user paused/deleted - forcing logout');

              // Clear cached profile
              safeLocalStorage.removeItem(`profile_${user.id}`);

              // Show toast notification
              const { toast } = await import('@/hooks/use-toast');
              toast({
                title: "Account Paused",
                description: "Your account has been paused by an administrator.",
                variant: "destructive"
              });

              // Force sign out
              await supabase.auth.signOut();
              setUser(null);
              setSession(null);
              setAdminProfileId(null);
              setAdminAuthUid(null);
              setProfile(null);
              return;
            }

            // If parent admin was paused/deleted, force logout sub-user
            if (isCurrentUserAdmin && (updatedProfile.status === 'paused' || updatedProfile.status === 'deleted')) {
              devLog('[AuthContext] Parent admin paused/deleted - forcing sub-user logout');

              // Clear cached profile
              safeLocalStorage.removeItem(`profile_${user.id}`);

              // Show toast notification
              const { toast } = await import('@/hooks/use-toast');
              toast({
                title: "Account Paused",
                description: "Account paused by Super Admin",
                variant: "destructive"
              });

              // Force sign out
              await supabase.auth.signOut();
              setUser(null);
              setSession(null);
              setAdminProfileId(null);
              setAdminAuthUid(null);
              setProfile(null);
              return;
            }

            // If user status changed to active (e.g., re-activated), update profile
            if (isCurrentUser && updatedProfile.status !== profile.status) {
              devLog('[AuthContext] User status changed, updating local profile');
              setProfile(prev => prev ? { ...prev, status: updatedProfile.status as UserStatus } : null);
            }

            // Check for force_logout flag from Super Admin subscription management
            if ((isCurrentUser || isCurrentUserAdmin) && updatedProfile.force_logout === true) {
              devLog('[AuthContext] Force logout detected via profiles table update');
              safeLocalStorage.removeItem(`profile_${user.id}`);
              clearAllLicenseData();
              // Cache force logout so it persists offline
              cacheVerifiedLicense(updatedProfile.id || profile.id, {
                status: 'locked',
                forceLogout: true,
                forceLogoutReason: updatedProfile.force_logout_reason || 'Account suspended by administrator',
              });
              const { toast } = await import('@/hooks/use-toast');
              toast({
                title: 'Account Suspended',
                description: updatedProfile.force_logout_reason || 'Your subscription has been paused by the administrator.',
                variant: 'destructive',
              });
              await supabase.auth.signOut();
              setUser(null);
              setSession(null);
              setAdminProfileId(null);
              setAdminAuthUid(null);
              setProfile(null);
              return;
            }
          }
        }
      )
      .subscribe((status) => {
        devLog('[AuthContext] Force logout subscription status:', status);
      });

    // Also subscribe to broadcast channel for instant force logout from Super Admin or Client Admin
    const adminId = adminProfileId;
    let broadcastChannel: any = null;
    let userBroadcastChannel: any = null;

    const performForceLogout = async (reason?: string) => {
      devLog('[AuthContext] Force logout broadcast received!');
      safeLocalStorage.removeItem(`profile_${user.id}`);
      clearAllLicenseData();
      if (adminId) {
        cacheVerifiedLicense(adminId, {
          status: 'locked',
          forceLogout: true,
          forceLogoutReason: reason || 'Account suspended',
        });
      }
      const { toast } = await import('@/hooks/use-toast');
      toast({
        title: 'Account Paused',
        description: reason || 'Your account access has been revoked or paused by an administrator.',
        variant: 'destructive',
      });
      await supabase.auth.signOut();
      setUser(null);
      setSession(null);
      setAdminProfileId(null);
      setAdminAuthUid(null);
      setProfile(null);
      window.location.href = '/auth';
    };

    if (adminId) {
      broadcastChannel = supabase
        .channel(`force-logout-broadcast-${adminId}`)
        .on('broadcast', { event: 'force_logout' }, (payload: any) => {
          const { force, reason } = payload.payload || {};
          if (force) performForceLogout(reason);
        })
        .subscribe();
    }

    if (user?.id) {
      userBroadcastChannel = supabase
        .channel(`force-logout-user-${user.id}`)
        .on('broadcast', { event: 'force_logout' }, (payload: any) => {
          const { force, reason } = payload.payload || {};
          if (force) performForceLogout(reason);
        })
        .subscribe();
    }

    // Weekly background license verification (resume + online + interval)
    let schedulerStop: (() => void) | null = null;
    if (adminId && profile.role !== 'super_admin') {
      const handle = startLicenseScheduler(adminId, {
        onStatus: () => {
          window.dispatchEvent(new Event('zenpos-license-changed'));
        },
        onEnforce: (status, reason) => {
          devLog('[AuthContext] License enforcement triggered:', reason);
          // Offline verification overdue → keep the session but show the
          // full-screen lockdown so staff can still read data and reconnect.
          if (status.lockReason === 'grace_expired' && !status.isForceLoggedOut) {
            window.dispatchEvent(new Event('zenpos-license-changed'));
            return;
          }
          performForceLogout(reason);
        },
      });

      schedulerStop = handle.stop;
    }

    return () => {
      devLog('[AuthContext] Cleaning up force-logout realtime subscription');
      supabase.removeChannel(channel);
      if (broadcastChannel) supabase.removeChannel(broadcastChannel);
      if (userBroadcastChannel) supabase.removeChannel(userBroadcastChannel);
      schedulerStop?.();
    };

  }, [user?.id, profile?.id, profile?.admin_id, profile?.status]);

  const signUp = async (
    email: string,
    password: string,
    name: string,
    role: string = 'user',
    hotelName?: string,
    adminId?: string,
    extras?: { mobileNumber?: string; shopName?: string; address?: string; captchaToken?: string }
  ) => {
    devLog('Sign up attempt for:', email);

    // 1. If an admin is currently logged in, try the admin_create_user RPC directly to bypass email rate limits
    if (user) {
      try {
        const { data: rpcRes, error: rpcErr } = await (supabase as any).rpc('admin_create_user', {
          p_email: email,
          p_password: password,
          p_name: name,
          p_role: role,
          p_hotel_name: hotelName || null,
          p_shop_name: extras?.shopName || null,
          p_mobile_number: extras?.mobileNumber || null,
          p_address: extras?.address || null,
          p_admin_id: adminId || null,
          p_business_type: 'restaurant'
        });

        if (!rpcErr && rpcRes?.id) {
          devLog('User created successfully via admin_create_user RPC');
          return { error: null, user: { id: rpcRes.id, email } as User };
        }
        if (rpcErr) {
          devLog('RPC admin_create_user error, trying fallback:', rpcErr.message);
          if (rpcErr.message?.includes('already exists')) {
            return { error: new Error('An account with this email already exists.'), user: null };
          }
        }
      } catch (rpcExecErr: any) {
        devLog('RPC execution error:', rpcExecErr);
      }
    }

    // 2. Standard auth.signUp fallback
    const userData: any = { name, role };
    if (hotelName && role === 'admin') userData.hotel_name = hotelName;
    if (adminId) userData.admin_id = adminId;
    if (extras?.mobileNumber) userData.mobile_number = extras.mobileNumber;
    if (extras?.shopName) userData.shop_name = extras.shopName;
    if (extras?.address) userData.address = extras.address;


    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${getAppBaseUrl()}/`,
        data: userData,
        captchaToken: extras?.captchaToken,
      }
    });

    // 3. If email rate limit error occurred, fallback to admin_create_user RPC to bypass rate limit
    if (error && (error.message?.toLowerCase().includes('rate limit') || (error as any).status === 429)) {
      devLog('Auth signUp hit rate limit, attempting RPC fallback...');
      try {
        const { data: fallbackRes, error: fallbackErr } = await (supabase as any).rpc('admin_create_user', {
          p_email: email,
          p_password: password,
          p_name: name,
          p_role: role,
          p_hotel_name: hotelName || null,
          p_shop_name: extras?.shopName || null,
          p_mobile_number: extras?.mobileNumber || null,
          p_address: extras?.address || null,
          p_admin_id: adminId || null,
          p_business_type: 'restaurant'
        });

        if (!fallbackErr && fallbackRes?.id) {
          devLog('Bypassed email rate limit via RPC successfully');
          return { error: null, user: { id: fallbackRes.id, email } as User };
        }
      } catch (e) {}
    }

    // If signup was successful and we have a user, create/update the profile record immediately
    if (!error && data?.user) {
      devLog('Auth user created, upserting complete profile record...');
      try {
        let inheritedHotelName = hotelName || null;
        if (role === 'user' && adminId && !inheritedHotelName) {
          try {
            const { data: adminProf } = await supabase
              .from('profiles')
              .select('hotel_name')
              .eq('id', adminId)
              .maybeSingle();
            if (adminProf?.hotel_name) inheritedHotelName = adminProf.hotel_name;
          } catch {}
        }

        const profileData: any = {
          user_id: data.user.id,
          email: email,
          name: name,
          role: role as UserRole,
          hotel_name: inheritedHotelName,
          status: 'active' as UserStatus,
          admin_id: adminId || null,
          mobile_number: extras?.mobileNumber || null,
          shop_name: extras?.shopName || null,
          address: extras?.address || null,
          updated_at: new Date().toISOString()
        };

        await supabase.from('profiles').upsert([profileData], { onConflict: 'user_id' });
      } catch (profileCreateError) {
        devLog('Error creating/upserting profile:', profileCreateError);
      }
    }

    devLog('Sign up result:', error ? error.message : 'Success');
    return { error, user: data?.user };
  };

  const signIn = async (email: string, password: string, captchaToken?: string) => {
    devLog('Sign in attempt');

    // Clear any cached permissions before login to ensure fresh permissions
    // This helps when admin has changed permissions for this user
    safeLocalStorage.getAllKeys().forEach(key => {
      if (key.startsWith('hotel_pos_permissions_')) {
        safeLocalStorage.removeItem(key);
      }
    });

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
      options: { captchaToken } as any,
    });

    if (error) {
      import.meta.env.DEV && console.log('Sign in error:', error.message);
      // Audit: failed login attempt (no session, logged best-effort as anonymous)
      auditFireAndForget({
        eventType: 'auth',
        action: 'login_failed',
        severity: 'warning',
        details: { email_domain: email.split('@')[1] || 'unknown', reason: error.message },
      });
      return { error };
    }


    // Check if user/admin is paused using the database function
    if (data?.user) {
      try {
        const { data: loginCheck, error: checkError } = await supabase
          .rpc('is_user_allowed_to_login', { p_user_id: data.user.id });

        if (checkError) {
          console.error('Error checking login status:', checkError);
          // Allow login if check fails to avoid blocking users
        } else if (loginCheck && loginCheck.length > 0) {
          const result = loginCheck[0];
          if (!result.allowed) {
            // User is not allowed to login - sign them out
            await supabase.auth.signOut();
            return { error: { message: result.reason || 'Account paused' } };
          }
        }
      } catch (e) {
        console.error('Error in login check:', e);
        // Allow login if check fails
      }

      // License gate — block login until an online check confirms an active subscription
      try {
        const { data: licProfile } = await supabase
          .from('profiles')
          .select('id, role, admin_id')
          .eq('user_id', data.user.id)
          .maybeSingle();

        if (licProfile && licProfile.role !== 'super_admin') {
          const licenseAdminId = licProfile.role === 'admin' ? licProfile.id : licProfile.admin_id;
          if (licenseAdminId) {
            const gate = await verifyLicenseForLogin(licenseAdminId);
            if (!gate.allowed) {
              await supabase.auth.signOut();
              return { error: { message: gate.reason || 'Subscription verification required.' } };
            }
            clearLoginBlock();
          }
        }
      } catch (e) {
        console.error('License gate error:', e);
      }



      // Update login stats (Fire and forget)
      try {
        // First get current count
        const { data: currentProfile } = await supabase
          .from('profiles')
          .select('login_count')
          .eq('user_id', data.user.id)
          .single();

        const currentCount = currentProfile?.login_count || 0;

        // Update stats
        await supabase
          .from('profiles')
          .update({
            last_login: new Date().toISOString(),
            login_count: currentCount + 1
          })
          .eq('user_id', data.user.id);
      } catch (statError) {
        console.error('Failed to update login stats:', statError);
        // Fail silently, don't block login
      }
    }

    devLog('Sign in result: Success');

    // Session hardening + audit trail
    markSessionStart();
    storeSecurityEpoch(await fetchSecurityEpoch());
    await logSecurityEvent({
      eventType: 'auth',
      action: 'login_success',
      severity: 'info',
      details: { platform: Capacitor.isNativePlatform() ? Capacitor.getPlatform() : 'web' },
    });
    // ─── NATIVE APP ACCESS GATE ──────────────────────────────────
    // Block login on Capacitor if super admin hasn't unlocked native app
    if (Capacitor.isNativePlatform()) {
      try {
        const { data: { user: authUser } } = await supabase.auth.getUser();
        if (authUser) {
          // Resolve admin auth uid: if user is admin, use own id; if sub-user, get admin's auth uid
          const { data: profileData } = await supabase
            .from('profiles')
            .select('id, role, admin_id')
            .eq('user_id', authUser.id)
            .maybeSingle();

          // Super admins always bypass the native app gate
          if (profileData?.role === 'super_admin') {
            // Allow super admin to login on native app always
          } else {
            let adminAuthUid = authUser.id;
            if (profileData?.role === 'user' && profileData?.admin_id) {
              const { data: adminProfile } = await supabase
                .from('profiles')
                .select('user_id')
                .eq('id', profileData.admin_id)
                .maybeSingle();
              if (adminProfile?.user_id) adminAuthUid = adminProfile.user_id;
            }

            const { data: settings } = await supabase
              .from('shop_settings')
              .select('native_app_unlocked')
              .eq('user_id', adminAuthUid)
              .limit(1)
              .maybeSingle();

            if (!settings?.native_app_unlocked) {
              await supabase.auth.signOut();
              return {
                error: 'Native app access is not enabled for your account. Please use the web app or contact your administrator.',
              };
            }
          }
        }
      } catch (gateErr) {
        devLog('Native app gate check failed (allowing login):', gateErr);
        // Fail-open: if the gate check itself errors, allow login
      }
    }

    return { error: null };
  };


  const signOut = async () => {
    devLog('Signing out...');

    setLoading(true);

    // Audit before the token is dropped (RLS needs the session)
    await logSecurityEvent({ eventType: 'auth', action: 'logout', severity: 'info' });
    clearSessionSecurityState();



    try {
      if (user?.id && Capacitor.isNativePlatform()) {
        await supabase
          .from('user_devices')
          .delete()
          .eq('user_id', user.id)
          .eq('platform', Capacitor.getPlatform());
      }
    } catch (e) {
      console.error('Failed to clear device tokens:', e);
    }

    // SECURITY: Clear all cached profile data from localStorage on signOut
    safeLocalStorage.getAllKeys().forEach(key => {
      if (key.startsWith('profile_') || key.startsWith('hotel_pos_permissions_')) {
        safeLocalStorage.removeItem(key);
      }
    });

    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
    setAdminProfileId(null);
    setAdminAuthUid(null);
    setProfile(null);
    Sentry.setUser(null);
    setLoading(false);
  };

  // Listen for real-time permission updates
  useEffect(() => {
    if (!profile) return;
    const targetId = profile.admin_id || profile.id;

    const channel = supabase.channel(`permissions:${targetId}`);
    
    channel.on(
      'broadcast',
      { event: 'permissions_updated' },
      (payload) => {
        if (payload.payload?.client_permissions) {
          setProfile(prev => {
            if (!prev) return prev;
            const updated = {
              ...prev,
              client_permissions: payload.payload.client_permissions
            };
            // Update cache instantly
            safeLocalStorage.setItem(`profile_${prev.user_id}`, encodeProfileCache(updated));
            return updated;
          });
        }
      }
    ).subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [profile?.id, profile?.admin_id]);

  const contextValue = {
    user,
    session,
    profile,
    loading,
    adminProfileId,
    adminAuthUid,
    signUp,
    signIn,
    signOut,
  };

  devLog('AuthProvider render - loading:', loading, 'user:', !!user, 'profile:', !!profile);

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
};
