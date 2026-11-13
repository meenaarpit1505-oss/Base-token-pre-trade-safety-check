-- MCP billing for check_base_token_safety.
-- Apply in the Supabase SQL editor or via the Supabase CLI.
-- The MCP process uses the service role key and calls deduct_api_key_balance.
-- It never reads the balance in application code and then writes it back.

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  active boolean not null default true,
  balance numeric(18, 8) not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint api_keys_key_unique unique (key),
  constraint api_keys_balance_nonnegative check (balance >= 0)
);

comment on table public.api_keys is
  'Prepaid keys for the Base token-safety MCP tool. balance is USD. One check costs 0.01.';
comment on column public.api_keys.key is
  'Caller secret. Do not log it. Prefer a long random value over a human password.';
comment on column public.api_keys.active is
  'Inactive keys are not debited and do not authorize a check.';
comment on column public.api_keys.balance is
  'Remaining USD balance. Decremented only by deduct_api_key_balance.';

alter table public.api_keys enable row level security;

revoke all on table public.api_keys from public, anon, authenticated;

-- One UPDATE ... WHERE balance >= cost. A second concurrent call sees the
-- reduced balance and updates zero rows, so it cannot double-spend.
create or replace function public.deduct_api_key_balance(p_key text, p_cost numeric)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer;
begin
  if p_key is null or length(btrim(p_key)) = 0 or p_cost is null or p_cost <= 0 then
    return false;
  end if;

  update public.api_keys
  set balance = balance - p_cost,
      updated_at = now()
  where key = p_key
    and active = true
    and balance >= p_cost;

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke all on function public.deduct_api_key_balance(text, numeric) from public, anon, authenticated;
grant execute on function public.deduct_api_key_balance(text, numeric) to service_role;

-- Example only. Replace the key before running. Do not commit a real secret.
-- insert into public.api_keys (key, active, balance, metadata)
-- values ('replace-with-a-long-random-secret', true, 10.00, '{"owner":"agent"}'::jsonb);
