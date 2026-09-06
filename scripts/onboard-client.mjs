#!/usr/bin/env node
/**
 * ZenPOS — client onboarding script
 * ---------------------------------------------------------------
 * Creates a real outlet in one shot:
 *   1. Admin (owner) login  -> profiles row with role = 'admin'
 *   2. Main branch          -> branches row owned by that admin
 *   3. Staff login(s)       -> profiles rows with role = 'user', admin_id = owner profile id
 *   4. Subscription fields  -> plan / status / end date on the owner profile
 *   5. Starter categories   -> isolated to the owner
 *
 * IDENTITY CONTRACT (do not break):
 *   - tenant columns (`admin_id`) always hold the OWNER's profiles.id
 *   - auth columns (`user_id`, `created_by`) hold auth.users.id
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/onboard-client.mjs \
 *     --shop "Zen Cafe" \
 *     --owner-email owner@zencafe.in --owner-password 'Str0ng#pass' \
 *     --owner-name "Ravi" --mobile 9876543210 --address "Anna Nagar, Chennai" \
 *     --branch "Main Branch" \
 *     --staff "cashier@zencafe.in:Str0ng#pass:Cashier" \
 *     --staff "kitchen@zencafe.in:Str0ng#pass:Kitchen" \
 *     --plan pro --amount 999 --days 30 \
 *     [--dry-run]
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
  process.exit(1);
}

/* ----------------------------- arg parsing ----------------------------- */
function parseArgs(argv) {
  const out = { staff: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'dry-run') { out.dryRun = true; continue; }
    const value = argv[++i];
    if (key === 'staff') out.staff.push(value);
    else out[key] = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const required = ['shop', 'owner-email', 'owner-password'];
for (const key of required) {
  if (!args[key]) {
    console.error(`Missing required flag --${key}`);
    process.exit(1);
  }
}

const shopName = args.shop;
const ownerEmail = args['owner-email'].trim().toLowerCase();
const ownerPassword = args['owner-password'];
const ownerName = args['owner-name'] || shopName + ' Owner';
const mobile = args.mobile || null;
const address = args.address || null;
const branchName = args.branch || 'Main Branch';
const plan = args.plan || 'pro';
const amount = Number(args.amount || 999);
const days = Number(args.days || 30);
const categories = (args.categories || 'Starters,Main Course,Beverages,Desserts')
  .split(',').map((c) => c.trim()).filter(Boolean);

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const log = (...m) => console.log('•', ...m);

if (args.dryRun) {
  log('DRY RUN — nothing will be written.');
  log('Shop:', shopName, '| Owner:', ownerEmail, '| Branch:', branchName);
  log('Staff:', args.staff.length ? args.staff.map((s) => s.split(':')[0]).join(', ') : '(none)');
  log('Plan:', plan, `₹${amount}`, `${days} days`);
  process.exit(0);
}

/* --------------------------- helper functions -------------------------- */
async function findProfileByEmail(email) {
  const { data } = await supabase.from('profiles').select('*').eq('email', email).maybeSingle();
  return data || null;
}

async function createAuthUser(email, password, metadata) {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: metadata,
  });
  if (error) throw new Error(`createUser(${email}): ${error.message}`);
  return data.user;
}

async function waitForProfile(userId, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    const { data } = await supabase.from('profiles').select('*').eq('user_id', userId).maybeSingle();
    if (data) return data;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Profile row was not created for auth user ${userId}`);
}

/* ------------------------------- main ---------------------------------- */
async function main() {
  // 1. Owner ------------------------------------------------------------
  let ownerProfile = await findProfileByEmail(ownerEmail);
  if (ownerProfile) {
    log(`Owner already exists (profile ${ownerProfile.id}) — reusing.`);
  } else {
    const user = await createAuthUser(ownerEmail, ownerPassword, {
      role: 'admin',
      name: ownerName,
      hotel_name: shopName,
      shop_name: shopName,
      mobile_number: mobile,
      address,
    });
    ownerProfile = await waitForProfile(user.id);
    log(`Created owner login ${ownerEmail} (profile ${ownerProfile.id})`);
  }

  const adminProfileId = ownerProfile.id; // tenant key everywhere

  // 2. Subscription + limits on the owner profile ------------------------
  const endDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const { error: subErr } = await supabase
    .from('profiles')
    .update({
      role: 'admin',
      status: 'active',
      hotel_name: shopName,
      shop_name: shopName,
      mobile_number: mobile,
      address,
      subscription_plan: plan,
      subscription_status: 'active',
      subscription_amount: amount,
      subscription_end_date: endDate,
      force_logout: false,
      force_logout_reason: null,
      public_ordering_enabled: true,
    })
    .eq('id', adminProfileId);
  if (subErr) throw new Error(`subscription update: ${subErr.message}`);
  log(`Subscription set: ${plan} ₹${amount} until ${endDate.slice(0, 10)}`);

  // 3. Main branch -------------------------------------------------------
  const { data: existingBranch } = await supabase
    .from('branches')
    .select('id,name')
    .eq('admin_id', adminProfileId)
    .eq('is_main', true)
    .maybeSingle();

  let branchId = existingBranch?.id;
  if (branchId) {
    log(`Main branch already exists (${existingBranch.name}).`);
  } else {
    const { data: branch, error: brErr } = await supabase
      .from('branches')
      .insert({
        admin_id: adminProfileId,
        name: branchName,
        shop_name: shopName,
        address,
        contact_number: mobile,
        is_main: true,
        is_default: true,
        is_active: true,
        menu_slug: shopName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      })
      .select('id')
      .single();
    if (brErr) throw new Error(`branch insert: ${brErr.message}`);
    branchId = branch.id;
    log(`Created branch "${branchName}" (${branchId})`);
  }

  // 4. Staff logins ------------------------------------------------------
  for (const entry of args.staff) {
    const [email, password, name] = entry.split(':');
    if (!email || !password) {
      console.warn(`  skipped malformed --staff "${entry}" (expected email:password:name)`);
      continue;
    }
    const lower = email.trim().toLowerCase();
    const existing = await findProfileByEmail(lower);
    if (existing) {
      await supabase.from('profiles').update({ admin_id: adminProfileId, role: 'user', status: 'active' }).eq('id', existing.id);
      log(`Staff ${lower} already existed — linked to this outlet.`);
      continue;
    }
    const user = await createAuthUser(lower, password, {
      role: 'user',
      name: name || lower.split('@')[0],
      admin_id: adminProfileId,
      hotel_name: shopName,
      shop_name: shopName,
    });
    const staffProfile = await waitForProfile(user.id);
    // Belt and braces: the trigger already sets admin_id, re-assert it.
    await supabase.from('profiles').update({ admin_id: adminProfileId, role: 'user', status: 'active' }).eq('id', staffProfile.id);
    log(`Created staff login ${lower} (profile ${staffProfile.id})`);
  }

  // 5. Starter categories (tenant isolated) ------------------------------
  if (categories.length) {
    const { data: existingCats } = await supabase
      .from('categories')
      .select('name')
      .eq('admin_id', adminProfileId);
    const have = new Set((existingCats || []).map((c) => String(c.name).toLowerCase()));
    const rows = categories
      .filter((c) => !have.has(c.toLowerCase()))
      .map((name, i) => ({ name, admin_id: adminProfileId, display_order: i }));
    if (rows.length) {
      const { error: catErr } = await supabase.from('categories').insert(rows);
      if (catErr) console.warn(`  categories skipped: ${catErr.message}`);
      else log(`Seeded categories: ${rows.map((r) => r.name).join(', ')}`);
    }
  }

  // 6. Isolation check ---------------------------------------------------
  const { count: foreignBranches } = await supabase
    .from('branches')
    .select('id', { count: 'exact', head: true })
    .eq('admin_id', adminProfileId);

  console.log('\n✅ Outlet ready');
  console.log('   Shop            :', shopName);
  console.log('   Owner login     :', ownerEmail);
  console.log('   Owner profile id:', adminProfileId, '(this is the tenant admin_id)');
  console.log('   Branch id       :', branchId, `(branches for this outlet: ${foreignBranches})`);
  console.log('   Staff logins    :', args.staff.map((s) => s.split(':')[0]).join(', ') || '(none)');
  console.log('\n   Every bill, item, KDS order and report created by these logins is stored');
  console.log('   with admin_id =', adminProfileId, 'so no other outlet can read it.\n');
}

main().catch((err) => {
  console.error('\n❌ Onboarding failed:', err.message);
  process.exit(1);
});
